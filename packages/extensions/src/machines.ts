/**
 * Machines: state machines defined as data, run by a host interpreter
 * outside any turn (`@gent/machines`).
 *
 * A definition names thread roles and states. A `thread` state sends a round
 * to a role's thread through the `Threads` service with `notify: "none"`, so
 * a round's end moves the run and wakes nobody; its `thread.reply` value
 * names the next state. A `run` state spawns a command in the run's cwd. An
 * `ask` state asks the owner and waits for `machine.answer`. An `integrate`
 * state pushes the run's head through the `Integration` gate of
 * `@gent/integration` and moves by the CI verdict for that push. A `final`
 * state ends the run. `machine.define` writes a definition to
 * `.gent/machines/<name>.json`; `machine.start` snapshots it into a run.
 *
 * A run is one row in `machine_runs` and an append-only log in
 * `machine_steps`. Every write compares and sets the row's `seq`, and a step
 * records the action it dispatches before it dispatches it, so recovery
 * reads that action's receipt and never repeats an ambiguous effect: a
 * round is sent again under the same key (the same round), and a command a
 * crash cut short becomes an `interrupted` ask.
 *
 * One driver fiber per run, in the host branch's `MachineDrivers`, moves the
 * run. Core's durable wake record `machine-run:<run>` (no time) stays while
 * the run is active, so each server start activates the host of each active
 * run, and an answer or a stop from any session kicks it with `at: now`
 * after its commit. The owner is woken only by an ask, a final state, or a
 * failure. The design is `plans/machines-design.md`, Part B.
 *
 * A round the account has no lane for, or one that died at a usage limit,
 * waits: the run keeps its state and its visit, holds nothing while it
 * waits, and its record fires at the time the account names
 * (`plans/kernel-orchestration.md`, P5b).
 */
import {
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  FileSystem,
  Layer,
  Match,
  Option,
  Order,
  Path,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Result,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { Tool } from "effect/ai"
import { Hex } from "effect/encoding"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { SqlClient } from "effect/sql"
import {
  AgentName,
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  GentPlatform,
  type LaneUnavailable,
  ModelId,
  omitUndefined,
  type ReasoningEffort,
  request,
  resolveDataDir,
  runProcess,
  SessionId,
  sessionThread,
  tool,
  type WakeDueInput,
  WakeNext,
  writeFileAtomic,
  ensureExtensionTables,
} from "@gent/core/extensions/api"
import {
  type CommandOutputFile,
  type CommandProcess,
  commandLaunch,
  removeCommandReceipt,
  runBashCommand,
  stopLostCommand,
} from "./exec-tools.js"
import type { ChildUsage } from "./child-turns.js"
import { generationOf, Integration, type GateKey, type GateRecord } from "./integration.js"
import {
  currentThreadPlace,
  StartParams,
  ThreadBusy,
  Threads,
  type ThreadSendInput,
  type ThreadStartInput,
} from "./threads.js"

const MACHINES_EXTENSION_ID = ExtensionId.make("@gent/machines")

/** `metadata.customType` on the message that asks the owner. */
export const MACHINE_ASK_TYPE = "machine-ask"

/** `metadata.customType` on the message that tells the owner a run ended. */
export const MACHINE_END_TYPE = "machine-end"

// ── schema ──────────────────────────────────────────────────────────────────

const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/))
const MachineName = Slug.pipe(Schema.brand("MachineName"))
type MachineName = typeof MachineName.Type
const StateName = Slug.pipe(Schema.brand("StateName"))
type StateName = typeof StateName.Type
const RoleName = Slug.pipe(Schema.brand("RoleName"))
type RoleName = typeof RoleName.Type
/** A transition key: a thread verdict, an ask choice. `retry`, `stop` and `continue` are reserved. */
const Verdict = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)).pipe(
  Schema.brand("Verdict"),
)
type Verdict = typeof Verdict.Type
const RunId = Schema.String.check(Schema.isPattern(/^run-[0-9a-f]{16}$/)).pipe(
  Schema.brand("RunId"),
)
type RunId = typeof RunId.Type
/** `<run>:<seq>`: the step that asked. */
const AskId = Schema.String.pipe(Schema.brand("AskId"))
type AskId = typeof AskId.Type
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Template = Schema.String.check(Schema.isMaxLength(16_000))

/**
 * One role: a thread's spec, as `thread.start` takes it. Default agent:
 * `worker`, which keeps the session cache. Its model is a pinned `model`
 * (with an optional `effort`), or a config `role` (`Accounts.role`), whose
 * choices name each model and effort: a role names no `model` or `effort`.
 * With neither, the agent's model runs. `against` names another thread
 * role: this role never runs a model of the maker whose model that role's
 * thread runs.
 */
const ThreadRole = Schema.Struct({
  agent: StartParams.fields.agent,
  model: StartParams.fields.model,
  role: Schema.optionalKey(Schema.String),
  against: Schema.optionalKey(RoleName),
  /** Read only to refuse it: config roles replaced the model tiers. */
  tier: Schema.optionalKey(Schema.Json),
  effort: StartParams.fields.effort,
  account: StartParams.fields.account,
  instructions: Schema.optionalKey(Template),
  tools: StartParams.fields.tools,
})
type ThreadRole = typeof ThreadRole.Type

/** A loop cap: past `maxVisits` entries (default 10) the run goes to `exhausted`, else asks. */
const VisitCap = {
  maxVisits: Schema.optionalKey(PositiveInt),
  exhausted: Schema.optionalKey(StateName),
}

/**
 * A config role a thread state runs in place of its thread role's: when the
 * slot `when` (a template ref, `plan.reply.path`) reads `is`, through visit
 * `visits` (every visit when absent).
 */
const RoleSwitch = Schema.Struct({
  role: Schema.String,
  when: Schema.String,
  is: Schema.Json,
  visits: Schema.optionalKey(PositiveInt),
})

/**
 * A round too big for one thread round: one whose own work handed off (the
 * round's `handedOffTokens`, threads.md) reaches `windows` times the model's
 * window it ran in ends as a size stop, whatever it replied. The run moves to
 * `to`, and the move's note (`{{visit.note}}` in `to`'s template) names the
 * state, the role, the verdict and the size against the limit. A state
 * without it never stops on size.
 */
const Oversize = Schema.Struct({
  windows: Schema.Finite.check(Schema.isGreaterThan(0)),
  to: StateName,
})

const ThreadState = Schema.Struct({
  kind: Schema.Literal("thread"),
  thread: RoleName,
  say: Template,
  /** The first switch that holds names the round's config role; `against` stays the thread role's. */
  switches: Schema.optionalKey(Schema.Array(RoleSwitch)),
  /** Unconditional: the round's text is saved, and the run moves on. */
  next: Schema.optionalKey(StateName),
  /** By verdict: the round must `thread.reply` a value whose `next` is one of these keys. */
  on: Schema.optionalKey(Schema.Record(Verdict, StateName)),
  /**
   * `true`: a new thread on every visit. A number: a new thread from that
   * visit on. The new thread becomes the role's: a later round of the role
   * in a state that is not fresh continues it, never the thread before it.
   */
  fresh: Schema.optionalKey(Schema.Union([Schema.Boolean, PositiveInt])),
  oversize: Schema.optionalKey(Oversize),
  ...VisitCap,
})
type ThreadState = typeof ThreadState.Type

/** A server-global named permit; an omitted limit means one. */
const Permit = Schema.Struct({ name: Slug, limit: Schema.optionalKey(PositiveInt) })

/**
 * A command moves by its end: exit 0 takes `pass`. Without `error`, any other
 * end takes `fail`. With it, only exit 1 takes `fail`, and any other end (an
 * exit of 2 or more, a timeout, a command that did not start) is a check that
 * gave no verdict: it takes `error` with a note that names the end
 * (`{{visit.note}}` in the target's template), so a check that cannot run is
 * not read as a failed one.
 */
const RunState = Schema.Struct({
  kind: Schema.Literal("run"),
  run: Template,
  permit: Schema.optionalKey(Permit),
  /** Default 3600. A timeout takes `fail`, or `error` when the state has one. */
  timeoutSeconds: Schema.optionalKey(PositiveInt),
  on: Schema.Struct({ pass: StateName, fail: StateName, error: Schema.optionalKey(StateName) }),
  /**
   * A screen before a review (the repeat-test check): its pass judges no
   * round, so the rounds since the run's last check wait for the next check
   * (`ModelQuality.checks`); its fail judges them as any check's does.
   * Default false: every pass and fail judges.
   */
  screen: Schema.optionalKey(Schema.Boolean),
  /**
   * Reuses a pass (`ReceiptKey`): a visit whose head commit, command as
   * rendered for it, environment and inputs all match a kept pass moves by
   * `pass` with no command run. Default false: every visit runs.
   */
  reuse: Schema.optionalKey(Schema.Boolean),
  /**
   * The file the command's whole output goes to, from its start, however it
   * ends: a template rendered per visit, resolved against the run's cwd. A
   * reused visit writes it too, naming the pass it reused and that output.
   */
  log: Schema.optionalKey(Template),
  ...VisitCap,
})
type RunState = typeof RunState.Type

/**
 * Pushes the run's head (`HEAD` of its cwd) to `ref` through the integration
 * gate, then moves by the CI verdict for that push. A gate that is not clear
 * makes the run wait; a push the gate refuses (not a fast-forward) or one a
 * crash cut off before it landed takes `red`. A visit after a red one
 * passes that red generation as its repair. The visit pushes the head its
 * cwd had when the run entered it. With `on.restack`, a push the ref moved
 * past rebases the checkout onto the fetched ref and moves by `restack`, so
 * the new head is checked again; a rebase that conflicts is aborted and
 * moves by `conflict` (default `red`).
 *
 * `via` (a template, so the run's input can choose; rendered `push`, `pr` or
 * empty, which is `push`): `pr` pushes the head to the run's own branch and
 * opens a pull request on `ref` instead, and the run waits for a person's
 * review (`PrWait`). An approved PR with green checks merges and moves by
 * `green`; changes requested, or a closed PR, moves by `declined` (default
 * `red`) with the reviews as the note.
 */
const IntegrateState = Schema.Struct({
  kind: Schema.Literal("integrate"),
  ref: Schema.String,
  /** Default origin. */
  remote: Schema.optionalKey(Schema.String),
  via: Schema.optionalKey(Schema.String),
  on: Schema.Struct({
    green: StateName,
    red: StateName,
    restack: Schema.optionalKey(StateName),
    conflict: Schema.optionalKey(StateName),
    declined: Schema.optionalKey(StateName),
  }),
  ...VisitCap,
})
type IntegrateState = typeof IntegrateState.Type

/**
 * A markdown heading's text, as `## Premise` names it: one line with no `#`
 * and no space at either end, since a file's heading is read trimmed.
 */
const HeadingText = Schema.String.check(Schema.isPattern(/^[^#\s](?:[^#\r\n]*[^#\s])?$/)).check(
  Schema.isMaxLength(80),
)

/**
 * A file some answers need. A visit the run entered by one of `after` (the
 * move's edge: `exhausted` for a cap, a round's verdict for a verdict move)
 * owes the file, and so does every later visit of the ask, by any edge,
 * until an answer meets it (`RunMemo.owed`). On a visit that owes it, each
 * of `choices` is refused until `file` (a template, from the run's cwd)
 * changed since the ask (`AppliedRequirement.digest`) and holds text under
 * each of `headings`.
 */
const AnswerRequirement = Schema.Struct({
  choices: Schema.NonEmptyArray(Verdict),
  after: Schema.NonEmptyArray(Verdict),
  file: Template,
  headings: Schema.NonEmptyArray(HeadingText),
})
type AnswerRequirement = typeof AnswerRequirement.Type

/**
 * A requirement as one ask applied it, recorded in its `Dispatched` step and
 * the run's pending action: `file` resolved, and the SHA-256 hex of its text
 * at the ask (absent: no file then). An answer in `choices` needs a file
 * whose digest differs.
 */
const AppliedRequirement = Schema.Struct({
  choices: Schema.NonEmptyArray(Verdict),
  file: Schema.String,
  headings: Schema.NonEmptyArray(HeadingText),
  digest: Schema.optionalKey(Schema.String),
})
type AppliedRequirement = typeof AppliedRequirement.Type

const AskState = Schema.Struct({
  kind: Schema.Literal("ask"),
  ask: Template,
  /** The allowed answers, each with its next state. */
  on: Schema.Record(Verdict, StateName),
  requires: Schema.optionalKey(AnswerRequirement),
})

const FinalState = Schema.Struct({
  kind: Schema.Literal("final"),
  /** The line the owner's wake carries; default "<machine> finished in <state>". */
  say: Schema.optionalKey(Template),
  /**
   * Whether the run's work is accepted here, as a unit a cheapest role's
   * rank and a model's quality count; default true. A final state that
   * drops the work, or sends it back for a rewrite, says false.
   */
  accepts: Schema.optionalKey(Schema.Boolean),
})

const MachineState = Schema.Union([
  ThreadState,
  RunState,
  IntegrateState,
  AskState,
  FinalState,
]).pipe(Schema.toTaggedUnion("kind"))
type MachineState = typeof MachineState.Type

/** A shipped file's name: a slug with at most one extension, `repeat-tests.ts`. */
const FileName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}(\.[a-z0-9]{1,8})?$/))

const MachineDefinition = Schema.Struct({
  name: MachineName,
  threads: Schema.Record(RoleName, ThreadRole),
  start: StateName,
  states: Schema.Record(StateName, MachineState),
  /**
   * Files the definition ships, by name: a script a `run` state runs. Each
   * command gets them written to a temp directory of its own, removed when
   * it ends, and `{{files.<name>}}` renders a file's path.
   */
  files: Schema.optionalKey(
    Schema.Record(FileName, Schema.String.check(Schema.isMaxLength(64_000))),
  ),
})
type MachineDefinition = typeof MachineDefinition.Type

/**
 * Why a run asks. `interrupted`: a command lost its process to a stop, or a
 * worker's round was stopped from outside the machine.
 */
const AskReason = Schema.Literals(["asked", "interrupted", "no-verdict", "exhausted"])
type AskReason = typeof AskReason.Type

/** The verdict a round on a state with `on` must `thread.reply`; anything else is no verdict. */
const VerdictReply = Schema.Struct({ next: Verdict })

const ProcessRecord = Schema.Struct({
  pid: Schema.Int,
  startIdentity: Schema.String,
  token: Schema.OptionFromOptionalKey(Schema.String),
})

/** Where a command's launcher writes its process, and its token (`CommandLaunch`). */
const LaunchRecord = Schema.Struct({ token: Schema.String, receipt: Schema.String })

const RunStatus = Schema.Literals(["running", "asking", "final", "failed", "stopped"])
type RunStatus = typeof RunStatus.Type

const PlaceRecord = Schema.Struct({ sessionId: SessionId, branchId: BranchId })
type PlaceRecord = typeof PlaceRecord.Type

/** The action a step recorded before it dispatched it: the receipt recovery reads. */
const PendingAction = Schema.TaggedUnion({
  /**
   * `key` is the Threads idempotency key; `thread` and `round` are set once
   * admitted. `notBefore` (epoch ms): the round waits for the account until
   * then, holding nothing. The marker stays after its deadline until the
   * dispatch commits again without it. `fresh`: the round runs on
   * a new thread, as a usage limit's rerun does. `model`: the model the
   * thread's session runs, read when it is admitted. `configRole`: the
   * config role the round ran, a state's switch or its thread role's own.
   * `queuedOn` and `queuedAt`: no choice of its pick had a lane, so the
   * round waits in the lane queue of that model since then; past
   * `PATIENCE` it moves to another maker's choice (`roundPatience`).
   * `avoid`: the makers patience moved it off, which its pick leaves out;
   * a retry or a rerun of the same visit keeps them, a new visit starts
   * with none. `leaving`: patience is moving it off `maker`'s `model`, a
   * move a restart finishes (`settleLeaving`).
   */
  Round: {
    state: StateName,
    visit: PositiveInt,
    key: Schema.String,
    attempt: PositiveInt,
    thread: Schema.optionalKey(SessionId),
    round: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(ModelId),
    configRole: Schema.optionalKey(Schema.String),
    notBefore: Schema.optionalKey(Schema.Finite),
    fresh: Schema.optionalKey(Schema.Boolean),
    queuedOn: Schema.optionalKey(ModelId),
    queuedAt: Schema.optionalKey(Schema.Finite),
    avoid: Schema.optionalKey(Schema.Array(Schema.String)),
    leaving: Schema.optionalKey(Schema.Struct({ maker: Schema.String, model: ModelId })),
  },
  /**
   * `launch` is stored before the spawn, so a later server finds the
   * command's process group from its receipt; `process` is set once the
   * spawn copied the receipt.
   */
  Command: {
    state: StateName,
    visit: PositiveInt,
    startedAt: Schema.Finite,
    launch: LaunchRecord,
    process: Schema.optionalKey(ProcessRecord),
  },
  /**
   * `requestId` is the gate's idempotency key, derived from the run and its
   * seq and saved before the push: a push again after a crash pushes nothing
   * new, and a stop or a failure releases the gate by it. `repo`, `generation` and `sha` are set once the gate
   * admitted the push; the run then waits for that generation's verdict.
   * `notBefore` (epoch ms): the gate was not clear, the push is tried again then.
   * `head`: the commit the visit pushes, read as it was entered; absent when
   * it could not be read, and the push takes the cwd's `HEAD`.
   * `via: "pr"`: the visit opens a pull request (`IntegrateState.via`);
   * `pr` is its number once opened, and `repo` and `sha` the repository and
   * the pushed head. The run then waits for a person, polling the PR.
   * `queued`: the merge method of a `gh pr merge` that exited 0 while the PR
   * stayed open (a merge queue holds it); the run asks for no second merge
   * and waits for the PR to read merged.
   */
  Integrate: {
    state: StateName,
    visit: PositiveInt,
    requestId: Schema.String,
    head: Schema.optionalKey(Schema.String),
    via: Schema.optionalKey(Schema.Literal("pr")),
    pr: Schema.optionalKey(PositiveInt),
    queued: Schema.optionalKey(Schema.String),
    repairOf: Schema.optionalKey(PositiveInt),
    repo: Schema.optionalKey(Schema.String),
    generation: Schema.optionalKey(PositiveInt),
    sha: Schema.optionalKey(Schema.String),
    notBefore: Schema.optionalKey(Schema.Finite),
  },
  Ask: {
    state: StateName,
    visit: PositiveInt,
    askId: AskId,
    reason: AskReason,
    choices: Schema.Array(Verdict),
    /** An interrupted command whose process group a restart could not show gone. */
    mayStillRun: Schema.optionalKey(Schema.Boolean),
    deliveredAt: Schema.optionalKey(Schema.Finite),
    /** The ask state's `requires`, on a visit that owes its file. */
    requires: Schema.optionalKey(AppliedRequirement),
  },
})
type PendingAction = typeof PendingAction.Type
type RoundAction = Extract<PendingAction, { readonly _tag: "Round" }>
type CommandAction = Extract<PendingAction, { readonly _tag: "Command" }>
type AskAction = Extract<PendingAction, { readonly _tag: "Ask" }>
type IntegrateAction = Extract<PendingAction, { readonly _tag: "Integrate" }>

/** The context templates read: each state's last value, and every value in order. */
const RunContext = Schema.Struct({
  last: Schema.Record(Schema.String, Schema.Json),
  all: Schema.Record(Schema.String, Schema.Array(Schema.Json)),
})
type RunContext = typeof RunContext.Type

/**
 * How often each state was entered, and the visits past its cap that a
 * `retry` answer to an `exhausted` ask granted.
 */
const Visits = Schema.Struct({
  counts: Schema.Record(Schema.String, Count),
  grants: Schema.Record(Schema.String, Count),
})
type Visits = typeof Visits.Type

/** A round's turn's tokens, by class: `input` counts the cache's reads and writes too. */
const RoundTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})

/** One row of the append-only log. */
const MachineStep = Schema.TaggedUnion({
  /** `project`: the project the run's cwd works in (`Accounts.project`). */
  Started: { machine: MachineName, input: Schema.Json, project: Schema.optionalKey(Schema.String) },
  Dispatched: { action: PendingAction },
  /** The pending action gained its receipt: a round's thread and id, a command's process. */
  Recorded: { action: PendingAction },
  /** Where the next owner message lands, saved before it is sent. */
  PlaceSaved: { place: PlaceRecord },
  /**
   * `role`, `model`, `costUsd` and `tokens`: the role whose thread ran the
   * round, the thread's model, and its turn's priced cost and tokens, when
   * known. `handedOffTokens`: the round's size, the tokens of its own work
   * that left the model's context, absent for none; `windowTokens` the
   * model's window it ran in, when a step was projected (threads.md).
   */
  RoundEnded: {
    state: StateName,
    round: Schema.String,
    verdict: Schema.optionalKey(Verdict),
    dead: Schema.Boolean,
    role: Schema.optionalKey(RoleName),
    /** The config role the round ran; absent on a step from before switches: the thread role's own. */
    configRole: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(ModelId),
    costUsd: Schema.optionalKey(Schema.Finite),
    tokens: Schema.optionalKey(RoundTokens),
    handedOffTokens: Schema.optionalKey(PositiveInt),
    windowTokens: Schema.optionalKey(PositiveInt),
  },
  /** `reused`: a pass receipt gave the end, and no command ran (`RunState.reuse`). */
  CommandEnded: {
    state: StateName,
    exitCode: Schema.optionalKey(Schema.Int),
    timedOut: Schema.Boolean,
    outputTail: Schema.String,
    reused: Schema.optionalKey(Schema.Boolean),
  },
  Interrupted: { state: StateName },
  /**
   * The pending round waits until `until`: the account's windows carried no
   * run of it (`lane`, spent at its admission), its worker died at a usage
   * limit (`quota`), or the owner's Sabbath holds every run until its end
   * (`sabbath`). A pending integrate waits for a gate that is not clear
   * (`integration`), or for a person's review of its pull request (`pr`,
   * once, as the PR opens: each later poll leaves no step). No visit is spent.
   */
  Waiting: {
    state: StateName,
    until: Schema.Finite,
    reason: Schema.Literals(["lane", "quota", "sabbath", "integration", "pr"]),
  },
  /**
   * The pending round waited `PATIENCE` in the lane queue of `model`: it
   * left that queue and picks again with every choice of `maker` left out.
   */
  Repicked: { state: StateName, model: ModelId, maker: Schema.String },
  Delivered: { askId: AskId },
  Answered: { askId: AskId, choice: Verdict, note: Schema.optionalKey(Schema.String) },
  /** The value a state's visit left: templates read it as `{{<state>.*}}` and `{{all.<state>}}`. */
  Saved: { state: StateName, value: Schema.Json },
  /** A `retry` answer to an `exhausted` ask granted the state one visit past its cap. */
  Granted: { state: StateName },
  /**
   * `note`: why the run moved, for `to`'s template (`{{visit.note}}`): a size
   * stop's (`Oversize`), a check error's (`RunState`).
   */
  Moved: {
    from: StateName,
    to: StateName,
    by: Schema.String,
    note: Schema.optionalKey(Schema.String),
    /** False on a screen's pass (`RunState.screen`), which judged no round. */
    judged: Schema.optionalKey(Schema.Boolean),
    /**
     * True on an answer whose choice its ask's `requires` guarded, and whose
     * file met them: the run owes that ask's file no more.
     */
    met: Schema.optionalKey(Schema.Boolean),
    /**
     * The verdict that moved the run: a round's (`by: "verdict"`), or an
     * answer to a thread state's ask that chose one of its verdicts.
     */
    verdict: Schema.optionalKey(Verdict),
  },
  /** `accepted`: the final state's `accepts`; a step without it accepted. */
  Finished: { state: StateName, accepted: Schema.optionalKey(Schema.Boolean) },
  Failed: { error: Schema.String },
  Stopped: {},
  /** A stopped run's open round or command was stopped. */
  /** A process the stopped run started may still run: its group was not shown gone. */
  Settled: { mayStillRun: Schema.optionalKey(Schema.Boolean) },
  Notified: {},
})
type MachineStep = typeof MachineStep.Type
type RoundEnded = Extract<MachineStep, { readonly _tag: "RoundEnded" }>
type MovedStep = Extract<MachineStep, { readonly _tag: "Moved" }>

/** One step of a run's log, as a model's quality is read from it. */
interface RunOutcome {
  readonly run: RunId
  readonly step: MachineStep
}

// ── errors ──────────────────────────────────────────────────────────────────

class MachineError extends Schema.TaggedError<MachineError, { readonly brand: unique symbol }>()(
  "MachineError",
  { message: Schema.String },
) {}

/**
 * An answer the run refuses. `conflict`: the ask was answered with another
 * choice. `stale`: the ask was never answered and is no longer the current
 * one. `invalid`: the current ask does not offer the choice. `unmet`: the
 * choice needs a file (the state's `requires`) the run's cwd does not hold,
 * changed since the ask, yet.
 */
class MachineAnswerRefused extends Schema.TaggedError<
  MachineAnswerRefused,
  { readonly brand: unique symbol }
>()("MachineAnswerRefused", {
  message: Schema.String,
  reason: Schema.Literals(["stale", "conflict", "invalid", "unmet"]),
  ask: Schema.optionalKey(Schema.Struct({ askId: AskId, choices: Schema.Array(Verdict) })),
}) {}

class MachineStorageError extends Schema.TaggedError<
  MachineStorageError,
  { readonly brand: unique symbol }
>()("MachineStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A fault the run cannot turn into an ask: the run fails, and the owner is told. */
class MachineFault extends Schema.TaggedError<MachineFault, { readonly brand: unique symbol }>()(
  "MachineFault",
  { message: Schema.String },
) {}

const storageError = (message: string) => (cause: unknown) =>
  new MachineStorageError({ message, cause })

// ── definition checks ───────────────────────────────────────────────────────

/** The default cap of a thread or run state with no `maxVisits`. */
const DEFAULT_MAX_VISITS = 10

const RESERVED_KEYS: ReadonlySet<string> = new Set(["retry", "stop", "continue"])
const TEMPLATE_HEADS: ReadonlySet<string> = new Set(["input", "all", "visit", "files", "bun"])

/** `{{ref}}`: the one template form. */
const TEMPLATE_SLOT = /\{\{\s*([^{}\s]+)\s*\}\}/g

const slotsOf = (template: string): ReadonlyArray<ReadonlyArray<string>> =>
  [...template.matchAll(TEMPLATE_SLOT)].map((match) => (match[1] ?? "").split("."))

const templatesOf = (state: MachineState): ReadonlyArray<string> => {
  switch (state.kind) {
    case "thread":
      return [state.say]
    case "run":
      return [state.run, ...Option.toArray(Option.fromUndefinedOr(state.log))]
    case "integrate":
      return Option.toArray(Option.fromUndefinedOr(state.via))
    case "ask":
      return [state.ask, ...Option.toArray(Option.fromUndefinedOr(state.requires?.file))]
    case "final":
      return Option.toArray(Option.fromUndefinedOr(state.say))
  }
}

/** Every state a state can move to, by any edge. */
const targetsOf = (state: MachineState): ReadonlyArray<StateName> => {
  switch (state.kind) {
    case "thread":
      return [
        ...Option.toArray(Option.fromUndefinedOr(state.next)),
        ...Object.values(state.on ?? {}),
        ...Option.toArray(Option.fromUndefinedOr(state.exhausted)),
        ...Option.toArray(Option.fromUndefinedOr(state.oversize?.to)),
      ]
    case "run":
      return [
        state.on.pass,
        state.on.fail,
        ...Option.toArray(Option.fromUndefinedOr(state.on.error)),
        ...Option.toArray(Option.fromUndefinedOr(state.exhausted)),
      ]
    case "integrate":
      return [
        state.on.green,
        state.on.red,
        ...Option.toArray(Option.fromUndefinedOr(state.on.restack)),
        ...Option.toArray(Option.fromUndefinedOr(state.on.conflict)),
        ...Option.toArray(Option.fromUndefinedOr(state.on.declined)),
        ...Option.toArray(Option.fromUndefinedOr(state.exhausted)),
      ]
    case "ask":
      return Object.values(state.on)
    case "final":
      return []
  }
}

/** A state with a visit cap: a thread, a run or an integrate state. */
const isCapped = (state: MachineState): state is ThreadState | RunState | IntegrateState =>
  state.kind === "thread" || state.kind === "run" || state.kind === "integrate"

const exhaustedOf = (state: MachineState): Option.Option<StateName> => {
  if (isCapped(state)) {
    return Option.fromUndefinedOr(state.exhausted)
  }
  return Option.none()
}

/**
 * The `by` of every move the engine makes; a round's verdict move is matched
 * by its verdict instead (`Moved.verdict`), and `verdict` is left only for a
 * thread state with `next`.
 */
const MOVE_KINDS: ReadonlySet<string> = new Set([
  "exhausted",
  "oversize",
  "verdict",
  "pass",
  "fail",
  "error",
  "green",
  "red",
  "restack",
  "conflict",
  "declined",
  "answer",
])

/** The verdicts a thread state's `on` names: the edges a round's verdict move can take. */
const threadVerdictsOf = (state: MachineState): ReadonlyArray<string> => {
  if (state.kind !== "thread") return []
  return Object.keys(state.on ?? {})
}

/** An integrate state's conflict edge and its `via`, when it names no slot. */
const integrateProblems = (name: string, state: IntegrateState): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (Predicate.isNotUndefined(state.on.conflict) && Predicate.isUndefined(state.on.restack)) {
    problems.push(`${name}: on.conflict needs on.restack`)
  }
  const via = state.via ?? ""
  if (slotsOf(via).length === 0 && Option.isNone(integrateVia(via))) {
    problems.push(`${name}: via is push or pr, not ${via}`)
  }
  return problems
}

/** The edges, roles, caps and reserved keys of one state. */
const stateProblems = (
  definition: MachineDefinition,
  names: ReadonlySet<string>,
  name: string,
  state: MachineState,
): ReadonlyArray<string> => {
  const problems = targetsOf(state)
    .filter((target) => !names.has(target))
    .map((target) => `${name}: names no state ${target}`)
  if (state.kind === "thread") {
    if (!Object.hasOwn(definition.threads, state.thread)) {
      problems.push(`${name}: names no thread role ${state.thread}`)
    }
    if (Predicate.isNotUndefined(state.next) === Predicate.isNotUndefined(state.on)) {
      problems.push(`${name}: a thread state has exactly one of next and on`)
    }
  }
  if (isCapped(state)) {
    if (Predicate.isNotUndefined(state.exhausted) && Predicate.isUndefined(state.maxVisits)) {
      problems.push(`${name}: exhausted needs maxVisits`)
    }
  }
  if (state.kind === "integrate") problems.push(...integrateProblems(name, state))
  if (state.kind === "thread" || state.kind === "ask") {
    const reserved = Object.keys(state.on ?? {}).filter((key) => RESERVED_KEYS.has(key))
    problems.push(...reserved.map((key) => `${name}: ${key} is a reserved choice`))
  }
  if (state.kind === "ask") {
    const guarded = state.requires?.choices ?? []
    const unknown = guarded.filter((choice) => !Object.hasOwn(state.on, choice))
    problems.push(...unknown.map((choice) => `${name}: requires names no choice ${choice}`))
    const verdicts = new Set(Object.values(definition.states).flatMap(threadVerdictsOf))
    const edges = state.requires?.after ?? []
    const unreachable = edges.filter((edge) => !MOVE_KINDS.has(edge) && !verdicts.has(edge))
    problems.push(...unreachable.map((edge) => `${name}: requires after names no move ${edge}`))
  }
  return problems
}

/** Whether a template slot names something a run holds. */
const slotResolves = (names: ReadonlySet<string>, slot: ReadonlyArray<string>) => {
  const [head = "", next = ""] = slot
  if (head === "all") return names.has(next)
  // `visit` renders the visit number and `visit.note` the move's note (`visitSlot`), nothing more.
  if (head === "visit") return slot.length === 1 || (slot.length === 2 && next === "note")
  // `files` and `bun` resolve only in a run state's command (`templateProblems`).
  if (head === "files" || head === "bun") return false
  return TEMPLATE_HEADS.has(head) || names.has(head)
}

/** A `files` or `bun` slot: only a run state's command has them. */
const commandSlotProblems = (
  definition: MachineDefinition,
  state: MachineState,
  slot: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [head = "", ...rest] = slot
  if (head === "bun") {
    if (rest.length > 0) return ["names no runtime: the slot is {{bun}}"]
    if (state.kind !== "run") return ["names the runtime, and only a run state runs it"]
    return []
  }
  if (state.kind !== "run") return ["names a file, and only a run state has files"]
  if (Object.hasOwn(definition.files ?? {}, rest.join("."))) return []
  return ["names no shipped file"]
}

const templateProblems = (
  definition: MachineDefinition,
  names: ReadonlySet<string>,
  name: string,
  state: MachineState,
): ReadonlyArray<string> =>
  templatesOf(state)
    .flatMap(slotsOf)
    .flatMap((slot) => {
      const [head = ""] = slot
      const shown = `${name}: {{${slot.join(".")}}}`
      if (head === "files" || head === "bun") {
        return commandSlotProblems(definition, state, slot).map((problem) => `${shown} ${problem}`)
      }
      if (slotResolves(names, slot)) return []
      return [`${shown} names no state`]
    })

/** Every state an edge from `start` reaches. */
const reachedFrom = (definition: MachineDefinition, start: string): ReadonlySet<string> => {
  const reached = new Set<string>()
  const pending: Array<string> = [start]
  while (pending.length > 0) {
    const name = pending.pop() ?? ""
    if (reached.has(name)) continue
    reached.add(name)
    const state = definition.states[StateName.make(name)]
    if (Predicate.isNotUndefined(state)) pending.push(...targetsOf(state))
  }
  return reached
}

const reachProblems = (
  definition: MachineDefinition,
  names: ReadonlySet<string>,
): ReadonlyArray<string> => {
  if (!names.has(definition.start)) return [`start names no state: ${definition.start}`]
  const reached = reachedFrom(definition, definition.start)
  const problems = names
    .values()
    .filter((name) => !reached.has(name))
    .map((name) => `${name}: no edge from ${definition.start} reaches it`)
    .toArray()
  const final = [...reached].some(
    (name) => definition.states[StateName.make(name)]?.kind === "final",
  )
  if (!final) problems.push(`no final state is reachable from ${definition.start}`)
  return problems
}

/** The loop a walk along `exhausted` edges from `name` comes back to, if it comes back. */
const exhaustedLoop = (definition: MachineDefinition, name: string) => {
  const walk: Array<string> = []
  let current = Option.some(name)
  while (Option.isSome(current) && !walk.includes(current.value)) {
    walk.push(current.value)
    const state = definition.states[StateName.make(current.value)]
    current = Option.flatMap(Option.fromUndefinedOr(state), exhaustedOf)
  }
  return Option.map(current, (back) => [...walk.slice(walk.indexOf(back)), back])
}

/**
 * The `exhausted` edges alone must not loop: a run that moves along them
 * enters no state, so such a loop would spin with no visit counted. Each
 * state has at most one such edge, so a walk from any state ends or comes
 * back.
 */
const exhaustedCycleProblems = (
  definition: MachineDefinition,
  names: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const cycles = new Map<string, ReadonlyArray<string>>()
  for (const name of names) {
    const loop = exhaustedLoop(definition, name)
    if (Option.isNone(loop)) continue
    const key = loop.value.slice(1).toSorted().join(",")
    if (!cycles.has(key)) cycles.set(key, loop.value)
  }
  return [...cycles.values()].map((loop) => `exhausted edges form a cycle: ${loop.join(" -> ")}`)
}

/**
 * A thread role's model: a config `role` names its own models and efforts,
 * so it takes no `model` or `effort`; `against` names another role of the
 * definition that runs a config role.
 */
const roleProblems = (definition: MachineDefinition): ReadonlyArray<string> =>
  Object.entries(definition.threads).flatMap(([name, role]) => {
    const problems: Array<string> = []
    if (Predicate.isNotUndefined(role.tier))
      problems.push(`${name}: names a tier; config roles replaced tiers, so name a role`)
    if (Predicate.isNotUndefined(role.role)) {
      if (Predicate.isNotUndefined(role.model)) problems.push(`${name}: names a model and a role`)
      if (Predicate.isNotUndefined(role.effort))
        problems.push(`${name}: names an effort and a role`)
    }
    if (Predicate.isNotUndefined(role.against)) {
      const other = definition.threads[role.against]
      if (Predicate.isUndefined(role.role)) problems.push(`${name}: names against with no role`)
      if (role.against === name) problems.push(`${name}: is against itself`)
      else if (!Object.hasOwn(definition.threads, role.against))
        problems.push(`${name}: is against no thread role ${role.against}`)
      else if (Predicate.isUndefined(other?.role))
        problems.push(`${name}: is against ${role.against}, which names no role`)
    }
    return problems
  })

/**
 * A state's role switches: its thread role runs a config role, and each
 * switch's `when` reads a state or the input.
 */
const switchProblems = (
  definition: MachineDefinition,
  names: ReadonlySet<string>,
): ReadonlyArray<string> =>
  Object.entries(definition.states).flatMap(([name, state]) => {
    if (state.kind !== "thread") return []
    const switches = state.switches ?? []
    if (switches.length === 0) return []
    const problems: Array<string> = []
    if (Predicate.isUndefined(definition.threads[state.thread]?.role))
      problems.push(`${name}: switches the role of ${state.thread}, which names no role`)
    for (const each of switches) {
      if (!slotResolves(names, each.when.split(".")))
        problems.push(`${name}: a switch's when ${each.when} names no state`)
    }
    return problems
  })

/**
 * Every problem of a definition the schema admits, at once: the graph's
 * names, edges, reachability, templates, roles, and cycles of `exhausted`
 * edges.
 */
const definitionProblems = (definition: MachineDefinition): ReadonlyArray<string> => {
  const names = new Set<string>(Object.keys(definition.states))
  const reserved = TEMPLATE_HEADS.values()
    .filter((head) => names.has(head))
    .map((head) => `${head} is a reserved name, not a state`)
    .toArray()
  const perState = Object.entries(definition.states).flatMap(([name, state]) => [
    ...stateProblems(definition, names, name, state),
    ...templateProblems(definition, names, name, state),
  ])
  return [
    ...reserved,
    ...perState,
    ...roleProblems(definition),
    ...switchProblems(definition, names),
    ...reachProblems(definition, names),
    ...exhaustedCycleProblems(definition, names),
  ]
}

const DefinitionJson = Schema.fromJsonString(MachineDefinition)
const decodeDefinitionJson = Schema.decodeUnknownOption(DefinitionJson)

/**
 * A definition's project file, `.gent/machines/<name>.json`: the definition,
 * and `shipped` when gent wrote it as an extension ships it. The marker is
 * the SHA-256 (16 hex) of the file's text without its marker line, so a
 * file whose text still hashes to it is the shipped write nobody edited,
 * and the next shipped version replaces it (`shipDefinition`). It means
 * nothing to a run: the run's definition (`DefinitionJson`) has no marker.
 */
const DefinitionFile = Schema.fromJsonString(
  Schema.Struct({ shipped: Schema.optionalKey(Schema.String), ...MachineDefinition.fields }),
  { space: 2 },
)

/** The marker line a shipped write puts first in its file, as `DefinitionFile` encodes it. */
const SHIPPED_MARK = /^\{\n {2}"shipped": "([0-9a-f]{16})",\n/

/** A definition the schema and the graph checks admit, or every reason it is refused. */
const checkedDefinition = (definition: MachineDefinition) => {
  const problems = definitionProblems(definition)
  if (problems.length === 0) return Effect.succeed(definition)
  return Effect.fail(
    new MachineError({
      message: `Machine ${definition.name} is refused:\n- ${problems.join("\n- ")}`,
    }),
  )
}

// ── templates ───────────────────────────────────────────────────────────────

/** Each substitution keeps its last characters: a findings ledger grows, and its end is newest. */
const SLOT_CHARS = 8_000

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json))

/** A string as it is; any other value as its JSON. */
const jsonText = (value: Schema.Json): string => {
  if (Predicate.isString(value)) return value
  return encodeJsonText(value)
}

const childOf = (value: Schema.Json, key: string): Option.Option<Schema.Json> => {
  const asArray = decodeArray(value)
  if (Option.isSome(asArray)) {
    if (!/^\d+$/.test(key)) return Option.none()
    return Option.fromUndefinedOr(asArray.value[Number(key)])
  }
  return Option.flatMap(decodeObject(value), (record) =>
    Option.liftPredicate(record, (found) => Object.hasOwn(found, key)).pipe(
      Option.flatMap((found) => Option.fromUndefinedOr(found[key])),
    ),
  )
}

const pathInto = (value: Schema.Json, path: ReadonlyArray<string>): Option.Option<Schema.Json> =>
  path.reduce<Option.Option<Schema.Json>>(
    (current, key) => Option.flatMap(current, (found) => childOf(found, key)),
    Option.some(value),
  )

/** What a template reads: `visit` is the state's visit, and `note` the note of the move into it. */
interface TemplateScope {
  readonly input: Schema.Json
  readonly context: RunContext
  readonly visit: number
  readonly note: Option.Option<string>
  /** A shipped file's path by name: a run state's command has them, no other template. */
  readonly files: Readonly<Record<string, string>>
  /** `{{bun}}`: the shell words that run Bun, in a run state's command only (`bunCommand`). */
  readonly bun: Option.Option<string>
}

/** `{{visit}}` is the visit's number, `{{visit.note}}` the note of the move into it. */
const visitSlot = (scope: TemplateScope, rest: ReadonlyArray<string>): Option.Option<string> => {
  if (rest.length === 0) return Option.some(String(scope.visit))
  if (rest.length === 1 && rest[0] === "note") return scope.note
  return Option.none()
}

const slotValue = (scope: TemplateScope, slot: ReadonlyArray<string>): Option.Option<string> => {
  const [head = "", ...rest] = slot
  if (head === "visit") return visitSlot(scope, rest)
  if (head === "input") return Option.map(pathInto(scope.input, rest), jsonText)
  if (head === "bun") return Option.filter(scope.bun, () => rest.length === 0)
  if (head === "files") {
    const file = rest.join(".")
    return Option.liftPredicate(scope.files, (files) => Object.hasOwn(files, file)).pipe(
      Option.flatMap((files) => Option.fromUndefinedOr(files[file])),
    )
  }
  if (head === "all") {
    const [state = "", ...path] = rest
    const values = Option.fromUndefinedOr(scope.context.all[state])
    return Option.flatMap(values, (all) => Option.map(pathInto(all, path), jsonText))
  }
  const last = Option.fromUndefinedOr(scope.context.last[head])
  return Option.flatMap(last, (value) => Option.map(pathInto(value, rest), jsonText))
}

/** A `{{ref}}` with the space before it, when there is one. */
const SPACED_SLOT = /( ?)\{\{\s*([^{}\s]+)\s*\}\}/g

/**
 * Fills each `{{ref}}`; a missing path is empty text. An empty slot between
 * two spaces leaves one, so `decides. {{visit.note}} Latest` with no note
 * reads `decides. Latest`.
 */
const render = (template: string, scope: TemplateScope): string =>
  template.replace(SPACED_SLOT, (whole: string, before: string, ref: string, at: number) => {
    const value = Option.getOrElse(slotValue(scope, ref.split(".")), () => "").slice(-SLOT_CHARS)
    const spacedAfter = template.charAt(at + whole.length) === " "
    if (value.length === 0 && before.length > 0 && spacedAfter) return ""
    return `${before}${value}`
  })

const saved = (context: RunContext, state: StateName, value: Schema.Json): RunContext => ({
  last: { ...context.last, [state]: value },
  all: { ...context.all, [state]: [...(context.all[state] ?? []), value] },
})

// ── runs ────────────────────────────────────────────────────────────────────

/** One run as its row holds it. */
interface RunRecord {
  readonly run: RunId
  readonly machine: MachineName
  readonly definitionJson: string
  readonly host: PlaceRecord
  /** The thread key that may answer, stop and read. */
  readonly ownerThread: SessionId
  /** Where the next owner message lands, saved before it is sent; none between deliveries. */
  readonly deliveryPlace: Option.Option<PlaceRecord>
  readonly cwd: string
  readonly input: Schema.Json
  /** The thread of each role: its last round's, unless that round was a retry or a rerun. */
  readonly roles: Readonly<Record<string, SessionId>>
  readonly state: StateName
  readonly status: RunStatus
  readonly pending: Option.Option<PendingAction>
  /** The last step's seq; every write compares and sets it. */
  readonly seq: number
  /** The end (final, failed, stopped) was settled: told to the owner, or stopped. */
  readonly notifiedAt: Option.Option<number>
  readonly error: Option.Option<string>
  readonly createdAt: number
}

/** The part of a run that is a fold over its steps (`foldSteps`); the row keeps no copy. */
interface RunMemo {
  readonly visits: Visits
  readonly context: RunContext
  /** The run's last move: how its current visit was entered, and that move's note. */
  readonly lastMove: Option.Option<MovedStep>
  /**
   * The ask states whose `requires` file the run owes: an ask dispatched with
   * its requirement adds its state, an answer that met it (`Moved.met`)
   * removes it.
   */
  readonly owed: ReadonlySet<string>
  /**
   * The commit the run's PR branch (`gent/<run>`) holds as the run last
   * pushed it: the sha of its last recorded open PR. None before its first.
   * The next push to the branch leases on it (`openPr`).
   */
  readonly prBranchHead: Option.Option<string>
}

type Run = RunRecord & RunMemo

const isTerminal = (status: RunStatus) =>
  status === "final" || status === "failed" || status === "stopped"

/** A run with work left: a step to take, an ask to answer, or an end to settle. */
const isActive = (run: Run) => !isTerminal(run.status) || Option.isNone(run.notifiedAt)

/** The core wake record of a run: on its host branch, with no time while the run is active. */
const runSource = (run: RunId) => `machine-run:${run}`
const RUN_SOURCE_PREFIX = "machine-run:"
const STOP_SOURCE_PREFIX = "machine-stop:"
const stopSource = (run: RunId) => `${STOP_SOURCE_PREFIX}${run}`

const RunRow = Schema.Struct({
  run: RunId,
  machine: MachineName,
  definition_json: Schema.String,
  host_session_id: SessionId,
  host_branch_id: BranchId,
  owner_thread: SessionId,
  owner_session_id: Schema.NullOr(SessionId),
  owner_branch_id: Schema.NullOr(BranchId),
  cwd: Schema.String,
  input_json: Schema.fromJsonString(Schema.Json),
  roles_json: Schema.fromJsonString(Schema.Record(Schema.String, SessionId)),
  state: StateName,
  status: RunStatus,
  pending_json: Schema.NullOr(Schema.fromJsonString(PendingAction)),
  seq: Schema.Int,
  notified_at: Schema.NullOr(Schema.Finite),
  error: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
const decodeRunRow = Schema.decodeUnknownEffect(RunRow)

const recordOfRow = (row: typeof RunRow.Type): RunRecord => ({
  run: row.run,
  machine: row.machine,
  definitionJson: row.definition_json,
  host: { sessionId: row.host_session_id, branchId: row.host_branch_id },
  ownerThread: row.owner_thread,
  deliveryPlace: Option.all({
    sessionId: Option.fromNullishOr(row.owner_session_id),
    branchId: Option.fromNullishOr(row.owner_branch_id),
  }),
  cwd: row.cwd,
  input: row.input_json,
  roles: row.roles_json,
  state: row.state,
  status: row.status,
  pending: Option.fromNullishOr(row.pending_json),
  seq: row.seq,
  notifiedAt: Option.fromNullishOr(row.notified_at),
  error: Option.fromNullishOr(row.error),
  createdAt: row.created_at,
})

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const encodeRoles = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, SessionId)),
)
const encodePending = Schema.encodeEffect(Schema.fromJsonString(PendingAction))
const encodeStep = Schema.encodeEffect(Schema.fromJsonString(MachineStep))
const StepJson = Schema.fromJsonString(MachineStep)

const StepRow = Schema.Struct({
  seq: Schema.Int,
  at: Schema.Finite,
  step_json: StepJson,
})
const decodeStepRows = Schema.decodeUnknownEffect(Schema.Array(StepRow))
const decodeOutcomeRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ run: RunId, ...StepRow.fields })),
)

const stateOfStep = (step: MachineStep, fallback: StateName): StateName => {
  switch (step._tag) {
    case "Dispatched":
    case "Recorded":
      return step.action.state
    case "RoundEnded":
    case "CommandEnded":
    case "Interrupted":
    case "Waiting":
    case "Repicked":
    case "Finished":
    case "Saved":
    case "Granted":
      return step.state
    case "Moved":
      return step.to
    default:
      return fallback
  }
}

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * The tables, in the server's database, kept at their own schema version: a
 * change to a table or to a stored shape bumps it, and a database at another
 * version loses these tables and gets them again.
 */
const createMachineTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(
    [
      `CREATE TABLE machine_runs (
        run TEXT PRIMARY KEY,
        machine TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        host_branch_id TEXT NOT NULL,
        owner_thread TEXT NOT NULL,
        owner_session_id TEXT,
        owner_branch_id TEXT,
        cwd TEXT NOT NULL,
        input_json TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        state TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','asking','final','failed','stopped')),
        pending_json TEXT,
        seq INTEGER NOT NULL,
        notified_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX machine_runs_host ON machine_runs (host_session_id, host_branch_id)
        WHERE status IN ('running','asking') OR notified_at IS NULL`,
      `CREATE INDEX machine_runs_owner ON machine_runs (owner_thread, created_at)`,
      `CREATE TABLE machine_steps (
        run TEXT NOT NULL REFERENCES machine_runs(run) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        state TEXT NOT NULL,
        step_json TEXT NOT NULL,
        PRIMARY KEY (run, seq)
      )`,
      // A cheapest role's pick reads one machine's newest ended runs: the runs by
      // machine, their steps by run.
      `CREATE INDEX machine_runs_machine ON machine_runs (machine)`,
      `CREATE INDEX machine_steps_state ON machine_steps (run, state)`,
      // A round's thread finds its run: the recorded rounds by thread. The
      // query repeats the index's expressions, as SQLite matches them.
      `CREATE INDEX machine_steps_thread
        ON machine_steps (json_extract(step_json, '$.action.thread'))
        WHERE json_extract(step_json, '$._tag') = 'Recorded'`,
    ],
    (statement) => sql.unsafe(statement),
    { discard: true },
  )
})

/**
 * The pass receipts (`ReceiptKey`), at a version of their own: a run reads
 * none of them back, so a change to them leaves the runs alone. `run` and
 * `visit` name the pass a reuse reads, for its log.
 */
const createReceiptTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE machine_receipts (
    head TEXT NOT NULL,
    command TEXT NOT NULL,
    env TEXT NOT NULL,
    input TEXT NOT NULL,
    ignored TEXT NOT NULL,
    run TEXT NOT NULL,
    visit INTEGER NOT NULL,
    exit_code INTEGER NOT NULL,
    output TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (head, command, env, input, ignored)
  )`)
  yield* sql.unsafe(`CREATE INDEX machine_receipts_at ON machine_receipts (at)`)
})

const ensureMachineTables = Effect.andThen(
  ensureExtensionTables({
    owner: "@gent/machines",
    version: 2,
    tables: ["machine_steps", "machine_runs"],
    create: createMachineTables,
  }),
  ensureExtensionTables({
    owner: "@gent/machines/receipts",
    version: 2,
    tables: ["machine_receipts"],
    create: createReceiptTables,
  }),
).pipe(Effect.mapError(storageError("Machine table setup failed")))

/** The newest pass receipts a server keeps; a new one past this many drops the oldest. */
const MAX_RECEIPTS = 500

/**
 * What a pass receipt is kept under, each a digest: the commit `HEAD` names,
 * the command as rendered for the visit, the environment the command
 * inherits (`envDigest`), the tree of every file git does not ignore
 * (`inputTree`), and the files it ignores by their stats (`ignoredDigest`).
 * A pass at one key is a pass at any run with the same key. A tool outside
 * the worktree is outside the key.
 */
interface ReceiptKey {
  readonly head: string
  readonly command: string
  readonly env: string
  readonly input: string
  readonly ignored: string
}

/** A kept pass: its output's tail, and the run, visit and time it came from. */
const PassReceipt = Schema.Struct({
  output: Schema.String,
  run: Schema.String,
  visit: Schema.Int,
  at: Schema.Finite,
})
type PassReceipt = typeof PassReceipt.Type

const decodeReceiptRows = Schema.decodeUnknownEffect(Schema.Array(PassReceipt))

/** At most this many machine commands run at once in one server, over every machine. */
const MAX_ACTIVE_MACHINE_COMMANDS = 4

/**
 * The command permits: one per running `run` state's process, held per run
 * from before its `Dispatched` commit to the driver's next read after the
 * command's exit, stop or ask commits. Rounds take
 * none: their lanes admit them by the pace (`ExtensionContext.Accounts`,
 * lanes.md), so a step count would only leave quota unspent. A crashed
 * command never runs again (`recoverCommand`), so a restart owes no permit.
 */
interface CommandPermits {
  /** Takes the run's permit; a run that holds one keeps it. */
  readonly acquire: (run: RunId) => Effect.Effect<void>
  /** Gives the run's permit back; a run that holds none is left alone. */
  readonly release: (run: RunId) => Effect.Effect<void>
}

interface MachineStoreService {
  readonly insert: (
    run: RunRecord,
    started: MachineStep,
  ) => Effect.Effect<void, MachineStorageError>
  readonly read: (run: RunId) => Effect.Effect<Option.Option<Run>, MachineStorageError>
  /**
   * Writes `after` and appends `steps` in one transaction, only while the
   * row is at `before.seq`: the new run, its memo folded over `steps`, or
   * none when another writer moved it first.
   */
  readonly commit: (
    before: Run,
    after: RunRecord,
    steps: ReadonlyArray<MachineStep>,
  ) => Effect.Effect<Option.Option<Run>, MachineStorageError>
  readonly steps: (
    run: RunId,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly at: number; readonly step: MachineStep }>,
    MachineStorageError
  >
  /**
   * The steps of `run` its state visits are read from (`VISIT_TAGS`), from
   * seq `since` through seq `through`, oldest first.
   */
  readonly visitSteps: (
    run: RunId,
    window: { readonly since: number; readonly through: number },
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly at: number; readonly step: MachineStep }>,
    MachineStorageError
  >
  /**
   * The model the newest round of `role` in `run` ran, as its `RoundEnded`
   * step keeps it: the round under review, whichever thread (a retry's, a
   * rerun's) ran it.
   */
  readonly lastRoundModel: (
    run: RunId,
    role: RoleName,
  ) => Effect.Effect<Option.Option<ModelId>, MachineStorageError>
  /** The `Answered` step of one ask, once it was answered. */
  readonly answered: (
    run: RunId,
    askId: AskId,
  ) => Effect.Effect<
    Option.Option<Extract<MachineStep, { readonly _tag: "Answered" }>>,
    MachineStorageError
  >
  /**
   * The `Started`, `RoundEnded` and `Finished` steps of the newest `limit`
   * ended runs of `machine` (final, failed or stopped): newest run first,
   * each run's steps oldest first.
   */
  readonly endedRunsOf: (
    machine: MachineName,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<RunOutcome>, MachineStorageError>
  /** Every ended round, move and finish in every run of `machine`, by run, oldest first. */
  readonly outcomesOf: (
    machine: MachineName,
  ) => Effect.Effect<ReadonlyArray<RunOutcome>, MachineStorageError>
  /** The run and state of the newest round recorded on `thread`. */
  readonly roundOn: (
    thread: SessionId,
  ) => Effect.Effect<
    Option.Option<{ readonly run: RunId; readonly state: StateName }>,
    MachineStorageError
  >
  readonly ownedBy: (thread: SessionId) => Effect.Effect<ReadonlyArray<Run>, MachineStorageError>
  /** The runs a branch hosts that have work left. */
  readonly activeOn: (host: PlaceRecord) => Effect.Effect<ReadonlyArray<Run>, MachineStorageError>
  readonly removeHostSession: (sessionId: SessionId) => Effect.Effect<void, MachineStorageError>
  /** The pass kept under `key`, if one is. */
  readonly receipt: (
    key: ReceiptKey,
  ) => Effect.Effect<Option.Option<PassReceipt>, MachineStorageError>
  /** Keeps a pass under `key`; past `MAX_RECEIPTS` the oldest pass goes. */
  readonly keepReceipt: (
    key: ReceiptKey,
    pass: PassReceipt,
  ) => Effect.Effect<void, MachineStorageError>
  readonly permits: CommandPermits
}

const makeCommandPermits = Effect.fn("MachineStore.commandPermits")(function* () {
  const semaphore = yield* Semaphore.make(MAX_ACTIVE_MACHINE_COMMANDS)
  // The runs that hold a permit.
  const held = new Set<RunId>()
  const lock = yield* Semaphore.make(1)
  const permits: CommandPermits = {
    acquire: Effect.fn("MachineStore.acquireCommand")(function* (run: RunId) {
      if (yield* Effect.sync(() => held.has(run)).pipe(lock.withPermits(1))) return
      const mark = Effect.suspend(() => {
        if (held.has(run)) return semaphore.release(1)
        held.add(run)
        return Effect.void
      }).pipe(lock.withPermits(1))
      // The take and the mark are one step: an interrupt between them would leak a permit.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* semaphore.takeIfAvailable(1))) {
            yield* Effect.logDebug("machines.command.waiting").pipe(Effect.annotateLogs({ run }))
            yield* restore(semaphore.take(1))
          }
          yield* mark
        }),
      )
    }),
    release: Effect.fn("MachineStore.releaseCommand")(function* (run: RunId) {
      yield* Effect.suspend(() => {
        if (!held.delete(run)) return Effect.void
        return semaphore.release(1)
      }).pipe(lock.withPermits(1))
    }),
  }
  return permits
})

const RUN_COLUMNS = `run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
  owner_session_id, owner_branch_id, cwd, input_json, roles_json,
  state, status, pending_json, seq, notified_at, error, created_at, updated_at`

/**
 * The run tables and the command permits. Building it makes the tables
 * when the database lacks them at this version. It is a server resource:
 * one server's machines share the permits.
 */
export class MachineStore extends Context.Service<MachineStore, MachineStoreService>()(
  "@gent/extensions/src/machines/MachineStore",
) {
  static Live: Layer.Layer<MachineStore, MachineStorageError, SqlClient.SqlClient> = Layer.effect(
    MachineStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* ensureMachineTables

      // A run is its row and the fold of its steps up to the row's seq: a
      // commit between the two reads adds steps the row does not name yet.
      const memoOf = Effect.fn("MachineStore.memoOf")(function* (record: RunRecord) {
        const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
          WHERE run = ${record.run} AND seq <= ${record.seq}
            AND (json_extract(step_json, '$._tag') IN (${sql.literal(
              MEMO_TAGS.map((tag) => `'${tag}'`).join(", "),
            )}) OR (json_extract(step_json, '$._tag') = 'Recorded'
              AND json_extract(step_json, '$.action.pr') IS NOT NULL))
          ORDER BY seq ASC`
        const decoded = yield* decodeStepRows(rows).pipe(
          Effect.mapError(storageError("A machine step row does not decode")),
        )
        return foldSteps(
          EMPTY_MEMO,
          decoded.map((row) => row.step_json),
        )
      })
      const decodeRuns = (rows: ReadonlyArray<unknown>) =>
        Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const record = recordOfRow(
              yield* decodeRunRow(row).pipe(
                Effect.mapError(storageError("A machine run row does not decode")),
              ),
            )
            return { ...record, ...(yield* memoOf(record)) } satisfies Run
          }),
        )

      const permits = yield* makeCommandPermits()

      const insertSteps = (run: RunId, from: number, steps: ReadonlyArray<MachineStep>) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          let seq = from
          let state = StateName.make("start")
          for (const step of steps) {
            seq += 1
            state = stateOfStep(step, state)
            const stepJson = yield* encodeStep(step)
            yield* sql`INSERT INTO machine_steps (run, seq, at, state, step_json)
              VALUES (${run}, ${seq}, ${at}, ${state}, ${stepJson})`
          }
        })

      return MachineStore.of({
        insert: Effect.fn("MachineStore.insert")(
          function* (run, started) {
            const inputJson = yield* encodeInput(run.input)
            const rolesJson = yield* encodeRoles(run.roles)
            const now = yield* Clock.currentTimeMillis
            yield* Effect.gen(function* () {
              const inserted = yield* sql`INSERT INTO machine_runs (
                  run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
                  cwd, input_json, roles_json, state, status, seq,
                  created_at, updated_at
                ) VALUES (
                  ${run.run}, ${run.machine}, ${run.definitionJson}, ${run.host.sessionId},
                  ${run.host.branchId}, ${run.ownerThread}, ${run.cwd}, ${inputJson},
                  ${rolesJson}, ${run.state}, ${run.status}, 1,
                  ${now}, ${now}
                ) ON CONFLICT (run) DO NOTHING RETURNING run`
              if (inserted.length === 0) return
              yield* insertSteps(run.run, 0, [started])
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to insert a machine run")),
        ),
        read: Effect.fn("MachineStore.read")(
          function* (run) {
            const rows = yield* sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM machine_runs
              WHERE run = ${run} LIMIT 1`
            const runs = yield* decodeRuns(rows)
            return Option.fromUndefinedOr(runs[0])
          },
          Effect.mapError(storageError("Failed to read a machine run")),
        ),
        commit: Effect.fn("MachineStore.commit")(
          function* (before, after, steps) {
            const rolesJson = yield* encodeRoles(after.roles)
            const pendingJson = yield* Option.match(after.pending, {
              onNone: () => Effect.succeed(Option.none<string>()),
              onSome: (action) => Effect.asSome(encodePending(action)),
            })
            const now = yield* Clock.currentTimeMillis
            const seq = before.seq + steps.length
            const place = after.deliveryPlace
            return yield* Effect.gen(function* () {
              const updated = yield* sql`UPDATE machine_runs SET
                  state = ${after.state},
                  status = ${after.status},
                  pending_json = ${Option.getOrNull(pendingJson)},
                  roles_json = ${rolesJson},
                  owner_session_id = ${Option.getOrNull(Option.map(place, (found) => found.sessionId))},
                  owner_branch_id = ${Option.getOrNull(Option.map(place, (found) => found.branchId))},
                  notified_at = ${Option.getOrNull(after.notifiedAt)},
                  error = ${Option.getOrNull(after.error)},
                  seq = ${seq},
                  updated_at = ${now}
                WHERE run = ${before.run} AND seq = ${before.seq}
                RETURNING run`
              if (updated.length === 0) return Option.none<Run>()
              yield* insertSteps(before.run, before.seq, steps)
              const memo = foldSteps(
                {
                  visits: before.visits,
                  context: before.context,
                  lastMove: before.lastMove,
                  owed: before.owed,
                  prBranchHead: before.prBranchHead,
                },
                steps,
              )
              return Option.some<Run>({ ...after, ...memo, seq })
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to commit a machine step")),
        ),
        steps: Effect.fn("MachineStore.steps")(
          function* (run, limit) {
            // A saved value is the round's text again: the view leaves it out.
            const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
              WHERE run = ${run} AND json_extract(step_json, '$._tag') != 'Saved'
              ORDER BY seq DESC LIMIT ${limit}`
            const decoded = yield* decodeStepRows(rows)
            return decoded
              .map((row) => ({ seq: row.seq, at: row.at, step: row.step_json }))
              .toReversed()
          },
          Effect.mapError(storageError("Failed to read machine steps")),
        ),
        visitSteps: Effect.fn("MachineStore.visitSteps")(
          function* (run, window) {
            // The primary key (run, seq) bounds the read to the window.
            const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
              WHERE run = ${run} AND seq >= ${window.since} AND seq <= ${window.through}
                AND json_extract(step_json, '$._tag') IN (${sql.literal(
                  VISIT_TAGS.map((tag) => `'${tag}'`).join(", "),
                )})
              ORDER BY seq ASC`
            const decoded = yield* decodeStepRows(rows)
            return decoded.map((row) => ({ seq: row.seq, at: row.at, step: row.step_json }))
          },
          Effect.mapError(storageError("Failed to read a run's visits")),
        ),
        lastRoundModel: Effect.fn("MachineStore.lastRoundModel")(
          function* (run, role) {
            const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
              WHERE run = ${run}
                AND json_extract(step_json, '$._tag') = 'RoundEnded'
                AND json_extract(step_json, '$.role') = ${role}
                AND json_extract(step_json, '$.model') IS NOT NULL
              ORDER BY seq DESC LIMIT 1`
            const decoded = yield* decodeStepRows(rows)
            return Option.flatMap(Option.fromUndefinedOr(decoded[0]), (row) => {
              const step = row.step_json
              if (step._tag !== "RoundEnded") return Option.none()
              return Option.fromUndefinedOr(step.model)
            })
          },
          Effect.mapError(storageError("Failed to read a role's last round")),
        ),
        answered: Effect.fn("MachineStore.answered")(
          function* (run, askId) {
            const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
              WHERE run = ${run}
                AND json_extract(step_json, '$._tag') = 'Answered'
                AND json_extract(step_json, '$.askId') = ${askId}
              ORDER BY seq ASC LIMIT 1`
            const decoded = yield* decodeStepRows(rows)
            return Option.flatMap(Option.fromUndefinedOr(decoded[0]), (row) => {
              const step = row.step_json
              if (step._tag !== "Answered") return Option.none()
              return Option.some(step)
            })
          },
          Effect.mapError(storageError("Failed to read an answer")),
        ),
        endedRunsOf: Effect.fn("MachineStore.endedRunsOf")(
          function* (machine, limit) {
            const rows = yield* sql`SELECT s.run, s.seq, s.at, s.step_json FROM (
                SELECT run, updated_at FROM machine_runs
                WHERE machine = ${machine} AND status IN ('final', 'failed', 'stopped')
                ORDER BY updated_at DESC, run DESC LIMIT ${limit}
              ) r
              JOIN machine_steps s ON s.run = r.run
              WHERE json_extract(s.step_json, '$._tag') IN ('Started', 'RoundEnded', 'Finished')
              ORDER BY r.updated_at DESC, r.run DESC, s.seq ASC`
            const decoded = yield* decodeOutcomeRows(rows)
            return decoded.map((row) => ({ run: row.run, step: row.step_json }))
          },
          Effect.mapError(storageError("Failed to read a machine's ended runs")),
        ),
        outcomesOf: Effect.fn("MachineStore.outcomesOf")(
          function* (machine) {
            const rows = yield* sql`SELECT s.run, s.seq, s.at, s.step_json FROM machine_runs r
              JOIN machine_steps s ON s.run = r.run
              WHERE r.machine = ${machine}
                AND json_extract(s.step_json, '$._tag') IN ('RoundEnded', 'Moved', 'Finished')
              ORDER BY s.run ASC, s.seq ASC`
            const decoded = yield* decodeOutcomeRows(rows)
            return decoded.map((row) => ({ run: row.run, step: row.step_json }))
          },
          Effect.mapError(storageError("Failed to read a machine's outcomes")),
        ),
        roundOn: Effect.fn("MachineStore.roundOn")(
          function* (thread) {
            const rows = yield* sql`SELECT run, seq, at, step_json FROM machine_steps
              WHERE json_extract(step_json, '$._tag') = 'Recorded'
                AND json_extract(step_json, '$.action.thread') = ${thread}
              ORDER BY at DESC, seq DESC LIMIT 1`
            const decoded = yield* decodeOutcomeRows(rows)
            return Option.flatMap(Option.fromUndefinedOr(decoded[0]), (row) => {
              const step = row.step_json
              if (step._tag !== "Recorded") return Option.none()
              return Option.some({ run: row.run, state: step.action.state })
            })
          },
          Effect.mapError(storageError("Failed to find a thread's round")),
        ),
        ownedBy: Effect.fn("MachineStore.ownedBy")(
          function* (thread) {
            const rows = yield* sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM machine_runs
              WHERE owner_thread = ${thread} ORDER BY created_at DESC, run DESC`
            return yield* decodeRuns(rows)
          },
          Effect.mapError(storageError("Failed to list machine runs")),
        ),
        activeOn: Effect.fn("MachineStore.activeOn")(
          function* (host) {
            const rows = yield* sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM machine_runs
              WHERE host_session_id = ${host.sessionId} AND host_branch_id = ${host.branchId}
                AND (status IN ('running','asking') OR notified_at IS NULL)
              ORDER BY created_at ASC, run ASC`
            return yield* decodeRuns(rows)
          },
          Effect.mapError(storageError("Failed to list a branch's machine runs")),
        ),
        removeHostSession: Effect.fn("MachineStore.removeHostSession")(
          function* (sessionId) {
            yield* Effect.gen(function* () {
              yield* sql`DELETE FROM machine_steps WHERE run IN (
                SELECT run FROM machine_runs WHERE host_session_id = ${sessionId})`
              yield* sql`DELETE FROM machine_runs WHERE host_session_id = ${sessionId}`
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to remove a session's machine runs")),
        ),
        receipt: Effect.fn("MachineStore.receipt")(
          function* (key) {
            const rows = yield* sql`SELECT output, run, visit, at FROM machine_receipts
              WHERE head = ${key.head} AND command = ${key.command} AND env = ${key.env}
                AND input = ${key.input} AND ignored = ${key.ignored} AND exit_code = 0`
            const decoded = yield* decodeReceiptRows(rows)
            return Option.fromUndefinedOr(decoded[0])
          },
          Effect.mapError(storageError("Failed to read a pass receipt")),
        ),
        keepReceipt: Effect.fn("MachineStore.keepReceipt")(
          function* (key, pass) {
            yield* Effect.gen(function* () {
              yield* sql`INSERT INTO machine_receipts
                  (head, command, env, input, ignored, run, visit, exit_code, output, at)
                VALUES (${key.head}, ${key.command}, ${key.env}, ${key.input}, ${key.ignored},
                  ${pass.run}, ${pass.visit}, 0, ${pass.output}, ${pass.at})
                ON CONFLICT (head, command, env, input, ignored)
                DO UPDATE SET exit_code = 0, run = excluded.run, visit = excluded.visit,
                  output = excluded.output, at = excluded.at`
              yield* sql`DELETE FROM machine_receipts WHERE rowid NOT IN (
                SELECT rowid FROM machine_receipts ORDER BY at DESC, rowid DESC LIMIT ${MAX_RECEIPTS})`
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to keep a pass receipt")),
        ),
        permits,
      })
    }),
  )
}

const MachineStoreResource = defineResource({
  id: "@gent/machines/store",
  scope: "server",
  layer: MachineStore.Live,
})

// ── drivers ─────────────────────────────────────────────────────────────────

/** A driver's wake-up: one is enough, so its queue keeps one. */
const POKE = "poke"
type Poke = typeof POKE

interface MachineDriversService {
  /**
   * Activates a run's driver under the lifecycle lock: a running driver gets
   * a poke, else `launch` starts one with its poke queue.
   */
  readonly arm: (
    run: RunId,
    launch: (pokes: Queue.Queue<Poke>) => Effect.Effect<void>,
  ) => Effect.Effect<void>
  /** Wakes the run's driver, if one runs here. */
  readonly poke: (run: RunId) => Effect.Effect<void>
  /**
   * The driver's exit, under the same lock as `arm`: true (and the driver
   * leaves the map) only when `stillDone` holds of the row read now.
   */
  readonly retire: (
    run: RunId,
    pokes: Queue.Queue<Poke>,
    stillDone: Effect.Effect<boolean, MachineStorageError>,
  ) => Effect.Effect<boolean, MachineStorageError>
  /** Forks a run's command into the branch scope under its run; one at a time. */
  readonly runCommand: (run: RunId, work: Effect.Effect<void>) => Effect.Effect<void>
  /** The run's command fiber in this process, if one runs. */
  readonly command: (run: RunId) => Effect.Effect<Option.Option<Fiber.Fiber<void>>>
}

/**
 * The host branch's drivers and their commands: bound to the branch scope,
 * so a passivation or a shutdown ends them with it, and a command's process
 * group with its fiber.
 */
class MachineDrivers extends Context.Service<MachineDrivers, MachineDriversService>()(
  "@gent/extensions/src/machines/MachineDrivers",
) {
  static Live: Layer.Layer<MachineDrivers> = Layer.effect(
    MachineDrivers,
    Effect.gen(function* () {
      const fibers = yield* FiberSet.make<void>()
      const commands = yield* FiberMap.make<RunId, void, never>()
      const pokes = new Map<RunId, Queue.Queue<Poke>>()
      const lifecycle = yield* Semaphore.make(1)
      const locked = <A, E>(work: Effect.Effect<A, E>) =>
        work.pipe(Effect.uninterruptible, lifecycle.withPermits(1))
      return MachineDrivers.of({
        arm: Effect.fn("MachineDrivers.arm")(function* (run, launch) {
          yield* locked(
            Effect.gen(function* () {
              const running = pokes.get(run)
              if (Predicate.isNotUndefined(running)) return yield* Queue.offer(running, POKE)
              const queue = yield* Queue.sliding<Poke>(1)
              pokes.set(run, queue)
              yield* FiberSet.run(
                fibers,
                launch(queue).pipe(
                  // A driver that ends any other way leaves the map too, so the next arm starts one.
                  Effect.ensuring(
                    locked(
                      Effect.sync(() => {
                        if (pokes.get(run) === queue) pokes.delete(run)
                      }),
                    ),
                  ),
                ),
              )
            }),
          )
        }),
        poke: Effect.fn("MachineDrivers.poke")(function* (run) {
          const queue = pokes.get(run)
          if (Predicate.isNotUndefined(queue)) yield* Queue.offer(queue, POKE)
        }),
        retire: Effect.fn("MachineDrivers.retire")(function* (run, queue, stillDone) {
          return yield* stillDone.pipe(
            Effect.tap((done) =>
              Effect.sync(() => {
                if (done && pokes.get(run) === queue) pokes.delete(run)
              }),
            ),
            Effect.uninterruptible,
            lifecycle.withPermits(1),
          )
        }),
        runCommand: Effect.fn("MachineDrivers.runCommand")(function* (run, work) {
          yield* FiberMap.run(commands, run, work, { onlyIfMissing: true })
        }),
        command: Effect.fn("MachineDrivers.command")(function* (run) {
          return yield* FiberMap.get(commands, run)
        }),
      })
    }),
  )
}

const MachineDriversResource = defineResource({
  id: "@gent/machines/drivers",
  scope: "branch",
  layer: MachineDrivers.Live,
})

/** The services a driver runs against, captured where it is armed. */
type DriverServices =
  | ExtensionContext
  | MachineStore
  | MachineDrivers
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner
  | GentPlatform

/** The pending action runs a command, which holds a command permit. */
const runsCommand = (pending: Option.Option<PendingAction>) =>
  Option.exists(pending, Predicate.isTagged("Command"))

/** When the pending round or push may be sent: none when it does not wait. */
const waitsUntil = (pending: Option.Option<PendingAction>, now: number) =>
  Option.flatMap(pending, (action) => {
    if (action._tag !== "Round" && action._tag !== "Integrate") return Option.none()
    if (Predicate.isUndefined(action.notBefore)) return Option.none()
    return Option.liftPredicate(action.notBefore, (until) => until > now)
  })

/** A pushed integrate: the run waits for CI on the gate, or for a person on its PR, holding nothing. */
const watchesGate = (pending: Option.Option<PendingAction>) =>
  Option.exists(
    pending,
    (action) =>
      action._tag === "Integrate" &&
      (Predicate.isNotUndefined(action.generation) || Predicate.isNotUndefined(action.pr)),
  )

/** A running run that takes a step now: not one that waits for its account or for CI. */
const takesStep = (run: Run, now: number) =>
  run.status === "running" &&
  Option.isNone(waitsUntil(run.pending, now)) &&
  !watchesGate(run.pending)

/** A row whose end is settled and whose seq is the one the driver last acted on. */
const isDone = (run: Run, seq: number) =>
  isTerminal(run.status) && Option.isSome(run.notifiedAt) && run.seq === seq

/** How long a refused send (a busy thread) waits for a round end before it tries again. */
const REFUSED_SEND_WAIT = Duration.seconds(30)

/** A failed step is tried again after this, twice as long each time, at most `STEP_RETRY_MAX`. */
const STEP_RETRY_BASE = Duration.seconds(1)
const STEP_RETRY_MAX = Duration.seconds(30)

/** A command's default bound; past it the command takes `fail`. */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 3_600

/** The output tail a command saves into the context. */
const OUTPUT_TAIL_CHARS = 8_000

const WORKER_AGENT = AgentName.make("worker")

interface Signals {
  readonly pokes: Queue.Queue<Poke>
  /** That a round end came since the last take: one slot, filled from the subscription. */
  readonly ends: Option.Option<Queue.Dequeue<void>>
}

/**
 * Drains `subscription` as each end comes, into one slot: a waiter learns
 * that an end came, and the driver then reads its row, so no backlog is
 * kept while the run asks, runs a command or waits for a command permit.
 */
export const roundEndSignal = (subscription: PubSub.Subscription<unknown>) =>
  Effect.gen(function* () {
    const slot = yield* Queue.sliding<void>(1)
    yield* PubSub.take(subscription).pipe(
      Effect.andThen(Queue.offer(slot, void 0)),
      Effect.forever,
      Effect.forkScoped,
    )
    return slot
  })

/** Waits for a poke, and with `ends` for any round end too, at most `within`. */
const awaitSignal = (
  signals: Signals,
  options: { readonly ends: boolean; readonly within?: Duration.Input },
) => {
  const waits: Array<Effect.Effect<void>> = [Effect.asVoid(Queue.take(signals.pokes))]
  if (options.ends && Option.isSome(signals.ends)) {
    waits.push(Queue.take(signals.ends.value))
  }
  if (Predicate.isNotUndefined(options.within)) waits.push(Effect.sleep(options.within))
  return Effect.raceAll(waits)
}

const definitionOf = (run: Run) =>
  Effect.fromOption(
    decodeDefinitionJson(run.definitionJson),
    () => new MachineFault({ message: "The run's definition no longer decodes" }),
  )

const stateIn = (definition: MachineDefinition, name: StateName) =>
  Effect.fromOption(
    Option.fromUndefinedOr(definition.states[name]),
    () => new MachineFault({ message: `The run is in no state ${name}` }),
  )

const capOf = (state: ThreadState | RunState | IntegrateState) =>
  state.maxVisits ?? DEFAULT_MAX_VISITS

const visitsOf = (visits: Visits, state: StateName) => visits.counts[state] ?? 0

const visited = (visits: Visits, state: StateName): Visits => ({
  ...visits,
  counts: { ...visits.counts, [state]: visitsOf(visits, state) + 1 },
})

const EMPTY_MEMO: RunMemo = {
  visits: { counts: {}, grants: {} },
  context: { last: {}, all: {} },
  lastMove: Option.none(),
  owed: new Set(),
  prBranchHead: Option.none(),
}

/** The owed ask states after `step`: a dispatch with `requires` adds, a met answer removes. */
const owedAfter = (owed: ReadonlySet<string>, step: MachineStep): ReadonlySet<string> => {
  if (step._tag === "Dispatched" && step.action._tag === "Ask") {
    if (Predicate.isUndefined(step.action.requires) || owed.has(step.action.state)) return owed
    return new Set([...owed, step.action.state])
  }
  if (step._tag === "Moved" && step.met === true && owed.has(step.from)) {
    return new Set([...owed].filter((state) => state !== step.from))
  }
  return owed
}

/**
 * One step's change to the memo. A state's visits are the highest visit its
 * dispatched actions name (a resumed round dispatches its visit again), and
 * a final state's `Finished` is its visit; an exhausted ask names the visit
 * its cap refused, so it counts none.
 */
const foldStep = (memo: RunMemo, step: MachineStep): RunMemo => {
  switch (step._tag) {
    case "Dispatched": {
      const action = step.action
      const owed = owedAfter(memo.owed, step)
      if (action._tag === "Ask" && action.reason === "exhausted") return { ...memo, owed }
      if (action.visit <= visitsOf(memo.visits, action.state)) return { ...memo, owed }
      const counts = { ...memo.visits.counts, [action.state]: action.visit }
      return { ...memo, owed, visits: { ...memo.visits, counts } }
    }
    case "Finished":
      return { ...memo, visits: visited(memo.visits, step.state) }
    case "Granted": {
      const grants = memo.visits.grants
      const granted = { ...grants, [step.state]: (grants[step.state] ?? 0) + 1 }
      return { ...memo, visits: { ...memo.visits, grants: granted } }
    }
    case "Saved":
      return { ...memo, context: saved(memo.context, step.state, step.value) }
    case "Moved":
      return { ...memo, lastMove: Option.some(step), owed: owedAfter(memo.owed, step) }
    case "Recorded": {
      const action = step.action
      if (action._tag !== "Integrate" || Predicate.isUndefined(action.pr)) return memo
      return { ...memo, prBranchHead: Option.fromUndefinedOr(action.sha) }
    }
    default:
      return memo
  }
}

/** The memo after `steps`: from `EMPTY_MEMO` it is the whole run's. */
const foldSteps = (memo: RunMemo, steps: ReadonlyArray<MachineStep>): RunMemo =>
  steps.reduce(foldStep, memo)

/** The steps `foldStep` reads: a read of the memo loads only these, and a PR's `Recorded`. */
const MEMO_TAGS = ["Dispatched", "Finished", "Granted", "Saved", "Moved"] as const

/**
 * The steps `stateVisits` reads: a visit's start, its receipts, its rounds,
 * its answer, its move, and the run's end.
 */
const VISIT_TAGS = [
  "Dispatched",
  "Recorded",
  "RoundEnded",
  "Answered",
  "Moved",
  "Finished",
  "Stopped",
  "Failed",
] as const

/** The choices an ask offers, by its reason and its state (the table in the design, B2). */
const choicesOf = (
  state: MachineState,
  reason: AskReason,
  mayStillRun: boolean,
): ReadonlyArray<Verdict> => {
  const keys = (on: Readonly<Record<string, StateName>>) =>
    Object.keys(on).map((key) => Verdict.make(key))
  const control = (words: ReadonlyArray<string>) => words.map((word) => Verdict.make(word))
  switch (state.kind) {
    case "ask":
      return keys(state.on)
    case "thread":
      if (Predicate.isNotUndefined(state.on))
        return [...keys(state.on), ...control(["retry", "stop"])]
      return control(["continue", "retry", "stop"])
    case "run": {
      const ends = [
        "pass",
        "fail",
        ...Option.toArray(Option.as(Option.fromUndefinedOr(state.on.error), "error")),
      ]
      if (reason === "interrupted" && mayStillRun) return control([...ends, "stop"])
      return control([...ends, "retry", "stop"])
    }
    case "integrate":
      return control(["green", "red", "retry", "stop"])
    case "final":
      return []
  }
}

/** Whether a visit of a thread state starts a new thread. */
const isFresh = (state: ThreadState, visit: number) => {
  if (Predicate.isUndefined(state.fresh)) return false
  if (Predicate.isBoolean(state.fresh)) return state.fresh
  return visit >= state.fresh
}

const askIdOf = (run: RunId, seq: number) => AskId.make(`${run}:${seq}`)

/** The pending ask, its steps with its `Dispatched` step last, committed as one move. */
const askingRun = (
  run: Run,
  input: {
    readonly state: MachineState
    readonly name: StateName
    readonly visit: number
    readonly reason: AskReason
    readonly lead: ReadonlyArray<MachineStep>
    readonly mayStillRun?: boolean
    /** The ask state's requirement as this visit applies it (`appliedRequirement`). */
    readonly requires?: AppliedRequirement
  },
) => {
  const mayStillRun = input.mayStillRun === true
  const steps: Array<MachineStep> = [...input.lead]
  const action: AskAction = PendingAction.cases.Ask.make({
    state: input.name,
    visit: input.visit,
    askId: askIdOf(run.run, run.seq + steps.length + 1),
    reason: input.reason,
    choices: choicesOf(input.state, input.reason, mayStillRun),
    ...omitUndefined({
      mayStillRun: Option.getOrUndefined(Option.liftPredicate(mayStillRun, Boolean)),
      requires: input.requires,
    }),
  })
  steps.push(MachineStep.cases.Dispatched.make({ action }))
  const after: RunRecord = {
    ...run,
    status: "asking",
    pending: Option.some(action),
  }
  return { after, steps }
}

const replySpecOf = (on: Readonly<Record<string, StateName>>) =>
  `{ "next": ${Object.keys(on)
    .map((key) => `"${key}"`)
    .join(" | ")} } and any other fields the round asks for`

const threadsOf = Effect.gen(function* () {
  const threads = yield* Effect.serviceOption(Threads)
  return yield* Effect.fromOption(
    threads,
    () => new MachineFault({ message: "Machines need the threads of @gent/session-tools" }),
  )
})

/** A failure Threads gives for good (an unknown agent, a session gone) fails the run. */
const threadFault = <E>(error: E) => {
  if (Predicate.isTagged(error, "ThreadError") && Predicate.hasProperty(error, "message")) {
    return new MachineFault({ message: `Threads refused: ${String(error.message)}` })
  }
  return error
}

const isWaitRefusal = (error: unknown): error is ThreadBusy => Schema.is(ThreadBusy)(error)

/** One driver iteration's outcome: go on reading the row, or leave. */
const AGAIN = false
const RETIRE = true

/**
 * The driver of one run on its host branch. It subscribes to the round ends
 * before its first read, then loops: read the row, take the one move the row
 * asks for, and read again. It holds the branch resident while the run is
 * running, and nothing while it asks or its round waits for the account. It leaves only from a row whose end is
 * settled, under the lifecycle lock `arm` takes, after it reads the row
 * once more.
 */
const drive = (run: RunId, pokes: Queue.Queue<Poke>) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const store = yield* MachineStore
    const drivers = yield* MachineDrivers
    const threads = yield* Effect.serviceOption(Threads)
    const ends: Option.Option<Queue.Dequeue<void>> = yield* Option.match(threads, {
      onNone: () => Effect.succeedNone,
      onSome: (service) =>
        Effect.asSome(Effect.flatMap(service.subscribeRoundEnds, roundEndSignal)),
    })
    const signals: Signals = { pokes, ends }
    // The hold on the host's loop, open while the run is running.
    const held = yield* Ref.make(Option.none<Scope.Closeable>())
    const hold = (running: boolean) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(held)
        if (running && Option.isNone(current)) {
          const scope = yield* Scope.make()
          yield* ctx.Session.holdResident.pipe(Effect.provideService(Scope.Scope, scope))
          yield* Ref.set(held, Option.some(scope))
        }
        if (!running && Option.isSome(current)) {
          yield* Ref.set(held, Option.none())
          yield* Scope.close(current.value, Exit.void)
        }
      })
    yield* Effect.addFinalizer(() => hold(false).pipe(Effect.andThen(store.permits.release(run))))
    let failures = 0
    let seen = -1
    while (true) {
      const found = yield* store.read(run).pipe(Effect.option, Effect.map(Option.flatten))
      if (Option.isSome(found)) seen = found.value.seq
      const outcome = yield* Option.match(found, {
        // A run whose row went (its host session was deleted) has nothing left.
        onNone: () => Effect.succeed(RETIRE),
        onSome: (current) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => hold(takesStep(current, now))),
            Effect.andThen(advance(current, signals)),
          ),
      }).pipe(
        Effect.tap(() => Effect.sync(() => (failures = 0))),
        Effect.catchTag("MachineFault", (fault) =>
          failRun(run, fault.message).pipe(Effect.as(AGAIN)),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          failures += 1
          const delay = Duration.min(
            Duration.times(STEP_RETRY_BASE, 2 ** Math.min(failures - 1, 5)),
            STEP_RETRY_MAX,
          )
          return Effect.logWarning("machines.step.failed").pipe(
            Effect.annotateLogs({ run, attempt: failures, cause: Cause.pretty(cause) }),
            Effect.andThen(awaitSignal(signals, { ends: false, within: delay })),
            Effect.as(AGAIN),
          )
        }),
      )
      if (outcome !== RETIRE) continue
      const leaving = yield* drivers.retire(
        run,
        pokes,
        Effect.map(store.read(run), (row) =>
          Option.match(row, { onNone: () => true, onSome: (current) => isDone(current, seen) }),
        ),
      )
      if (leaving) return
    }
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.logWarning("machines.driver.ended").pipe(
        Effect.annotateLogs({ run, cause: Cause.pretty(cause) }),
      ),
    ),
  )

/** Starts the run's driver on this branch, or pokes the one that runs. */
const armDriver = Effect.fn("Machines.arm")(function* (run: RunId) {
  const drivers = yield* MachineDrivers
  // The driver outlives this call, so it keeps the services it runs against.
  const services = yield* Effect.context<DriverServices>()
  yield* drivers.arm(run, (pokes) => drive(run, pokes).pipe(Effect.provideContext(services)))
})

/** Commits a move, or finds the row moved: the next read decides. */
const commitMove = (before: Run, after: RunRecord, steps: ReadonlyArray<MachineStep>) =>
  Effect.flatMap(MachineStore, (store) => store.commit(before, after, steps))

/**
 * A fault the run cannot ask about: it fails, and its end is told to the
 * owner. A pending push loses its gate first, so a failure that cannot
 * release it fails again on the next try instead of leaving the gate held.
 */
const failRun = Effect.fn("Machines.fail")(function* (run: RunId, error: string) {
  const store = yield* MachineStore
  const found = yield* store.read(run)
  if (Option.isNone(found) || isTerminal(found.value.status)) return
  const current = found.value
  const pending = current.pending
  if (Option.isSome(pending) && pending.value._tag === "Integrate") {
    yield* releaseGate(pending.value)
  }
  yield* Effect.logWarning("machines.run.failed").pipe(Effect.annotateLogs({ run, error }))
  yield* store.commit(
    current,
    { ...current, status: "failed", pending: Option.none(), error: Option.some(error) },
    [MachineStep.cases.Failed.make({ error })],
  )
})

/** One move of the run the row asks for; `RETIRE` once its end is settled. */
const advance = (run: Run, signals: Signals) =>
  Effect.gen(function* () {
    const store = yield* MachineStore
    if (!runsCommand(run.pending)) yield* store.permits.release(run.run)
    switch (run.status) {
      case "final":
      case "failed":
        if (Option.isNone(run.notifiedAt)) {
          yield* notifyEnd(run)
          return AGAIN
        }
        yield* withdrawWake(run)
        return RETIRE
      case "stopped":
        if (Option.isNone(run.notifiedAt)) {
          yield* settleStop(run)
          return AGAIN
        }
        yield* withdrawWake(run)
        return RETIRE
      case "asking":
      case "running":
        break
    }
    if (Option.isNone(run.pending)) {
      if (run.status === "asking") {
        yield* awaitSignal(signals, { ends: false })
        return AGAIN
      }
      yield* enter(run, signals)
      return AGAIN
    }
    yield* advancePending(run, signals)(run.pending.value)
    return AGAIN
  })

/** The move a pending action asks for. */
const advancePending = (run: Run, signals: Signals) =>
  Match.type<PendingAction>().pipe(
    Match.tagsExhaustive({
      Ask: (pending) => {
        if (Predicate.isUndefined(pending.deliveredAt)) return deliverAsk(run, pending)
        // An asking driver stays: the answer commits, then kicks it.
        return awaitSignal(signals, { ends: false })
      },
      Round: (pending) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Option.match(waitsUntil(Option.some(pending), now), {
            onSome: (until) => waitOut(run, until, signals),
            onNone: () => resumeRound(run, pending, signals),
          }),
        ),
      Command: (pending) => awaitCommand(run, pending, signals),
      Integrate: (pending) => advanceIntegrate(run, pending, signals),
    }),
  )

/** A wait whose time came is dispatched again, without its marker, before its send. */
const resumeRound = Effect.fn("Machines.resumeRound")(function* (
  run: Run,
  pending: RoundAction,
  signals: Signals,
) {
  const { notBefore, ...ready } = pending
  if (Predicate.isUndefined(notBefore)) return yield* awaitRound(run, pending, signals)
  const action = PendingAction.cases.Round.make(ready)
  const committed = yield* commitMove(run, { ...run, pending: Option.some(action) }, [
    MachineStep.cases.Dispatched.make({ action }),
  ])
  if (Option.isSome(committed)) yield* awaitRound(committed.value, action, signals)
})

/** Waits for the command this process runs, or recovers one no fiber here runs. */
const awaitCommand = Effect.fn("Machines.awaitCommand")(function* (
  run: Run,
  pending: CommandAction,
  signals: Signals,
) {
  const store = yield* MachineStore
  const drivers = yield* MachineDrivers
  const fiber = yield* drivers.command(run.run)
  if (Option.isNone(fiber)) return yield* recoverCommand(run, pending)
  yield* store.permits.acquire(run.run)
  yield* Effect.raceAll([
    Effect.asVoid(Fiber.await(fiber.value)),
    Effect.asVoid(Queue.take(signals.pokes)),
  ])
})

/**
 * A round that waits for its account: the run's record fires at `until`, so
 * a passivation or a restart while it waits loses nothing, and the driver
 * sleeps until then or a poke (a stop), holding no permit and no residency.
 */
const waitOut = Effect.fn("Machines.waitOut")(function* (
  run: Run,
  until: number,
  signals: Signals,
) {
  const ctx = yield* ExtensionContext
  yield* ctx.Session.wakeAt({ ...run.host, sourceId: runSource(run.run), at: until })
  const store = yield* MachineStore
  const current = yield* store.read(run.run)
  // A stop or a newer wait can commit while this stale arm replaces its kick.
  if (Option.isNone(current) || current.value.seq !== run.seq) return
  const now = yield* Clock.currentTimeMillis
  yield* awaitSignal(signals, { ends: false, within: Duration.millis(until - now) })
})

/**
 * The pending round waits until `until`, at the same visit and attempt, its
 * `Waiting` step after `lead`: a refusal of the same round again moves its
 * time, and enters nothing.
 */
const waitForAccount = (
  run: Run,
  action: RoundAction,
  wait: { readonly until: number; readonly reason: "lane" | "quota" | "sabbath" },
  lead: ReadonlyArray<MachineStep> = [],
) =>
  Effect.logInfo("machines.round.waiting").pipe(
    Effect.annotateLogs({ run: run.run, state: action.state, ...wait }),
    Effect.andThen(
      commitMove(
        run,
        {
          ...run,
          pending: Option.some(
            PendingAction.cases.Round.make({ ...action, notBefore: wait.until }),
          ),
        },
        [...lead, MachineStep.cases.Waiting.make({ state: action.state, ...wait })],
      ),
    ),
  )

/** The wait reason of each lane refusal's reason. */
const LANE_WAIT_REASON = { spent: "lane", sabbath: "sabbath" } as const

/** The wait a lane refusal sets: until its time, for the Sabbath or for spent windows. */
const laneWait = (refused: LaneUnavailable) => ({
  until: refused.retryAt,
  reason: LANE_WAIT_REASON[refused.reason],
})

// ── integrate ───────────────────────────────────────────────────────────────

/** How long a push the gate did not admit (not clear, gh unready) waits before it is tried again. */
const GATE_RETRY_WAIT = Duration.minutes(1)

const integrationOf = Effect.gen(function* () {
  const integration = yield* Effect.serviceOption(Integration)
  return yield* Effect.fromOption(
    integration,
    () => new MachineFault({ message: "An integrate state needs the gate of @gent/integration" }),
  )
})

const integrateStateOf = Effect.fn("Machines.integrateStateOf")(function* (
  run: Run,
  name: StateName,
) {
  const state = yield* stateIn(yield* definitionOf(run), name)
  if (state.kind !== "integrate") {
    return yield* new MachineFault({ message: `${name} is not an integrate state` })
  }
  return state
})

/**
 * Each integrate state's remote names a GitHub repository: a run without
 * one fails at its start, not at its push after every round.
 */
const checkRemotes = Effect.fn("Machines.checkRemotes")(function* (
  definition: MachineDefinition,
  cwd: string,
) {
  const integrates = Object.entries(definition.states).flatMap(([name, state]) => {
    if (state.kind !== "integrate") return []
    return [{ name, remote: state.remote ?? "origin" }]
  })
  if (integrates.length === 0) return
  const integration = yield* integrationOf.pipe(
    Effect.mapError((error) => new MachineError({ message: error.message })),
  )
  for (const { name, remote } of integrates) {
    yield* integration
      .repoOf({ cwd, remote })
      .pipe(
        Effect.mapError(
          (error) => new MachineError({ message: `${name} cannot push: ${error.message}` }),
        ),
      )
  }
})

/** The config roles thread role `name` may run: its own, then each state's switches. */
const configRolesOf = (definition: MachineDefinition, name: RoleName): ReadonlyArray<string> => {
  const own = Option.toArray(Option.fromUndefinedOr(definition.threads[name]?.role))
  if (own.length === 0) return []
  const switched = Object.values(definition.states).flatMap((state) => {
    if (state.kind !== "thread" || state.thread !== name) return []
    return (state.switches ?? []).map((each) => each.role)
  })
  return [...new Set([...own, ...switched])]
}

/**
 * Each config role the definition's thread roles run (a state's switches
 * among them) is named in the config of `cwd` and lists a model, each once;
 * a role `against` another lists models of two makers, and each role the
 * other may run only models of known makers, so a pick can always leave the
 * other role's maker out. A run fails here at its start, not at a round
 * that could never run.
 */
const checkRoles = Effect.fn("Machines.checkRoles")(function* (
  definition: MachineDefinition,
  cwd: string,
) {
  for (const [name, thread] of Object.entries(definition.threads)) {
    for (const role of configRolesOf(definition, RoleName.make(name))) {
      yield* checkRole(definition, cwd, name, thread, role)
    }
  }
})

/** The config role of `cwd` named `role`, a machine error when config fails. */
const resolveRole = (cwd: string, role: string) =>
  Effect.flatMap(ExtensionContext, (ctx) =>
    ctx.Accounts.role(cwd, role).pipe(
      Effect.mapError((error) => new MachineError({ message: error.message })),
    ),
  )

/** One config role `role` thread role `name` may run, as `checkRoles` reads it. */
const checkRole = Effect.fn("Machines.checkRole")(function* (
  definition: MachineDefinition,
  cwd: string,
  name: string,
  thread: ThreadRole,
  role: string,
) {
  const resolved = yield* resolveRole(cwd, role)
  if (Option.isNone(resolved)) {
    return yield* new MachineError({
      message: `${name} runs the role ${role}, which config roles does not name`,
    })
  }
  if (resolved.value.choices.length === 0) {
    return yield* new MachineError({
      message: `${name} runs the role ${role}, whose families no listed model has`,
    })
  }
  const models = resolved.value.choices.map((choice) => choice.model)
  const twice = models.filter((model, index) => models.indexOf(model) !== index)
  if (twice.length > 0) {
    return yield* new MachineError({
      message: `${name} runs the role ${role}, which resolves to ${twice.join(", ")} twice: only the first choice of a model runs`,
    })
  }
  if (Predicate.isUndefined(thread.against)) return
  const makers = new Set(resolved.value.choices.flatMap((choice) => Option.toArray(choice.maker)))
  if (makers.size < 2) {
    return yield* new MachineError({
      message: `${name} is against ${thread.against}, so its role ${role} needs listed models of two makers; it has ${[...makers].join(", ") || "none of a known maker"}`,
    })
  }
  // Each role the other may run must name models of known makers, or
  // its round would end with no maker to leave out.
  for (const target of configRolesOf(definition, thread.against)) {
    const theirs = yield* resolveRole(cwd, target)
    const unknown = Option.match(theirs, {
      onNone: () => [],
      onSome: (found) =>
        found.choices.filter((choice) => Option.isNone(choice.maker)).map((choice) => choice.model),
    })
    if (unknown.length > 0) {
      return yield* new MachineError({
        message: `${name} is against ${thread.against}, whose role ${target} runs ${unknown.join(", ")}, of no maker the catalog names`,
      })
    }
  }
})

/** The red generation the state's last visit saved: the next push repairs it. */
const repairOf = (context: RunContext, name: StateName): Option.Option<number> =>
  decodeGateOutcome(context.last[name]).pipe(
    Option.filter(GateOutcome.guards.red),
    Option.map((outcome) => outcome.generation),
  )

/**
 * The pusher stops waiting on the gate: a stopped or failed run. The gate
 * is found by the action's request id, so a run that crashed before it
 * saved the gate's repo releases it too.
 */
const releaseGate = (action: IntegrateAction) =>
  Effect.gen(function* () {
    const integration = yield* Effect.serviceOption(Integration)
    if (Option.isNone(integration)) return
    yield* integration.value.releaseRequest(action.requestId)
  })

/**
 * Moves the run out of its integrate state by `by`, the gate's outcome saved
 * as the state's value; `note` is the move's, for the target's `{{visit.note}}`.
 */
const leaveIntegrate = (
  run: Run,
  action: IntegrateAction,
  to: StateName,
  by: string,
  value: Schema.Json,
  note: Option.Option<string> = Option.none(),
) =>
  commitMove(
    run,
    {
      ...run,
      state: to,
      pending: Option.none(),
    },
    [
      MachineStep.cases.Saved.make({ state: action.state, value }),
      MachineStep.cases.Moved.make({
        from: action.state,
        to,
        by,
        ...omitUndefined({ note: Option.getOrUndefined(note) }),
      }),
    ],
  )

/**
 * The pending integrate is tried again after `GATE_RETRY_WAIT`, under the
 * run's own record: a gate that is not clear, gh or a remote out of reach.
 */
const retryIntegrate = Effect.fn("Machines.retryIntegrate")(function* (
  run: Run,
  action: IntegrateAction,
  reason: string,
) {
  const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(GATE_RETRY_WAIT)
  yield* Effect.logInfo("machines.integrate.waiting").pipe(
    Effect.annotateLogs({ run: run.run, state: action.state, error: reason }),
  )
  yield* commitMove(
    run,
    {
      ...run,
      pending: Option.some(PendingAction.cases.Integrate.make({ ...action, notBefore: until })),
    },
    [MachineStep.cases.Waiting.make({ state: action.state, until, reason: "integration" })],
  )
})

/**
 * Leaves the integrate visit by a restack's end: `Restacked` takes `to` (the
 * state's `on.restack`), `Conflict` takes `on.conflict` (default `on.red`).
 * `Unreachable` and `UpToDate` are the caller's.
 */
const leaveByRestack = <A, E, R, A2, E2, R2>(
  run: Run,
  action: IntegrateAction,
  state: IntegrateState,
  to: StateName,
  restacked: Restack,
  otherwise: {
    readonly unreachable: (message: string) => Effect.Effect<A, E, R>
    readonly upToDate: () => Effect.Effect<A2, E2, R2>
  },
) =>
  Match.value(restacked).pipe(
    Match.tagsExhaustive({
      Restacked: (end) =>
        leaveIntegrate(
          run,
          action,
          to,
          "restack",
          GateOutcome.cases.restacked.make({ from: end.from, to: end.to, onto: end.onto }),
        ),
      Conflict: (end) =>
        leaveIntegrate(
          run,
          action,
          state.on.conflict ?? state.on.red,
          "conflict",
          GateOutcome.cases.conflict.make({
            onto: end.onto,
            files: end.files,
            message: end.message,
          }),
        ),
      Unreachable: (end) => otherwise.unreachable(end.message),
      UpToDate: () => otherwise.upToDate(),
    }),
  )

/**
 * Pushes the pending integrate's head through the gate. A gate that is not
 * clear, or gh that is not ready, waits `GATE_RETRY_WAIT`; a refused push
 * restacks when the state has `on.restack`, else takes `red`, as does one a
 * crash cut off before it landed.
 */
const pushIntegrate = Effect.fn("Machines.pushIntegrate")(function* (
  run: Run,
  action: IntegrateAction,
  state: IntegrateState,
) {
  const integration = yield* integrationOf
  const pushed = yield* integration
    .push({
      cwd: run.cwd,
      ref: state.ref,
      requestId: action.requestId,
      poller: "caller",
      notify: false,
      ...omitUndefined({ remote: state.remote, repairOf: action.repairOf, sha: action.head }),
    })
    .pipe(Effect.result)
  if (pushed._tag === "Success") {
    const { notBefore: _notBefore, ...ready } = action
    const recorded = PendingAction.cases.Integrate.make({
      ...ready,
      repo: pushed.success.repo,
      generation: pushed.success.generation,
      sha: pushed.success.sha,
    })
    yield* commitMove(run, { ...run, pending: Option.some(recorded) }, [
      MachineStep.cases.Recorded.make({ action: recorded }),
    ])
    return
  }
  const error = pushed.failure
  switch (error._tag) {
    case "IntegrationBlocked":
    case "GhUnavailable":
      yield* retryIntegrate(run, action, error.message)
      return
    case "PushRefused": {
      const refused = leaveIntegrate(
        run,
        action,
        state.on.red,
        "red",
        GateOutcome.cases.refused.make({ message: error.message }),
      )
      if (Predicate.isUndefined(state.on.restack)) return yield* refused
      const restacked = yield* restack(run.cwd, state, Option.fromUndefinedOr(action.head))
      return yield* leaveByRestack(run, action, state, state.on.restack, restacked, {
        unreachable: (message) => retryIntegrate(run, action, message),
        upToDate: () => refused,
      })
    }
    // The push never landed, and its request id never pushes again.
    case "PushInterrupted":
      yield* leaveIntegrate(
        run,
        action,
        state.on.red,
        "red",
        GateOutcome.cases.interrupted.make({ message: error.message }),
      )
      return
    case "IntegrationError":
      return yield* new MachineFault({ message: error.message })
    default:
      return yield* error
  }
})

/**
 * The move a pending integrate asks for. A PR (`via: "pr"`) is
 * `advancePr`'s. Before the gate admitted it: push (`pushIntegrate`), as the
 * caller that polls its own gate (`poller: "caller"`), since a wake record
 * fires for the extension that armed it. After: the verdict for its
 * generation or a later one moves the run; until then the driver polls the
 * gate when its record names the next poll due, and sleeps under the run's
 * own record between.
 */
const advanceIntegrate = Effect.fn("Machines.integrate")(function* (
  run: Run,
  action: IntegrateAction,
  signals: Signals,
) {
  const now = yield* Clock.currentTimeMillis
  const waits = waitsUntil(Option.some(action), now)
  if (Option.isSome(waits)) return yield* waitOut(run, waits.value, signals)
  const state = yield* integrateStateOf(run, action.state)
  if (action.via === "pr") return yield* advancePr(run, action, state, signals)
  if (Predicate.isUndefined(action.repo) || Predicate.isUndefined(action.generation)) {
    return yield* pushIntegrate(run, action, state)
  }
  const integration = yield* integrationOf
  const key: GateKey = { repo: action.repo, ref: state.ref }
  const found = yield* integration.read(key)
  if (Option.isNone(found)) {
    return yield* new MachineFault({ message: `The gate of ${key.repo}:${key.ref} is gone` })
  }
  const verdict = settledVerdict(found.value)
  if (Option.isSome(verdict)) {
    const outcome = verdict.value
    const to = state.on[outcome.outcome]
    yield* leaveIntegrate(run, action, to, outcome.outcome, outcome)
    return
  }
  const due = found.value.nextPollAt ?? now
  if (due <= now) {
    // One poll; the next read of the row decides.
    yield* integration.poll(key)
    return
  }
  yield* waitOut(run, due, signals)
})

/**
 * The gate's outcome for an integrate, saved as the state's value: green or
 * red from CI, `refused` (not a fast-forward, or the remote said no) or
 * `interrupted` (a push a crash cut off, which never landed), which take
 * `on.red`; `restacked` (the head `from` rebased onto the ref's `onto`, now
 * `to`) and `conflict` (that rebase conflicted in `files` and was aborted).
 * A pull request (`IntegrateState.via`): `merged` (by `method`, absent
 * when a person merged it), `checks` (its checks named in `failing`
 * failed), `declined` (changes requested, closed, or a head the run did not
 * push; `note` quotes the reviews).
 */
const GateOutcome = Schema.Union([
  Schema.Struct({
    outcome: Schema.tag("green"),
    generation: Schema.Int,
    sha: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.tag("red"),
    generation: Schema.Int,
    sha: Schema.String,
    failing: Schema.Array(Schema.String),
  }),
  Schema.Struct({ outcome: Schema.tag("refused"), message: Schema.String }),
  Schema.Struct({ outcome: Schema.tag("interrupted"), message: Schema.String }),
  Schema.Struct({
    outcome: Schema.tag("restacked"),
    from: Schema.String,
    to: Schema.String,
    onto: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.tag("conflict"),
    onto: Schema.String,
    files: Schema.Array(Schema.String),
    message: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.tag("merged"),
    pr: PositiveInt,
    sha: Schema.String,
    method: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.tag("checks"),
    pr: PositiveInt,
    sha: Schema.String,
    failing: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.tag("declined"),
    /** Absent when the run's branch was a person's before the run had its PR. */
    pr: Schema.optionalKey(PositiveInt),
    reason: Schema.Literals(["changes", "closed", "moved"]),
    note: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("outcome"))
type GateOutcome = typeof GateOutcome.Type
const decodeGateOutcome = Schema.decodeUnknownOption(GateOutcome)

/**
 * The gate's outcome; none while CI runs. A gate's generation only grows, so
 * a record read after the run's push is at its generation or a later one.
 */
const settledVerdict = (
  record: GateRecord,
): Option.Option<Extract<GateOutcome, { readonly outcome: "green" | "red" }>> => {
  const state = record.state
  switch (state._tag) {
    case "Clear":
      return Option.some(
        GateOutcome.cases.green.make({
          generation: generationOf(record),
          ...omitUndefined({ sha: state.sha }),
        }),
      )
    case "Red":
      return Option.some(
        GateOutcome.cases.red.make({
          generation: state.generation,
          sha: state.sha,
          failing: state.failing.map((check) => check.context),
        }),
      )
    case "Integrating":
    case "AwaitingCi":
      return Option.none()
  }
}

// ── restack ─────────────────────────────────────────────────────────────────

/** A fetch, or a rebase, of the run's checkout. */
const RESTACK_TIMEOUT = Duration.minutes(2)
/** The most of git's words a conflict keeps. */
const RESTACK_MESSAGE_MAX = 2_000

/**
 * What a restack did. `UpToDate`: the head the visit pushed already holds
 * the fetched ref, so the push failed for another reason. `Restacked`: the
 * checkout's head is now `to`, on `onto`; a head that moved since the visit
 * began counts too, since the gate never saw it. `Conflict`: the rebase
 * stopped and was aborted, or the checkout was in a rebase of its own.
 * `Unreachable`: the fetch failed.
 */
const Restack = Schema.TaggedUnion({
  UpToDate: {},
  Restacked: { from: Schema.String, to: Schema.String, onto: Schema.String },
  Conflict: { onto: Schema.String, files: Schema.Array(Schema.String), message: Schema.String },
  Unreachable: { message: Schema.String },
})
type Restack = typeof Restack.Type

/** A git command of the restack, its exit read by the caller. No editor or prompt waits. */
const restackGit = (cwd: string, args: ReadonlyArray<string>) =>
  runProcess("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
    extendEnv: true,
    timeout: RESTACK_TIMEOUT,
  })

/** The commit `HEAD` of `cwd` names; none outside git. */
const headOf = (cwd: string) =>
  Effect.option(receiptGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]))

/** Whether the checkout is inside a rebase: git keeps its state in rebase-merge or rebase-apply. */
const rebasing = Effect.fn("Machines.rebasing")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const found = path.resolve(cwd, yield* receiptGit(cwd, ["rev-parse", "--git-path", name]))
    if (yield* fs.exists(found)) return true
  }
  return false
})

/**
 * Fetches the integrate state's ref and rebases the checkout onto it. `from`
 * is the head the visit pushed (default the checkout's head). A rebase in
 * progress before it is never aborted: it is not the restack's to end.
 */
const restack = Effect.fn("Machines.restack")(
  function* (cwd: string, state: IntegrateState, pushed: Option.Option<string>) {
    const remote = state.remote ?? "origin"
    if (yield* rebasing(cwd)) {
      return Restack.cases.Conflict.make({
        onto: state.ref,
        files: [],
        message: "The checkout is inside a rebase the run did not start: finish or abort it",
      })
    }
    const fetched = yield* restackGit(cwd, [
      "fetch",
      "--no-tags",
      remote,
      `refs/heads/${state.ref}`,
    ])
    if (fetched.exitCode !== 0) {
      return Restack.cases.Unreachable.make({
        message: `git fetch ${remote} ${state.ref} exited ${fetched.exitCode}: ${fetched.stderr.trim()}`,
      })
    }
    const onto = yield* receiptGit(cwd, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
    const head = yield* receiptGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
    const from = Option.getOrElse(pushed, () => head)
    const ancestry = yield* restackGit(cwd, ["merge-base", "--is-ancestor", onto, head])
    if (ancestry.exitCode > 1) {
      return yield* new MachineFault({
        message: `git merge-base --is-ancestor ${onto} ${head} exited ${ancestry.exitCode}`,
      })
    }
    if (ancestry.exitCode === 0) {
      if (head === from) return Restack.cases.UpToDate.make({})
      return Restack.cases.Restacked.make({ from, to: head, onto })
    }
    const rebased = yield* restackGit(cwd, ["rebase", "--no-autostash", onto])
    if (rebased.exitCode === 0) {
      const to = yield* receiptGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
      return Restack.cases.Restacked.make({ from, to, onto })
    }
    const conflicted = yield* restackGit(cwd, ["diff", "--name-only", "--diff-filter=U"])
    const files = conflicted.stdout.split("\n").filter((line) => line.length > 0)
    if (yield* rebasing(cwd)) {
      const aborted = yield* restackGit(cwd, ["rebase", "--abort"])
      if (aborted.exitCode !== 0) {
        return yield* new MachineFault({
          message: `git rebase --abort exited ${aborted.exitCode}: ${aborted.stderr.trim()}`,
        })
      }
    }
    const said = `${rebased.stdout}\n${rebased.stderr}`.trim()
    return Restack.cases.Conflict.make({
      onto,
      files,
      message: said.slice(0, RESTACK_MESSAGE_MAX),
    })
  },
  Effect.mapError((error) => new MachineFault({ message: `restack: ${error.message}` })),
)

// ── pull requests ───────────────────────────────────────────────────────────

/**
 * How often a PR that waits for a person is read. A review takes minutes to
 * days, so two minutes adds little to it, and 30 reads an hour per run stay
 * far under GitHub's 5,000 requests an hour.
 */
const PR_POLL_WAIT = Duration.minutes(2)
/** One `gh` or `git` call of a PR. */
const PR_TIMEOUT = Duration.minutes(1)
/** The most of the reviews a declined PR's note quotes. */
const PR_NOTE_MAX = 2_000

/** How the head reaches the ref, as `IntegrateState.via` renders: empty is `push`. */
const integrateVia = (rendered: string): Option.Option<"push" | "pr"> => {
  const via = rendered.trim()
  if (via === "" || via === "push") return Option.some("push")
  if (via === "pr") return Option.some("pr")
  return Option.none()
}

const isPrVia = (via: "push" | "pr"): via is "pr" => via === "pr"

/** The run's own branch, which its PR merges from: no person's branch is ever pushed. */
const prBranch = (run: RunId) => `gent/${run}`

/**
 * Each integrate state's `via` renders `push` or `pr` for the run's input:
 * a run fails at its start, not at its merge after every round.
 */
const checkVia = (definition: MachineDefinition, input: Schema.Json) =>
  Effect.forEach(
    Object.entries(definition.states),
    ([name, state]) => {
      if (state.kind !== "integrate" || Predicate.isUndefined(state.via)) return Effect.void
      const rendered = render(state.via, {
        input,
        context: { last: {}, all: {} },
        visit: 0,
        note: Option.none(),
        files: {},
        bun: Option.none(),
      })
      if (Option.isSome(integrateVia(rendered))) return Effect.void
      return Effect.fail(
        new MachineError({ message: `${name}: via renders ${rendered}; it takes push or pr` }),
      )
    },
    { discard: true },
  )

/** A `gh` call of a PR, its exit read by the caller; a gh that cannot start exits -1. */
const ghPr = (args: ReadonlyArray<string>) =>
  runProcess("gh", args, {
    env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
    extendEnv: true,
    timeout: PR_TIMEOUT,
  }).pipe(
    Effect.catch((error) => Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message })),
  )

/** What `gh` said, for a log or a note. */
const saidBy = (command: string, result: { readonly exitCode: number; readonly stderr: string }) =>
  `${command} exited ${result.exitCode}: ${result.stderr.trim()}`

const PrNumbers = Schema.fromJsonString(Schema.Array(Schema.Struct({ number: PositiveInt })))
const decodePrNumbers = Schema.decodeUnknownOption(PrNumbers)

/**
 * `Opened`: the PR the run's branch merges from. `Unreachable`: git or gh
 * failed, tried again later. `Foreign`: the branch holds a commit the run
 * did not push, which the run keeps.
 */
const PrOpen = Schema.TaggedUnion({
  Opened: { repo: Schema.String, pr: PositiveInt, sha: Schema.String },
  Unreachable: { message: Schema.String },
  Foreign: { note: Schema.String },
})
type PrOpen = typeof PrOpen.Type

/** The commit a remote's branch names now: none when it has no such branch. */
const remoteBranchHead = (cwd: string, remote: string, ref: string) =>
  Effect.map(receiptGit(cwd, ["ls-remote", remote, ref]), (listed) =>
    Option.fromUndefinedOr(
      listed
        .split("\n")
        .map((line) => line.split("\t"))
        .find(([, name]) => name === ref)?.[0],
    ),
  )

/**
 * Pushes `head` to the run's branch, leased on the commit the run last
 * pushed there (`RunMemo.prBranchHead`; none: the branch must not exist), so
 * a person's push to the branch is never overwritten. A lease that fails
 * reads the branch: at `head`, an earlier try of this push landed before a
 * crash; gone, a person deleted it, and the push makes it again; at another
 * commit, the branch is a person's now (`Foreign`).
 */
const pushPrBranch = Effect.fn("Machines.pushPrBranch")(function* (
  run: Run,
  remote: string,
  head: string,
) {
  const ref = `refs/heads/${prBranch(run.run)}`
  const push = (expected: string) =>
    restackGit(run.cwd, ["push", `--force-with-lease=${ref}:${expected}`, remote, `${head}:${ref}`])
  const pushed = yield* push(Option.getOrElse(run.prBranchHead, () => ""))
  if (pushed.exitCode === 0) return Option.none<PrOpen>()
  const unreachable = Option.some(
    PrOpen.cases.Unreachable.make({ message: saidBy(`git push ${remote}`, pushed) }),
  )
  const read = yield* Effect.option(remoteBranchHead(run.cwd, remote, ref))
  if (Option.isNone(read)) return unreachable
  const now = read.value
  if (Option.contains(now, head)) return Option.none<PrOpen>()
  if (Option.isNone(now)) {
    const remade = yield* push("")
    if (remade.exitCode === 0) return Option.none<PrOpen>()
    return unreachable
  }
  // The branch is where the lease said: the push failed for another reason.
  if (Option.contains(run.prBranchHead, now.value)) return unreachable
  return Option.some(
    PrOpen.cases.Foreign.make({
      note: `${prBranch(run.run)} on ${remote} is at ${now.value}, a commit the run did not push: the run did not push ${head} over it.`,
    }),
  )
})

/**
 * Pushes the visit's head to the run's branch (`pushPrBranch`) and finds its
 * open PR on the ref, or opens one titled by the head's subject. A retry
 * after a crash finds the PR it opened.
 */
const openPr = Effect.fn("Machines.openPr")(
  function* (run: Run, action: IntegrateAction, state: IntegrateState) {
    const integration = yield* integrationOf
    const remote = state.remote ?? "origin"
    const repo = yield* integration.repoOf({ cwd: run.cwd, remote })
    const head = yield* Option.match(Option.fromUndefinedOr(action.head), {
      onNone: () => receiptGit(run.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]),
      onSome: Effect.succeed,
    })
    const branch = prBranch(run.run)
    const refused = yield* pushPrBranch(run, remote, head)
    if (Option.isSome(refused)) return refused.value
    const listed = yield* ghPr([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--base",
      state.ref,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ])
    if (listed.exitCode !== 0) {
      return PrOpen.cases.Unreachable.make({ message: saidBy("gh pr list", listed) })
    }
    const open = Option.flatMap(decodePrNumbers(listed.stdout), (found) =>
      Option.fromUndefinedOr(found[0]),
    )
    if (Option.isSome(open)) {
      return PrOpen.cases.Opened.make({ repo, pr: open.value.number, sha: head })
    }
    const subject = yield* receiptGit(run.cwd, ["log", "-1", "--format=%s", head])
    const created = yield* ghPr([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      state.ref,
      "--head",
      branch,
      "--title",
      subject,
      "--body",
      `Opened by the gent machine run ${run.run} (${run.machine}): it merges once a person approves and the checks pass.`,
    ])
    if (created.exitCode !== 0) {
      return PrOpen.cases.Unreachable.make({ message: saidBy("gh pr create", created) })
    }
    const number = /\/pull\/(\d+)/.exec(created.stdout)
    if (Predicate.isNull(number)) {
      return PrOpen.cases.Unreachable.make({
        message: `gh pr create answered no PR: ${created.stdout.trim()}`,
      })
    }
    return PrOpen.cases.Opened.make({ repo, pr: Number(number[1]), sha: head })
  },
  Effect.mapError((error) => new MachineFault({ message: `pr: ${error.message}` })),
)

/** GitHub's words for a PR, as `gh pr view --json` prints them. */
const PrCheck = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  context: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
type PrCheck = typeof PrCheck.Type
const PrReview = Schema.Struct({
  author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  state: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
type PrReview = typeof PrReview.Type
const PrView = Schema.Struct({
  state: Schema.String,
  headRefOid: Schema.String,
  url: Schema.optionalKey(Schema.String),
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mergeable: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mergeStateStatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
  statusCheckRollup: Schema.optionalKey(Schema.NullOr(Schema.Array(PrCheck))),
  reviews: Schema.optionalKey(Schema.NullOr(Schema.Array(PrReview))),
})
type PrView = typeof PrView.Type
const decodePrView = Schema.decodeUnknownOption(Schema.fromJsonString(PrView))
const PR_VIEW_FIELDS =
  "state,headRefOid,url,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews"

/** A check's end: `ok` (success, neutral, skipped), `failed`, or `pending`. */
const checkEnd = (check: PrCheck): "ok" | "failed" | "pending" => {
  const status = (check.status ?? "").toUpperCase()
  const state = (check.state ?? "").toUpperCase()
  if (state.length > 0) {
    if (state === "SUCCESS") return "ok"
    if (state === "FAILURE" || state === "ERROR") return "failed"
    return "pending"
  }
  if (status.length > 0 && status !== "COMPLETED") return "pending"
  const conclusion = (check.conclusion ?? "").toUpperCase()
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return "ok"
  if (conclusion.length === 0) return "pending"
  return "failed"
}

/** Each reviewer's last approval or change request: a comment decides nothing. */
const lastReviews = (reviews: ReadonlyArray<PrReview>): ReadonlyArray<PrReview> => {
  const last = new Map<string, PrReview>()
  for (const review of reviews) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") continue
    last.set(review.author?.login ?? "", review)
  }
  return [...last.values()]
}

/** The reviews that asked for changes, quoted for the note. */
const quoteReviews = (reviews: ReadonlyArray<PrReview>) =>
  lastReviews(reviews)
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .map((review) => {
      const body = (review.body ?? "").trim()
      const who = `@${review.author?.login ?? "a reviewer"}`
      if (body.length === 0) return `${who} requested changes.`
      return `${who} requested changes: "${body}"`
    })

/**
 * What a read PR asks for. `Merged`: merged at the head the run pushed.
 * `Declined`: changes requested, closed, or a head the run did not push,
 * merged or not. `Failing`: a check
 * failed. `Restack`: it conflicts with the ref, or (approved, its checks
 * green) the ref moved past it. `Ready`: approved, green, mergeable.
 * `Waiting`: none of these yet.
 */
const PrDecision = Schema.TaggedUnion({
  Merged: {},
  Declined: { reason: Schema.Literals(["changes", "closed", "moved"]), note: Schema.String },
  Failing: { failing: Schema.Array(Schema.String) },
  Restack: { conflicting: Schema.Boolean },
  Ready: {},
  Waiting: {},
})
type PrDecision = typeof PrDecision.Type

/** Whether the reviews say `state`: GitHub's decision, or each reviewer's last when it has none. */
const reviewsSay = (view: PrView, state: "APPROVED" | "CHANGES_REQUESTED") => {
  const decision = view.reviewDecision ?? ""
  if (decision.length > 0) return decision === state
  return lastReviews(view.reviews ?? []).some((review) => review.state === state)
}

/** The PR's end no check decides: merged, closed, a head the run did not push, changes requested. */
const prReviewed = (view: PrView, pr: number, sha: string): Option.Option<PrDecision> => {
  let name = `PR #${pr}`
  if (Predicate.isNotUndefined(view.url)) name = `${name} (${view.url})`
  const quoted = (said: string) =>
    [said, ...quoteReviews(view.reviews ?? [])].join("\n").slice(0, PR_NOTE_MAX)
  if (view.state === "MERGED" && view.headRefOid !== sha) {
    return Option.some(
      PrDecision.cases.Declined.make({
        reason: "moved",
        note: `${name} was merged at ${view.headRefOid}, not the ${sha} the run pushed: a push the run did not make was merged.`,
      }),
    )
  }
  if (view.state === "MERGED") return Option.some(PrDecision.cases.Merged.make({}))
  if (view.state === "CLOSED") {
    return Option.some(
      PrDecision.cases.Declined.make({
        reason: "closed",
        note: quoted(`${name} was closed without a merge.`),
      }),
    )
  }
  if (view.headRefOid !== sha) {
    return Option.some(
      PrDecision.cases.Declined.make({
        reason: "moved",
        note: `${name} is at ${view.headRefOid}, not the ${sha} the run pushed: a push the run did not make.`,
      }),
    )
  }
  if (reviewsSay(view, "CHANGES_REQUESTED")) {
    return Option.some(
      PrDecision.cases.Declined.make({
        reason: "changes",
        note: quoted(`${name}: changes requested.`),
      }),
    )
  }
  return Option.none()
}

/** An open PR at the run's head, with no change requested: its checks and mergeability decide. */
const prMergeable = (view: PrView): PrDecision => {
  const checks = view.statusCheckRollup ?? []
  const failing = checks
    .filter((check) => checkEnd(check) === "failed")
    .map((check) => check.name ?? check.context ?? "a check")
  if (failing.length > 0) return PrDecision.cases.Failing.make({ failing })
  const mergeState = view.mergeStateStatus ?? ""
  if (view.mergeable === "CONFLICTING" || mergeState === "DIRTY") {
    return PrDecision.cases.Restack.make({ conflicting: true })
  }
  const pending = checks.some((check) => checkEnd(check) === "pending")
  if (!reviewsSay(view, "APPROVED") || pending) return PrDecision.cases.Waiting.make({})
  if (mergeState === "BEHIND") return PrDecision.cases.Restack.make({ conflicting: false })
  if (view.mergeable === "MERGEABLE") return PrDecision.cases.Ready.make({})
  return PrDecision.cases.Waiting.make({})
}

const prDecision = (view: PrView, pr: number, sha: string): PrDecision =>
  Option.getOrElse(prReviewed(view, pr, sha), () => prMergeable(view))

const RepoMergeMethods = Schema.fromJsonString(
  Schema.Struct({
    allow_squash_merge: Schema.optionalKey(Schema.Boolean),
    allow_rebase_merge: Schema.optionalKey(Schema.Boolean),
    allow_merge_commit: Schema.optionalKey(Schema.Boolean),
  }),
)
const decodeRepoMergeMethods = Schema.decodeUnknownOption(RepoMergeMethods)

/**
 * The repository's merge method: squash first, so a unit lands as one commit
 * on the ref, as a push to main lands it; then rebase, then a merge commit.
 */
const mergeMethodOf = Effect.fn("Machines.mergeMethodOf")(function* (repo: string) {
  const read = yield* ghPr(["api", `repos/${repo}`])
  if (read.exitCode !== 0) return Option.none<string>()
  return Option.flatMap(decodeRepoMergeMethods(read.stdout), (allowed) => {
    if (allowed.allow_squash_merge === true) return Option.some("squash")
    if (allowed.allow_rebase_merge === true) return Option.some("rebase")
    if (allowed.allow_merge_commit === true) return Option.some("merge")
    return Option.none()
  })
})

/** Merges the PR at the head the run pushed, by the repository's method; none when it did not. */
const mergePr = Effect.fn("Machines.mergePr")(function* (repo: string, pr: number, sha: string) {
  const method = yield* mergeMethodOf(repo)
  if (Option.isNone(method)) {
    yield* Effect.logWarning("machines.pr.merge").pipe(
      Effect.annotateLogs({ repo, pr, error: "no merge method the repository allows was read" }),
    )
    return method
  }
  const merged = yield* ghPr([
    "pr",
    "merge",
    String(pr),
    "--repo",
    repo,
    `--${method.value}`,
    "--match-head-commit",
    sha,
  ])
  if (merged.exitCode === 0) return method
  yield* Effect.logWarning("machines.pr.merge").pipe(
    Effect.annotateLogs({ repo, pr, error: saidBy("gh pr merge", merged) }),
  )
  return Option.none<string>()
})

/** An open PR's visit: the run, its pending integrate, and the PR it waits on. */
interface PrVisit {
  readonly run: Run
  readonly action: IntegrateAction
  readonly state: IntegrateState
  readonly repo: string
  readonly pr: number
  readonly sha: string
  readonly nextPoll: number
  readonly signals: Signals
}

/** The PR is read again at `nextPoll`, under the run's own record, with no step. */
const waitForPerson = (visit: PrVisit, reason: string) =>
  Effect.logInfo("machines.pr.waiting").pipe(
    Effect.annotateLogs({ run: visit.run.run, state: visit.action.state, pr: visit.pr, reason }),
    Effect.andThen(waitOut(visit.run, visit.nextPoll, visit.signals)),
  )

/**
 * Pushes the run's branch and opens its PR, then waits `PR_POLL_WAIT` (one
 * `Waiting` step, reason `pr`). Git or gh out of reach tries again after
 * `GATE_RETRY_WAIT`. A branch a person pushed to takes `declined` (default
 * `red`), reason `moved`.
 */
const openPrVisit = Effect.fn("Machines.openPrVisit")(function* (
  run: Run,
  action: IntegrateAction,
  state: IntegrateState,
  nextPoll: number,
) {
  const opened = yield* openPr(run, action, state)
  if (opened._tag === "Unreachable") return yield* retryIntegrate(run, action, opened.message)
  if (opened._tag === "Foreign") {
    return yield* leaveIntegrate(
      run,
      action,
      state.on.declined ?? state.on.red,
      "declined",
      GateOutcome.cases.declined.make({ reason: "moved", note: opened.note }),
      Option.some(opened.note),
    )
  }
  const { notBefore: _notBefore, ...ready } = action
  const recorded = PendingAction.cases.Integrate.make({
    ...ready,
    repo: opened.repo,
    pr: opened.pr,
    sha: opened.sha,
    notBefore: nextPoll,
  })
  yield* commitMove(run, { ...run, pending: Option.some(recorded) }, [
    MachineStep.cases.Recorded.make({ action: recorded }),
    MachineStep.cases.Waiting.make({ state: action.state, until: nextPoll, reason: "pr" }),
  ])
})

/**
 * A PR GitHub cannot merge as it is. With `on.restack`: rebase the checkout
 * onto the ref and take `restack`, so the gate checks the new head. Without:
 * a conflict takes `on.conflict` (default `on.red`), and a PR behind the ref
 * waits for a person to update it.
 */
const restackPr = Effect.fn("Machines.restackPr")(function* (visit: PrVisit, conflicting: boolean) {
  const { run, action, state } = visit
  if (Predicate.isNotUndefined(state.on.restack)) {
    const restacked = yield* restack(run.cwd, state, Option.some(visit.sha))
    return yield* leaveByRestack(run, action, state, state.on.restack, restacked, {
      unreachable: (message) => waitForPerson(visit, message),
      upToDate: () =>
        waitForPerson(visit, "the head already holds the ref; GitHub has not caught up"),
    })
  }
  if (!conflicting) return yield* waitForPerson(visit, "the ref moved past the PR")
  yield* leaveIntegrate(
    run,
    action,
    state.on.conflict ?? state.on.red,
    "conflict",
    GateOutcome.cases.conflict.make({
      onto: state.ref,
      files: [],
      message: `GitHub reports PR #${visit.pr} conflicts with ${state.ref}`,
    }),
  )
})

/** A PR merged at the run's head takes `green`, with the method of a merge the run asked for. */
const prMerged = (visit: PrVisit) =>
  leaveIntegrate(
    visit.run,
    visit.action,
    visit.state.on.green,
    "green",
    GateOutcome.cases.merged.make({
      pr: visit.pr,
      sha: visit.sha,
      ...omitUndefined({ method: visit.action.queued }),
    }),
  )

/** A declined PR takes `declined` (default `red`), its note the move's. */
const prDeclined = (visit: PrVisit, declined: Extract<PrDecision, { _tag: "Declined" }>) =>
  leaveIntegrate(
    visit.run,
    visit.action,
    visit.state.on.declined ?? visit.state.on.red,
    "declined",
    GateOutcome.cases.declined.make({
      pr: visit.pr,
      reason: declined.reason,
      note: declined.note,
    }),
    Option.some(declined.note),
  )

/** The PR as `gh pr view` reads it now; a read that failed gives its reason. */
const readPr = Effect.fn("Machines.readPr")(function* (repo: string, pr: number) {
  const viewed = yield* ghPr(["pr", "view", String(pr), "--repo", repo, "--json", PR_VIEW_FIELDS])
  if (viewed.exitCode !== 0) return Result.fail(saidBy("gh pr view", viewed))
  return Option.match(decodePrView(viewed.stdout), {
    onNone: () => Result.fail("gh pr view answered no PR"),
    onSome: (view) => Result.succeed(view),
  })
})

/**
 * Asks GitHub to merge a ready PR, then reads it at once: merged at the run's
 * head takes `green`. A merge that exited 0 with the PR still open was taken
 * by a merge queue: the visit records the method as `queued` and waits for
 * the PR to read merged, asking for no second merge. A merge that did not
 * land is read again later.
 */
const mergePrVisit = Effect.fn("Machines.mergePrVisit")(function* (visit: PrVisit) {
  const method = yield* mergePr(visit.repo, visit.pr, visit.sha)
  if (Option.isNone(method)) return yield* waitForPerson(visit, "the merge did not land")
  const queued = PendingAction.cases.Integrate.make({
    ...visit.action,
    queued: method.value,
    notBefore: visit.nextPoll,
  })
  const wait = commitMove(visit.run, { ...visit.run, pending: Option.some(queued) }, [
    MachineStep.cases.Recorded.make({ action: queued }),
    MachineStep.cases.Waiting.make({
      state: visit.action.state,
      until: visit.nextPoll,
      reason: "pr",
    }),
  ])
  const read = yield* readPr(visit.repo, visit.pr)
  if (Result.isFailure(read)) return yield* wait
  return yield* Match.value(prDecision(read.success, visit.pr, visit.sha)).pipe(
    Match.tagsExhaustive({
      Merged: () => prMerged({ ...visit, action: queued }),
      Declined: (declined) => prDeclined(visit, declined),
      Failing: () => wait,
      Restack: () => wait,
      Ready: () => wait,
      Waiting: () => wait,
    }),
  )
})

/**
 * The move a read PR's decision asks for. A queued merge (`queued`) takes
 * `green` by its method once the PR reads merged, and waits while it reads
 * ready: the queue holds it.
 */
const decidePr = (visit: PrVisit, decision: PrDecision) => {
  const { run, action, state, pr, sha } = visit
  return Match.value(decision).pipe(
    Match.tagsExhaustive({
      Merged: () => prMerged(visit),
      Declined: (declined) => prDeclined(visit, declined),
      Failing: (failing) =>
        leaveIntegrate(
          run,
          action,
          state.on.red,
          "red",
          GateOutcome.cases.checks.make({ pr, sha, failing: failing.failing }),
        ),
      Restack: (restacking) => restackPr(visit, restacking.conflicting),
      Ready: () => {
        if (Predicate.isNotUndefined(action.queued)) {
          return waitForPerson(visit, "the merge queue holds the PR")
        }
        return mergePrVisit(visit)
      },
      Waiting: () => waitForPerson(visit, "no decision yet"),
    }),
  )
}

/**
 * The move a pending PR asks for. Before it is open: `openPrVisit`. After:
 * read it every `PR_POLL_WAIT` under the run's own record, with no step and
 * no model turn, until a person's review, its checks or GitHub's
 * mergeability decide (`prDecision`, `decidePr`).
 */
const advancePr = Effect.fn("Machines.advancePr")(function* (
  run: Run,
  action: IntegrateAction,
  state: IntegrateState,
  signals: Signals,
) {
  const nextPoll = (yield* Clock.currentTimeMillis) + Duration.toMillis(PR_POLL_WAIT)
  const { repo, pr, sha } = action
  if (Predicate.isUndefined(pr) || Predicate.isUndefined(repo) || Predicate.isUndefined(sha)) {
    return yield* openPrVisit(run, action, state, nextPoll)
  }
  const visit: PrVisit = { run, action, state, repo, pr, sha, nextPoll, signals }
  const read = yield* readPr(repo, pr)
  if (Result.isFailure(read)) return yield* waitForPerson(visit, read.failure)
  return yield* decidePr(visit, prDecision(read.success, pr, sha))
})

/** Removes the run's core record once its end is settled. */
const withdrawWake = Effect.fn("Machines.withdrawWake")(function* (run: Run) {
  const ctx = yield* ExtensionContext
  yield* ctx.Session.cancelWake({ ...run.host, sourceId: runSource(run.run) })
  yield* ctx.Session.cancelWake({ ...run.host, sourceId: stopSource(run.run) })
})

/** Enters the run's current state, as one more visit. */
const enter = Effect.fn("Machines.enter")(function* (run: Run, signals: Signals) {
  const store = yield* MachineStore
  const definition = yield* definitionOf(run)
  const name = run.state
  const state = yield* stateIn(definition, name)
  const visit = visitsOf(run.visits, name) + 1
  if (isCapped(state)) {
    const cap = capOf(state) + (run.visits.grants[name] ?? 0)
    if (visit > cap) {
      const exhausted = Option.fromUndefinedOr(state.exhausted)
      if (Option.isSome(exhausted)) {
        yield* commitMove(run, { ...run, state: exhausted.value }, [
          MachineStep.cases.Moved.make({ from: name, to: exhausted.value, by: "exhausted" }),
        ])
        return
      }
      const asking = askingRun(run, { state, name, visit, reason: "exhausted", lead: [] })
      yield* commitMove(run, asking.after, asking.steps)
      return
    }
  }
  switch (state.kind) {
    case "final":
      yield* commitMove(run, { ...run, status: "final" }, [
        MachineStep.cases.Finished.make({ state: name, accepted: state.accepts ?? true }),
      ])
      return
    case "ask": {
      const requires = yield* appliedRequirement(run, state, name, visit)
      const asking = askingRun(run, {
        state,
        name,
        visit,
        reason: "asked",
        lead: [],
        ...omitUndefined({ requires: Option.getOrUndefined(requires) }),
      })
      yield* commitMove(run, asking.after, asking.steps)
      return
    }
    case "run": {
      // A poke (a stop, an answer) leaves the wait, and the driver reads the row again.
      const admitted = yield* Effect.raceFirst(
        Effect.as(store.permits.acquire(run.run), true),
        Effect.as(Queue.take(signals.pokes), false),
      )
      if (!admitted) return
      const ctx = yield* ExtensionContext
      const action = PendingAction.cases.Command.make({
        state: name,
        visit,
        startedAt: yield* Clock.currentTimeMillis,
        launch: yield* commandLaunch(yield* resolveDataDir(ctx.home)),
      })
      const committed = yield* commitMove(run, { ...run, pending: Option.some(action) }, [
        MachineStep.cases.Dispatched.make({ action }),
      ])
      if (Option.isSome(committed)) {
        yield* startCommand(committed.value, state, action, definition.files ?? {})
      }
      return
    }
    case "integrate": {
      // The push itself is the next move: the driver reads the action first.
      const head = yield* headOf(run.cwd)
      const rendered = render(state.via ?? "", templateScope(run, visit))
      const via = integrateVia(rendered)
      if (Option.isNone(via)) {
        return yield* new MachineFault({
          message: `${name}: via renders ${rendered}; it takes push or pr`,
        })
      }
      const action = PendingAction.cases.Integrate.make({
        state: name,
        visit,
        requestId: `machine:${run.run}:${run.seq + 1}`,
        ...omitUndefined({
          repairOf: Option.getOrUndefined(repairOf(run.context, name)),
          head: Option.getOrUndefined(head),
          via: Option.getOrUndefined(Option.filter(via, isPrVia)),
        }),
      })
      yield* commitMove(run, { ...run, pending: Option.some(action) }, [
        MachineStep.cases.Dispatched.make({ action }),
      ])
      return
    }
    case "thread": {
      const action = PendingAction.cases.Round.make({
        state: name,
        visit,
        key: `machine:${run.run}:${run.seq + 1}`,
        attempt: 1,
      })
      const committed = yield* commitMove(run, { ...run, pending: Option.some(action) }, [
        MachineStep.cases.Dispatched.make({ action }),
      ])
      if (Option.isSome(committed)) yield* dispatchRound(committed.value, state, action, signals)
      return
    }
  }
})

const templateScope = (run: Run, visit: number): TemplateScope => ({
  input: run.input,
  context: run.context,
  visit,
  note: Option.flatMap(run.lastMove, (move) => Option.fromUndefinedOr(move.note)),
  files: {},
  bun: Option.none(),
})

/**
 * The shell words a run state's `{{bun}}` renders: the server's own
 * executable, quoted, run as the Bun CLI. A compiled gent is a Bun
 * executable, which runs as Bun when `BUN_BE_BUN` is set, so a check runs
 * with no Bun on the PATH; a source run's executable is Bun itself, which
 * ignores the variable.
 */
const bunCommand = (execPath: string) => `env BUN_BE_BUN=1 '${execPath.replaceAll("'", `'\\''`)}'`

const threadStateOf = Effect.fn("Machines.threadStateOf")(function* (run: Run, name: StateName) {
  const state = yield* stateIn(yield* definitionOf(run), name)
  if (state.kind !== "thread") {
    return yield* new MachineFault({ message: `${name} is not a thread state` })
  }
  return state
})

/**
 * Sends the pending round: the same key, the same round, so a repeat after a
 * crash admits nothing new. The round's thread and its id (which the key
 * fixes before the send) are committed first, with a role's thread: a stop
 * or a crash after the admission then finds the round it must stop. A
 * commit that another writer beat sends nothing: the next read decides. A
 * busy thread waits for a round end and sends again. A
 * round with no free lane is queued by the send and starts when its grant
 * comes; the driver waits for its end as for any open round. An account
 * whose windows are spent (`LaneUnavailable`: a model the round names, or
 * a role pick that was spent by the send) makes the round wait until the
 * time it names, as the same round.
 */
const dispatchRound = Effect.fn("Machines.dispatchRound")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
  signals: Signals,
) {
  const threads = yield* threadsOf
  const target = yield* Option.match(roundTarget(action), {
    onSome: (found) => Effect.succeedSome({ run, action, ...found }),
    onNone: () => recordRoundTarget(run, state, action),
  })
  if (Option.isNone(target)) return
  const recorded = target.value
  const scope = templateScope(recorded.run, action.visit)
  const send: ThreadSendInput = {
    key: action.key,
    thread: recorded.thread,
    message: render(state.say, scope),
    notify: "none",
    ...omitUndefined({
      reply: Option.getOrUndefined(Option.map(Option.fromUndefinedOr(state.on), replySpecOf)),
    }),
  }
  const admitted = yield* threads.send(send).pipe(
    Effect.as(true),
    Effect.catchIf(isWaitRefusal, () => Effect.succeed(false)),
    Effect.catchTag("LaneUnavailable", (lane) =>
      waitForAccount(recorded.run, recorded.action, laneWait(lane)).pipe(Effect.as(true)),
    ),
    Effect.mapError(threadFault),
  )
  // Refused (the thread is busy, or the cap is full): any round end may free
  // it. The driver then reads the row again, so a stop or an answer that came
  // meanwhile decides before the next send.
  if (!admitted) yield* awaitSignal(signals, { ends: true, within: REFUSED_SEND_WAIT })
})

/**
 * The thread role a round of `state` runs: its first switch that holds names
 * the config role in place of the thread role's own.
 */
const switchedRole = (role: ThreadRole, state: ThreadState, scope: TemplateScope): ThreadRole => {
  const holds = (state.switches ?? []).find(
    (each) =>
      (Predicate.isUndefined(each.visits) || scope.visit <= each.visits) &&
      Option.contains(slotValue(scope, each.when.split(".")), jsonText(each.is)),
  )
  if (Predicate.isUndefined(holds)) return role
  return { ...role, role: holds.role }
}

/** The thread and round a pending round already names. */
const roundTarget = (action: RoundAction) =>
  Option.all({
    thread: Option.fromUndefinedOr(action.thread),
    round: Option.fromUndefinedOr(action.round),
  })

/** Whether the round runs on a thread of its own: a fresh state's, a retry's or a rerun's. */
const ownThread = (state: ThreadState, action: RoundAction) =>
  isFresh(state, action.visit) || action.attempt > 1 || action.fresh === true

/**
 * Starts the round's thread (a fresh one is the round's own, a role's is the
 * run's, kept across visits) and commits it with the round's id and the
 * thread's model: the run and the round as committed, or none when another
 * writer moved the row first. A config role's round runs the model and effort
 * its role picks: on the role's thread while that thread's model is the
 * pick, else on a new thread that becomes the role's. With every choice
 * spent, the round waits for the earliest reset, and none is returned.
 */
const recordRoundTarget = Effect.fn("Machines.recordRoundTarget")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
) {
  const threads = yield* threadsOf
  const definition = yield* definitionOf(run)
  const role = switchedRole(
    definition.threads[state.thread] ?? {},
    state,
    templateScope(run, action.visit),
  )
  const fresh = ownThread(state, action)
  const known = Option.liftPredicate(
    Option.fromUndefinedOr(run.roles[state.thread]),
    () => !fresh,
  ).pipe(Option.flatten)
  const kept = Option.orElse(Option.fromUndefinedOr(action.thread), () => known)
  const picked = yield* rolePick(run, action, state.thread, role, kept)
  if (Result.isFailure(picked)) {
    yield* waitForAccount(run, action, laneWait(picked.failure))
    return Option.none()
  }
  const pick = picked.success
  const model = Option.getOrUndefined(Option.map(pick, (chosen) => chosen.model)) ?? role.model
  const effort = Option.getOrUndefined(Option.map(pick, (chosen) => chosen.effort)) ?? role.effort
  const spec: Omit<ThreadStartInput, "key" | "name"> = {
    agent: role.agent ?? WORKER_AGENT,
    cwd: run.cwd,
    notify: "none",
    ...omitUndefined({
      model,
      effort,
      account: role.account,
      instructions: role.instructions,
      tools: role.tools,
    }),
  }
  const reused = Option.match(pick, {
    onNone: () => kept,
    onSome: (chosen) => Option.filter(kept, () => chosen.keep),
  })
  const thread = yield* Option.match(reused, {
    onSome: Effect.succeed,
    onNone: () => {
      let start = {
        key: `machine:${run.run}:role:${state.thread}`,
        name: `${run.machine}-${state.thread}`,
      }
      // A fresh round's thread is its own; a role's new model takes a new thread.
      if (fresh || Option.isSome(kept)) {
        start = {
          key: `${action.key}:thread`,
          name: `${run.machine}-${action.state}-${action.visit}`,
        }
      }
      return threads.start({ ...spec, ...start }).pipe(
        Effect.mapError(threadFault),
        Effect.map((started) => started.thread),
      )
    },
  })
  // Read back: a start again under its key finds the thread the first start made.
  const ran = yield* threads.model(thread).pipe(Effect.mapError(threadFault))
  const round = yield* threads.sendRound(action.key)
  // No choice had a lane: the round waits in its model's queue from now.
  const queuedOn = Option.map(
    Option.filter(pick, (chosen) => chosen.queued),
    (chosen) => chosen.model,
  )
  const queuedAt = yield* Effect.transposeOption(Option.as(queuedOn, Clock.currentTimeMillis))
  const recorded = PendingAction.cases.Round.make({
    ...action,
    thread,
    round,
    ...omitUndefined({
      model: Option.getOrUndefined(ran),
      configRole: role.role,
      queuedOn: Option.getOrUndefined(queuedOn),
      queuedAt: Option.getOrUndefined(queuedAt),
    }),
  })
  // A retry's or a rerun's thread is the round's own; a fresh state's
  // replaces the role's thread.
  let roles = run.roles
  if (action.attempt === 1 && action.fresh !== true)
    roles = { ...run.roles, [state.thread]: thread }
  const committed = yield* commitMove(run, { ...run, roles, pending: Option.some(recorded) }, [
    MachineStep.cases.Recorded.make({ action: recorded }),
  ])
  return Option.map(committed, (next) => ({ run: next, action: recorded, thread, round }))
})

// ── model roles ─────────────────────────────────────────────────────────────

/** The ended runs of a machine the efficient rank reads, newest first. */
const RANK_RUNS = 40
/** A run counts half as much as one this many runs newer. */
const RANK_HALF_LIFE = 10
/** One run in this many puts the runner-up first, so the cheapest is measured against it again. */
const RANK_EXPLORE = 10
/**
 * What an unpriced round's tokens cost, in dollars per million: the fuel
 * reference prices (core `FUEL_REFERENCE_WEIGHTS` at $5 an input token).
 */
const REFERENCE_PRICES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

/**
 * A round's spend in dollars: its price, else its tokens at the reference
 * prices (a subscription view lists no price); none when it kept neither.
 */
const roundSpend = (round: RoundEnded): Option.Option<number> => {
  if (Predicate.isNotUndefined(round.costUsd)) return Option.some(round.costUsd)
  return Option.map(
    Option.fromUndefinedOr(round.tokens),
    (tokens) =>
      (Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite) * REFERENCE_PRICES.input +
        tokens.output * REFERENCE_PRICES.output +
        tokens.cacheRead * REFERENCE_PRICES.cacheRead +
        tokens.cacheWrite * REFERENCE_PRICES.cacheWrite) /
      1_000_000,
  )
}

/** One ended run as the rank reads it: where it worked, its rounds, and whether a final state accepted its work. */
interface RankedRun {
  readonly project: Option.Option<string>
  readonly domain: Option.Option<string>
  readonly accepted: boolean
  readonly rounds: ReadonlyArray<RoundEnded>
}

/** The `domain` a run's input names: the area of the code its unit changes. */
const domainOf = (input: Schema.Json): Option.Option<string> =>
  Option.map(
    Schema.decodeUnknownOption(Schema.Struct({ domain: Schema.String }))(input),
    (named) => named.domain,
  )

/** `endedRunsOf`'s steps, run by run, in its order. */
const rankedRuns = (outcomes: ReadonlyArray<RunOutcome>): ReadonlyArray<RankedRun> => {
  const byRun = new Map<RunId, Array<MachineStep>>()
  for (const outcome of outcomes) {
    const steps = byRun.get(outcome.run) ?? []
    steps.push(outcome.step)
    byRun.set(outcome.run, steps)
  }
  return [...byRun.values()].map((steps) => {
    let project = Option.none<string>()
    let domain = Option.none<string>()
    let accepted = false
    const rounds: Array<RoundEnded> = []
    for (const step of steps) {
      if (step._tag === "Started") {
        project = Option.fromUndefinedOr(step.project)
        domain = domainOf(step.input)
      }
      if (step._tag === "RoundEnded") rounds.push(step)
      if (step._tag === "Finished") accepted = step.accepted !== false
    }
    return { project, domain, accepted, rounds }
  })
}

/** A model's weighted spend and accepted units in one scope. */
interface UnitTally {
  spend: number
  units: number
}

const addTally = (scope: Map<ModelId, UnitTally>, model: ModelId, spend: number, units: number) => {
  const tally = scope.get(model) ?? { spend: 0, units: 0 }
  tally.spend += spend
  tally.units += units
  scope.set(model, tally)
}

/**
 * What the rank counts: the rounds thread role `thread` ran in config role
 * `config`. A round from before switches names no config role: it ran
 * `own`, the thread role's own.
 */
interface RankKey {
  readonly thread: RoleName
  readonly config: string
  readonly own: string
}

/** How many rounds of `key` each model ran in `run`. */
const roleRounds = (run: RankedRun, key: RankKey): ReadonlyMap<ModelId, number> => {
  const byModel = new Map<ModelId, number>()
  for (const round of run.rounds) {
    if (round.role !== key.thread || Predicate.isUndefined(round.model)) continue
    if ((round.configRole ?? key.own) !== key.config) continue
    byModel.set(round.model, (byModel.get(round.model) ?? 0) + 1)
  }
  return byModel
}

/** Every round of `run` at its model's weight; none when a round kept no spend. */
const runSpend = (run: RankedRun, weightOf: (model: ModelId) => number): Option.Option<number> => {
  let spend = 0
  for (const round of run.rounds) {
    const usd = roundSpend(round)
    if (Option.isNone(usd)) return Option.none()
    const weight = Option.match(Option.fromUndefinedOr(round.model), {
      onNone: () => 1,
      onSome: weightOf,
    })
    spend += usd.value * weight
  }
  return Option.some(spend)
}

/** One scope of `efficientOrder`: each model's tally, and the models each run of the role in it ran, newest first. */
interface RankScope {
  readonly tallies: Map<ModelId, UnitTally>
  readonly ran: Array<ReadonlySet<ModelId>>
}

/** `efficientOrder`'s scopes over `runs`, narrowest first: `here`'s project and domain, its project, the machine. */
const unitScopes = (
  runs: ReadonlyArray<RankedRun>,
  here: { readonly project: string; readonly domain: Option.Option<string> },
  key: RankKey,
  weightOf: (model: ModelId) => number,
): ReadonlyArray<RankScope> => {
  const scopes: ReadonlyArray<RankScope> = [0, 1, 2].map(() => ({ tallies: new Map(), ran: [] }))
  for (const [index, run] of runs.entries()) {
    const byModel = roleRounds(run, key)
    if (byModel.size === 0) continue
    const inProject = Option.contains(run.project, here.project)
    const inDomain =
      inProject && Option.isSome(run.domain) && Option.contains(here.domain, run.domain.value)
    const holds = [inDomain, inProject, true]
    const holding = scopes.filter((_, at) => holds[at] === true)
    for (const scope of holding) scope.ran.push(new Set(byModel.keys()))
    const spend = runSpend(run, weightOf)
    if (Option.isNone(spend)) continue
    const weight = 0.5 ** (index / RANK_HALF_LIFE)
    const total = [...byModel.values()].reduce((sum, count) => sum + count, 0)
    for (const [model, count] of byModel) {
      const share = (weight * count) / total
      const units = share * Number(run.accepted)
      for (const scope of holding) addTally(scope.tallies, model, share * spend.value, units)
    }
  }
  return scopes
}

/** A tally's spend per unit; one with no unit last. */
const unitCost = (tally: UnitTally): number => {
  if (tally.units === 0) return Number.POSITIVE_INFINITY
  return tally.spend / tally.units
}

/**
 * A cheapest role's models in the order `role`'s round tries them, read
 * from the machine's ended runs (newest first) and nothing stored: a run's
 * spend is every round of it, each role's, at its model's quota weight
 * (`weightOf`); a run whose final state accepts its work is one unit. Each
 * model that ran a round of `role` in a run takes the run's spend and unit
 * at its share of the role's rounds there, and a run weighs half as much
 * as one `RANK_HALF_LIFE` runs newer. A model's score is its spend over its
 * units in the narrowest scope it ran in: runs of `here`'s project and
 * domain, else of its project, else of the machine. A model with no
 * measured run (a new release is a new id) goes first, in the list's order;
 * then the measured by score, one with no unit last; ties in the list's
 * order. When the newest `RANK_EXPLORE - 1` runs of the role in the first
 * model's scope all ran it alone, the runner-up goes first, so the rank
 * measures again where the work is. Deleting it leaves the list's order.
 */
const efficientOrder = (
  listed: ReadonlyArray<ModelId>,
  runs: ReadonlyArray<RankedRun>,
  here: { readonly project: string; readonly domain: Option.Option<string> },
  key: RankKey,
  weightOf: (model: ModelId) => number,
): ReadonlyArray<ModelId> => {
  const scopes = unitScopes(runs, here, key, weightOf)
  const scoredIn = (model: ModelId) =>
    Option.firstSomeOf(
      scopes.map((scope) =>
        Option.map(Option.fromUndefinedOr(scope.tallies.get(model)), (tally) => ({
          scope,
          score: unitCost(tally),
        })),
      ),
    )
  const ranked = listed
    .map((model, index) => ({ model, index, scored: scoredIn(model) }))
    .toSorted(
      (left, right) =>
        Number(Option.isSome(left.scored)) - Number(Option.isSome(right.scored)) ||
        Order.Number(
          Option.match(left.scored, { onNone: () => 0, onSome: (found) => found.score }),
          Option.match(right.scored, { onNone: () => 0, onSome: (found) => found.score }),
        ) ||
        left.index - right.index,
    )
  const [first, second, ...rest] = ranked
  if (Predicate.isUndefined(first) || Predicate.isUndefined(second)) return listed
  const settled = Option.exists(first.scored, ({ scope }) => {
    const newest = scope.ran.slice(0, RANK_EXPLORE - 1)
    return (
      newest.length === RANK_EXPLORE - 1 &&
      newest.every((models) => models.size === 1 && models.has(first.model))
    )
  })
  if (settled) return [second, first, ...rest].map((entry) => entry.model)
  return ranked.map((entry) => entry.model)
}

/**
 * The maker of the model the newest round of role `against` ran in
 * `run` (`lastRoundModel`): the round under review, on whichever thread it
 * ran. None while that role has run no round, so a graph that reviews
 * before it implements leaves nothing out. Fails when the catalog names no
 * maker for that model: no choice could be shown to be another maker's.
 */
const againstMaker = Effect.fn("Machines.againstMaker")(function* (run: Run, against: RoleName) {
  const store = yield* MachineStore
  const ctx = yield* ExtensionContext
  const model = yield* store
    .lastRoundModel(run.run, against)
    .pipe(Effect.mapError((error) => new MachineFault({ message: error.message })))
  if (Option.isNone(model)) return Option.none<string>()
  const maker = yield* ctx.Accounts.maker(run.cwd, model.value).pipe(
    Effect.mapError((error) => new MachineFault({ message: error.message })),
  )
  if (Option.isSome(maker)) return maker
  return yield* new MachineFault({
    message: `The catalog names no maker of ${model.value}, which ${against} runs: no model can be shown to be another maker's`,
  })
})

/**
 * The choices thread role `name`'s config role leaves its round, in the
 * role's own order: of a role `against` another, a choice of that role's
 * maker or of no known maker drops, and so does one of a maker in `avoid`
 * (patience moved the round off it). Fails when the config names no such
 * role; none left is the caller's to read.
 */
const roleChoices = Effect.fn("Machines.roleChoices")(function* (
  run: Run,
  name: RoleName,
  configRole: string,
  against: Option.Option<RoleName>,
  avoid: ReadonlyArray<string>,
) {
  const ctx = yield* ExtensionContext
  const resolved = yield* ctx.Accounts.role(run.cwd, configRole).pipe(
    Effect.mapError((error) => new MachineFault({ message: error.message })),
  )
  if (Option.isNone(resolved)) {
    return yield* new MachineFault({
      message: `${name} runs the role ${configRole}, which config roles does not name`,
    })
  }
  const maker = yield* Option.match(against, {
    onNone: () => Effect.succeedNone,
    onSome: (other) => againstMaker(run, other),
  })
  const choices = resolved.value.choices.filter(
    (choice) =>
      (Option.isNone(maker) ||
        Option.exists(choice.maker, (each) => !Option.contains(maker, each))) &&
      !Option.exists(choice.maker, (each) => avoid.includes(each)),
  )
  return { role: resolved.value, maker, choices }
})

/**
 * The choices of thread role `name`'s config role, in the order its round
 * tries them (`roleChoices`): the role's own order, or with `rank:
 * "cheapest"` by `efficientOrder` over the machine's ended runs, here being
 * the run's project and its input's `domain` (a weight is the provider's
 * fitted one, `accounts.lanes`, 1 until fitted). Fails when the config names
 * no such role, or no choice is left: a wait would never end.
 */
const roleOrder = Effect.fn("Machines.roleOrder")(function* (
  run: Run,
  name: RoleName,
  configRole: string,
  against: Option.Option<RoleName>,
  /** The thread role's own config role, which a round from before switches ran. */
  own: string,
  avoid: ReadonlyArray<string>,
) {
  const ctx = yield* ExtensionContext
  const { role, maker, choices } = yield* roleChoices(run, name, configRole, against, avoid)
  if (choices.length === 0) {
    const unresolved = role.unresolved.map((choice) => `${choice.provider} ${choice.family}`)
    const reasons = [
      ...Option.toArray(Option.map(maker, (each) => `none of another maker than ${each}`)),
      ...Option.toArray(
        Option.map(
          Option.liftPredicate(avoid, (list) => list.length > 0),
          (list) => `none of a maker other than ${list.join(", ")}, which patience left`,
        ),
      ),
      ...Option.toArray(
        Option.map(
          Option.liftPredicate(unresolved, (list) => list.length > 0),
          (list) => `no listed model of ${list.join(", ")}`,
        ),
      ),
    ]
    return yield* new MachineFault({
      message: `${name} has no model to run in the role ${configRole}: ${reasons.join("; ") || "no choice"}`,
    })
  }
  if (Option.isNone(role.rank)) return choices
  const store = yield* MachineStore
  const runs = rankedRuns(yield* store.endedRunsOf(run.machine, RANK_RUNS))
  const report = yield* ctx.Accounts.lanes
  const weights = new Map(
    report.providers.flatMap((lanes) => lanes.models).map((entry) => [entry.model, entry.weight]),
  )
  const here = { project: yield* ctx.Accounts.project(run.cwd), domain: domainOf(run.input) }
  const ranked = efficientOrder(
    choices.map((choice) => choice.model),
    runs,
    here,
    { thread: name, config: configRole, own },
    (model) => weights.get(model) ?? 1,
  )
  return ranked.flatMap((model) =>
    Option.toArray(Option.fromUndefinedOr(choices.find((choice) => choice.model === model))),
  )
})

/**
 * The first of `models` whose lane is free now, admitted under the round's
 * send key, so the send takes the lane the pick saw free. With none free,
 * the first that is not spent: the key waits in that model's lane queue,
 * and the send finds its place. Fails with the refusal that lifts first
 * when all are refused (spent, or in the owner's Sabbath). Each admission under the key gives
 * the last one's lane or place up. A pick whose commit loses keeps its
 * lane until the hold lapses (2 minutes): another driver may send under
 * the same key, so none cancels it. `queued`: the pick left the key waiting.
 */
const freeModel = Effect.fn("Machines.freeModel")(function* (
  run: Run,
  action: RoundAction,
  role: ThreadRole,
  models: ReadonlyArray<ModelId>,
) {
  const threads = yield* threadsOf
  const admission = {
    agent: role.agent ?? WORKER_AGENT,
    ...omitUndefined({
      runSpec: Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(role.account), (credentialSlot) => ({ credentialSlot })),
      ),
    }),
  }
  const admit = (modelId: ModelId) =>
    threads.admitSend(action.key, { cwd: run.cwd, modelId, admission }).pipe(
      Effect.map(Result.succeed),
      Effect.catchTag("LaneUnavailable", (refused) => Effect.succeed(Result.fail(refused))),
    )
  // The refusal that lifts first, of the models refused.
  let soonest = Option.none<LaneUnavailable>()
  const waiting: Array<ModelId> = []
  for (const modelId of models) {
    const answer = yield* admit(modelId)
    if (Result.isFailure(answer)) {
      const refused = answer.failure
      if (!Option.exists(soonest, (earlier) => earlier.retryAt <= refused.retryAt))
        soonest = Option.some(refused)
    } else if (answer.success._tag === "Admitted") return Result.succeed({ modelId, queued: false })
    else waiting.push(modelId)
  }
  const first = Option.fromUndefinedOr(waiting[0])
  if (Option.isNone(first)) {
    // Every model is refused: the round waits for the one that lifts first.
    return Result.fail(
      yield* Effect.fromOption(
        soonest,
        () => new MachineFault({ message: "A role pick needs a model to try" }),
      ),
    )
  }
  // The last try left the key on another model: it waits on the first again.
  const queued = yield* admit(first.value)
  if (Result.isFailure(queued)) return Result.fail(queued.failure)
  return Result.succeed({ modelId: first.value, queued: queued.success._tag !== "Admitted" })
})

/**
 * The model and effort a config role's round runs, and whether it keeps
 * `kept`, the role's thread: that thread's model is tried first while a
 * choice of the role names it at the thread's effort, so the role keeps its
 * thread and cache while that model has a lane. None for a role that names no config role. With no
 * choice free, the first that is not spent, whose queue the round waits in.
 * Fails with the refusal of the choice that can carry a run first when
 * every one is refused.
 */
const rolePick = Effect.fn("Machines.rolePick")(function* (
  run: Run,
  action: RoundAction,
  name: RoleName,
  role: ThreadRole,
  kept: Option.Option<SessionId>,
) {
  if (Predicate.isNotUndefined(role.tier)) {
    return yield* new MachineFault({
      message: `${name} names a tier, which config roles replaced: start the run again from a definition that names a role`,
    })
  }
  if (Predicate.isUndefined(role.role)) {
    return Result.succeed(
      Option.none<{
        readonly model: ModelId
        readonly effort: ReasoningEffort
        readonly keep: boolean
        readonly queued: boolean
      }>(),
    )
  }
  const threads = yield* threadsOf
  const own = (yield* definitionOf(run)).threads[name]?.role ?? role.role
  const order = yield* roleOrder(
    run,
    name,
    role.role,
    Option.fromUndefinedOr(role.against),
    own,
    action.avoid ?? [],
  )
  const models = order.map((choice) => choice.model)
  const keptRun = yield* Option.match(kept, {
    onNone: () => Effect.succeedNone,
    onSome: (thread) =>
      Effect.all({ model: threads.model(thread), effort: threads.effort(thread) }).pipe(
        Effect.map(({ model, effort }) => Option.map(model, (found) => ({ model: found, effort }))),
        Effect.mapError(threadFault),
      ),
  })
  // The kept thread runs on only at a choice's model and effort both.
  const first = Option.flatMap(keptRun, (ran) =>
    Option.fromUndefinedOr(
      order.find(
        (choice) => choice.model === ran.model && Option.contains(ran.effort, choice.effort),
      )?.model,
    ),
  )
  const tried = [
    ...Option.toArray(first),
    ...models.filter((model) => !Option.contains(first, model)),
  ]
  const free = yield* freeModel(run, action, role, tried)
  return Result.map(free, ({ modelId, queued }) =>
    Option.map(
      Option.fromUndefinedOr(order.find((choice) => choice.model === modelId)),
      (choice) => ({
        model: modelId,
        effort: choice.effort,
        keep: Option.contains(first, modelId),
        queued,
      }),
    ),
  )
})

/**
 * The round's role, its model, its turn's priced cost and tokens, and its
 * size, as its `RoundEnded` step keeps them. A zero cost over
 * spent tokens is a catalog with no price (a subscription view): unknown,
 * never free, as placement reads fuel.
 */
const roundEndFields = (
  action: RoundAction,
  role: RoleName,
  view: {
    readonly usage?: typeof ChildUsage.Type
    readonly size: number
    readonly window?: number
  },
) => {
  const usage = Option.fromUndefinedOr(view.usage)
  const tokens = Option.map(usage, (spent) => ({
    input: spent.input,
    output: spent.output,
    cacheRead: spent.cacheRead ?? 0,
    cacheWrite: spent.cacheWrite ?? 0,
  }))
  const costUsd = Option.flatMap(usage, (spent) =>
    Option.filter(
      Option.fromUndefinedOr(spent.costUsd),
      (cost) =>
        cost > 0 ||
        spent.input + spent.output + (spent.cacheRead ?? 0) + (spent.cacheWrite ?? 0) === 0,
    ),
  )
  return omitUndefined({
    role,
    configRole: action.configRole,
    model: action.model,
    costUsd: Option.getOrUndefined(costUsd),
    tokens: Option.getOrUndefined(tokens),
    handedOffTokens: Option.getOrUndefined(Option.liftPredicate(view.size, (tokens) => tokens > 0)),
    windowTokens: view.window,
  })
}

/** A token count as a note reads it: `1.6M`, `128k`, `900`. */
const tokensText = (tokens: number): string => {
  const scaled = (value: number, unit: string) => `${Number(value.toFixed(1))}${unit}`
  if (tokens >= 1_000_000) return scaled(tokens / 1_000_000, "M")
  if (tokens >= 1_000) return scaled(tokens / 1_000, "k")
  return String(tokens)
}

/** What a round's verdict was, as a size stop's note names it. */
const verdictText = (verdict: Option.Option<Verdict>): string =>
  Option.match(verdict, {
    onNone: () => "gave no verdict",
    onSome: (next) => `replied ${next}`,
  })

/**
 * The size stop a state's `oversize` makes of an ended round: the state the
 * run moves to and the move's note, none for a round within its size.
 */
const sizeStopOf = (
  name: StateName,
  state: ThreadState,
  action: RoundAction,
  view: { readonly size: number; readonly window?: number },
  verdict: Option.Option<Verdict>,
): Option.Option<{ readonly to: StateName; readonly note: string }> =>
  Option.flatMap(
    Option.all({
      oversize: Option.fromUndefinedOr(state.oversize),
      window: Option.fromUndefinedOr(view.window),
    }),
    ({ oversize, window }) =>
      Option.map(
        Option.liftPredicate(
          view.size,
          (tokens) => tokens > 0 && tokens >= oversize.windows * window,
        ),
        (tokens) => ({
          to: oversize.to,
          note: `Size stop: the ${name} round (role ${state.thread}, visit ${action.visit}) ${verdictText(verdict)}, but ${tokensText(tokens)} tokens of its own work left the context, and the limit is ${oversize.windows} windows of ${tokensText(window)}: too big for one round. Replan its work into smaller units; a round of the same size hands off again. A positive verdict may still be taken when the rest of the work checks out, with a note that the unit was oversized.`,
        }),
      ),
  )

/** How long a round waits in a lane queue before it moves to another maker. */
const PATIENCE = Duration.minutes(10)

/**
 * Waits for an open round's end, with patience for one its pick left
 * queued (`queuedOn`): until `PATIENCE` has passed, at most the time left;
 * past it, while the round still waits in that queue
 * (`Threads.laneQueued`), it moves when its role has a choice of a maker
 * other than `queuedOn`'s and the ones it left before. The move first
 * commits that maker as the round's `leaving`, so a restart finishes it
 * (`settleLeaving`). With no such choice, or once its lane came, it waits
 * for its end as any round.
 */
const awaitPatiently = Effect.fn("Machines.awaitPatiently")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
  roundId: string,
  signals: Signals,
) {
  const waits = (within = Option.none<Duration.Duration>()) =>
    awaitSignal(signals, {
      ends: true,
      ...omitUndefined({ within: Option.getOrUndefined(within) }),
    })
  if (Predicate.isUndefined(action.queuedOn) || Predicate.isUndefined(action.queuedAt)) {
    return yield* waits()
  }
  const queuedOn = action.queuedOn
  const left = action.queuedAt + Duration.toMillis(PATIENCE) - (yield* Clock.currentTimeMillis)
  if (left > 0) return yield* waits(Option.some(Duration.millis(left)))
  const threads = yield* threadsOf
  if (!(yield* threads.laneQueued(roundId))) return yield* waits()
  const ctx = yield* ExtensionContext
  const maker = yield* ctx.Accounts.maker(run.cwd, queuedOn).pipe(
    Effect.mapError((error) => new MachineFault({ message: error.message })),
  )
  if (Option.isNone(maker)) return yield* waits()
  const choices = yield* choicesWithout(run, state, action, maker.value)
  if (choices.length === 0) return yield* waits()
  const leaving = PendingAction.cases.Round.make({
    ...action,
    leaving: { maker: maker.value, model: queuedOn },
  })
  const committed = yield* commitMove(run, { ...run, pending: Option.some(leaving) }, [])
  if (Option.isNone(committed)) return
  yield* settleLeaving(committed.value, leaving, roundId)
})

/** The choices the round's role has with `maker` and the makers it left before out. */
const choicesWithout = Effect.fn("Machines.choicesWithout")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
  maker: string,
) {
  const definition = yield* definitionOf(run)
  const role = switchedRole(
    definition.threads[state.thread] ?? {},
    state,
    templateScope(run, action.visit),
  )
  if (Predicate.isUndefined(role.role)) return []
  const { choices } = yield* roleChoices(
    run,
    state.thread,
    role.role,
    Option.fromUndefinedOr(role.against),
    [...(action.avoid ?? []), maker],
  )
  return choices
})

/**
 * Finishes a move off the maker the round is `leaving`, now or after a
 * restart. The queue decides (`Threads.withdrawQueued`): a round taken out
 * of it, or found stopped (a withdrawal before a restart), moves: a new
 * pending round under a new key leaves that maker out (`avoid`), with a
 * `Repicked` step, and its pick starts its own thread. A round whose grant
 * came first keeps its place: `leaving` is dropped and it runs. The
 * withdrawn round was marked stopped before the move, so it never runs.
 */
const settleLeaving = Effect.fn("Machines.settleLeaving")(function* (
  run: Run,
  action: RoundAction,
  roundId: string,
) {
  const threads = yield* threadsOf
  if (Predicate.isUndefined(action.leaving)) return
  const { maker, model } = action.leaving
  let withdrawn = yield* threads.withdrawQueued(roundId)
  if (!withdrawn) {
    const view = yield* threads.findRound(roundId).pipe(Effect.mapError(threadFault))
    withdrawn = Option.exists(view, (found) => found.stopped)
  }
  if (!withdrawn) {
    const { leaving: _leaving, ...kept } = action
    yield* commitMove(
      run,
      { ...run, pending: Option.some(PendingAction.cases.Round.make(kept)) },
      [],
    )
    return
  }
  // The key is the `Repicked` step's seq: unique in the run.
  const next = PendingAction.cases.Round.make({
    state: action.state,
    visit: action.visit,
    key: `machine:${run.run}:${run.seq + 1}`,
    attempt: action.attempt,
    avoid: [...(action.avoid ?? []), maker],
    ...omitUndefined({ fresh: action.fresh }),
  })
  yield* Effect.logInfo("machines.round.repicked").pipe(
    Effect.annotateLogs({ run: run.run, state: action.state, model, maker }),
  )
  yield* commitMove(run, { ...run, pending: Option.some(next) }, [
    MachineStep.cases.Repicked.make({ state: action.state, model, maker }),
  ])
})

/**
 * Waits for the pending round's end, then takes its receipt: a verdict moves
 * the run, a dead worker runs the round once more on a new thread, and a
 * second dead round, or a round stopped from outside, asks the owner. A
 * worker that died at a usage limit gave no verdict and spent nothing: the
 * round waits for the limit's reset, then runs again on a new thread under a
 * new key, at the same visit and attempt.
 */
const awaitRound = Effect.fn("Machines.awaitRound")(function* (
  run: Run,
  action: RoundAction,
  signals: Signals,
) {
  const threads = yield* threadsOf
  const state = yield* threadStateOf(run, action.state)
  if (Predicate.isUndefined(action.round) || Predicate.isUndefined(action.thread)) {
    // A crash between the dispatch and its record: the same key sends the same round.
    return yield* dispatchRound(run, state, action, signals)
  }
  const roundId = action.round
  const found = yield* threads.findRound(roundId).pipe(Effect.mapError(threadFault))
  if (Option.isNone(found)) {
    // Recorded, but no send admitted it (a crash, or a refused send): send it again.
    return yield* dispatchRound(run, state, action, signals)
  }
  const view = found.value
  // A move off a maker in flight (a restart between its two commits) settles first.
  if (Predicate.isNotUndefined(action.leaving)) return yield* settleLeaving(run, action, roundId)
  if (view.status !== "ended") {
    // Open, stopped from outside or not: the worker's turn still runs (a
    // stopped turn may hold out in an uninterruptible tool), or it waits
    // for its lane. Its end, which Threads publishes whether the round was
    // stopped or not, decides; a lane wait past patience moves it.
    yield* awaitPatiently(run, state, action, roundId, signals)
    return
  }
  const name = action.state
  if (view.stopped) {
    // The run is running: someone stopped the worker from outside the machine.
    const asking = askingRun(run, {
      state,
      name,
      visit: action.visit,
      reason: "interrupted",
      lead: [
        MachineStep.cases.RoundEnded.make({
          state: name,
          round: roundId,
          dead: true,
          ...roundEndFields(action, state.thread, view),
        }),
        MachineStep.cases.Interrupted.make({ state: name }),
      ],
    })
    yield* commitMove(run, asking.after, asking.steps)
    return
  }
  const verdict: Option.Option<Option.Option<Verdict>> = Option.match(
    Option.fromUndefinedOr(state.on),
    {
      // An unconditional state needs no verdict.
      onNone: () => Option.some(Option.none<Verdict>()),
      onSome: (on) =>
        Schema.decodeUnknownOption(VerdictReply)(view.reply).pipe(
          Option.filter((reply) => Object.hasOwn(on, reply.next)),
          Option.map((reply) => Option.some(reply.next)),
        ),
    },
  )
  const dead = view.interrupted || view.streamFailed || view.unanswered || Option.isNone(verdict)
  const ended = MachineStep.cases.RoundEnded.make({
    state: name,
    round: roundId,
    dead,
    ...roundEndFields(action, state.thread, view),
    ...omitUndefined({
      verdict: Option.getOrUndefined(Option.flatten(verdict)),
    }),
  })
  const value: Schema.Json = { text: view.text, reply: view.reply }
  // A round too big for one round stops on size before a retry, a rerun or
  // its verdict: a round of the same size would hand off again.
  const sizeStop = sizeStopOf(name, state, action, view, Option.flatten(verdict))
  if (Option.isSome(sizeStop)) {
    const { to, note } = sizeStop.value
    return yield* settleRound(run, state, action, action.thread, to, [
      ended,
      MachineStep.cases.Saved.make({ state: name, value }),
      MachineStep.cases.Moved.make({ from: name, to, by: "oversize", note }),
    ])
  }
  if (view.streamFailed && !view.interrupted && Predicate.isNotUndefined(view.retryAt)) {
    // The key is the `Waiting` step's seq: unique in the run, and short on a second death.
    const rerun = PendingAction.cases.Round.make({
      state: action.state,
      visit: action.visit,
      key: `machine:${run.run}:${run.seq + 2}`,
      attempt: action.attempt,
      fresh: true,
      ...omitUndefined({ avoid: action.avoid }),
    })
    let reason: "quota" | "sabbath" = "quota"
    if (view.sabbath === true) reason = "sabbath"
    yield* waitForAccount(run, rerun, { until: view.retryAt, reason }, [
      MachineStep.cases.RoundEnded.make({
        state: name,
        round: roundId,
        dead: true,
        ...roundEndFields(action, state.thread, view),
      }),
    ])
    return
  }
  if (dead && action.attempt === 1) {
    // A dead worker gave no verdict: the round runs once more, on a new thread.
    const retry = PendingAction.cases.Round.make({
      state: action.state,
      visit: action.visit,
      key: `${action.key}:retry`,
      attempt: 2,
      ...omitUndefined({ avoid: action.avoid }),
    })
    yield* commitMove(run, { ...run, pending: Option.some(retry) }, [ended])
    return
  }
  if (dead) {
    const asking = askingRun(run, {
      state,
      name,
      visit: action.visit,
      reason: "no-verdict",
      lead: [ended],
    })
    yield* commitMove(run, asking.after, asking.steps)
    return
  }
  const to = Option.match(Option.flatten(verdict), {
    onNone: () => state.next ?? name,
    onSome: (next) => state.on?.[next] ?? name,
  })
  yield* settleRound(run, state, action, action.thread, to, [
    ended,
    MachineStep.cases.Saved.make({ state: name, value }),
    MachineStep.cases.Moved.make({
      from: name,
      to,
      by: "verdict",
      ...omitUndefined({ verdict: Option.getOrUndefined(Option.flatten(verdict)) }),
    }),
  ])
})

/**
 * Moves the run off an ended round to `to` with `steps` (its end, its saved
 * value, its move), then stops the round's `thread` when the round owned it.
 */
const settleRound = Effect.fn("Machines.settleRound")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
  thread: SessionId,
  to: StateName,
  steps: ReadonlyArray<MachineStep>,
) {
  const committed = yield* commitMove(run, { ...run, state: to, pending: Option.none() }, steps)
  if (Option.isNone(committed) || !ownThread(state, action)) return
  const threads = yield* threadsOf
  yield* threads
    .stop(thread, Option.some(`machine-done:${action.key}`))
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("machines.thread.stop.failed").pipe(
          Effect.annotateLogs({ run: run.run, cause: Cause.pretty(cause) }),
        ),
      ),
    )
})

const runStateOf = Effect.fn("Machines.runStateOf")(function* (run: Run, name: StateName) {
  const state = yield* stateIn(yield* definitionOf(run), name)
  if (state.kind !== "run")
    return yield* new MachineFault({ message: `${name} is not a run state` })
  return state
})

/** The pending command, still the one `action` names: the same state, visit and start. */
const isSameCommand = (pending: Option.Option<PendingAction>, action: CommandAction) =>
  Option.exists(
    pending,
    (current) =>
      current._tag === "Command" &&
      current.state === action.state &&
      current.visit === action.visit &&
      current.startedAt === action.startedAt,
  )

/**
 * Commits a change to the pending command while it is still the pending one
 * and the run still runs; a writer that moved the row first wins.
 */
const whileCommandPending = (
  runId: RunId,
  action: CommandAction,
  change: (run: Run) => { readonly after: RunRecord; readonly steps: ReadonlyArray<MachineStep> },
) =>
  Effect.gen(function* () {
    const store = yield* MachineStore
    while (true) {
      const found = yield* store.read(runId)
      if (Option.isNone(found)) return
      const current = found.value
      if (current.status !== "running" || !isSameCommand(current.pending, action)) return
      const next = change(current)
      if (Option.isSome(yield* store.commit(current, next.after, next.steps))) return
    }
  })

/** How a command ended, as a run state reads it. */
interface CommandEnd {
  readonly exitCode: Option.Option<number>
  readonly timedOut: boolean
  readonly output: string
  /** A pass receipt gave the end: no command ran. */
  readonly reused: boolean
}

// ── pass receipts ───────────────────────────────────────────────────────────

/** One git read of a receipt key; a slower one gives no key, and the command runs. */
const RECEIPT_GIT_TIMEOUT = Duration.seconds(30)

/** A git read's stdout as git printed it; a nonzero exit fails it. */
const receiptGitRaw = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  runProcess("git", args, {
    cwd,
    env: { GIT_TERMINAL_PROMPT: "0", ...env },
    extendEnv: true,
    timeout: RECEIPT_GIT_TIMEOUT,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout)
      return Effect.fail(
        new MachineFault({ message: `git ${args.join(" ")} exited ${result.exitCode}` }),
      )
    }),
  )

/** A git read's trimmed stdout; a nonzero exit fails it. */
const receiptGit = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.map(receiptGitRaw(cwd, args, env), (stdout) => stdout.trim())

/**
 * The tree the checkout holds now, every file git does not ignore included
 * (tracked, changed or new): `git add -A` into a copy of the index, then
 * `git write-tree`. The checkout's own index is not touched.
 */
const inputTree = Effect.fn("Machines.inputTree")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const index = path.resolve(cwd, yield* receiptGit(cwd, ["rev-parse", "--git-path", "index"]))
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-receipt-index-" })
  const scratch = path.join(dir, "index")
  // The copy keeps the index's file stats, so the add hashes only what changed.
  if (yield* fs.exists(index)) yield* fs.copyFile(index, scratch)
  yield* receiptGit(cwd, ["add", "-A"], { GIT_INDEX_FILE: scratch })
  return yield* receiptGit(cwd, ["write-tree"], { GIT_INDEX_FILE: scratch })
}, Effect.scoped)

/**
 * The environment a command inherits, as `env -0` prints it: what the server
 * holds now, read the way the command will read it.
 */
const commandEnvironment = Effect.fn("Machines.commandEnvironment")(function* (cwd: string) {
  const result = yield* runProcess("env", ["-0"], { cwd, timeout: RECEIPT_GIT_TIMEOUT })
  if (result.exitCode !== 0) {
    return yield* new MachineFault({ message: `env -0 exited ${result.exitCode}` })
  }
  const variables = new Map<string, string>()
  for (const entry of result.stdout.split("\0")) {
    const at = entry.indexOf("=")
    if (at > 0) variables.set(entry.slice(0, at), entry.slice(at + 1))
  }
  return variables
})

/**
 * The variables the engine sets on each command it spawns, apart from the
 * environment the server holds: a receipt key leaves them out, since each
 * spawn's differ. Every other variable is in the key.
 */
const ENGINE_COMMAND_ENV: ReadonlySet<string> = new Set(["GENT_COMMAND_TOKEN"])

/**
 * The environment a pass held for: the platform, the gent build, the
 * directory, and every variable the command inherits, sorted, apart from
 * the engine's own (`ENGINE_COMMAND_ENV`).
 */
const envDigest = Effect.fn("Machines.envDigest")(function* (cwd: string) {
  const platform = yield* GentPlatform
  const os = yield* platform.osInfo
  const build = yield* platform.build
  let buildId = "source"
  if (build._tag === "Compiled") buildId = build.id
  const variables = yield* commandEnvironment(cwd)
  const inherited = [...variables]
    .filter(([name]) => !ENGINE_COMMAND_ENV.has(name))
    .sort(([a], [b]) => Order.String(a, b))
  return yield* sha256Hex(
    encodeJsonText({
      platform: os.platform,
      arch: os.arch,
      release: os.release,
      build: buildId,
      cwd,
      env: inherited,
    }),
  )
})

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

/** At most this many ignored files are read at once for `ignoredDigest`. */
const IGNORED_STAT_CONCURRENCY = 128

/**
 * The files git ignores in the checkout (`node_modules`, build output,
 * caches, a local `.env`), each by its path, size, modification time and
 * inode, in one digest: a changed ignored file changes it, and nothing is
 * read but the stats. A file gone between the list and its stat is named
 * gone. gent's own `.gent/` is not an input: a definition written there
 * changes no key.
 */
const ignoredDigest = Effect.fn("Machines.ignoredDigest")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const listed = yield* receiptGitRaw(cwd, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ".",
    ":(exclude).gent",
  ])
  const files = listed.split("\0").filter((file) => file.length > 0)
  const lines = yield* Effect.forEach(
    files,
    (file) =>
      fs.stat(path.join(cwd, file)).pipe(
        Effect.map((info) => {
          const mtime = Option.match(info.mtime, {
            onNone: () => "",
            onSome: (at) => String(at.getTime()),
          })
          const inode = Option.match(info.ino, { onNone: () => "", onSome: String })
          return `${file}\0${info.size}\0${mtime}\0${inode}`
        }),
        Effect.orElseSucceed(() => `${file}\0gone`),
      ),
    { concurrency: IGNORED_STAT_CONCURRENCY },
  )
  return yield* sha256Hex(lines.sort(Order.String).join("\n"))
})

/**
 * The key a pass of `state` at `visit` is kept under, for a state with
 * `reuse` (`ReceiptKey`): the command is rendered as the visit runs it, a
 * shipped file by its content. None when the state has no `reuse` or git
 * cannot say (no repository, no commit): the command runs, and keeps
 * nothing.
 */
const receiptKeyOf = Effect.fn("Machines.receiptKeyOf")(function* (
  run: Run,
  state: RunState,
  visit: number,
  shipped: Readonly<Record<string, string>>,
  bun: string,
) {
  if (state.reuse !== true) return Option.none<ReceiptKey>()
  return yield* Effect.gen(function* () {
    const files: Record<string, string> = {}
    for (const [name, content] of Object.entries(shipped)) {
      files[name] = `file:${yield* sha256Hex(content)}`
    }
    const rendered = render(state.run, {
      ...templateScope(run, visit),
      files,
      bun: Option.some(bun),
    })
    return {
      head: yield* receiptGit(run.cwd, ["rev-parse", "HEAD"]),
      command: yield* sha256Hex(rendered),
      env: yield* envDigest(run.cwd),
      input: yield* inputTree(run.cwd),
      ignored: yield* ignoredDigest(run.cwd),
    } satisfies ReceiptKey
  }).pipe(Effect.option)
})

/**
 * Whether a pass still holds for what the visit left: the same commit,
 * command, environment and tree. The ignored files may differ: a command
 * writes its own build output and caches there, and the pass is kept under
 * the files as it left them.
 */
const passHolds = (before: ReceiptKey, after: ReceiptKey) =>
  before.head === after.head &&
  before.command === after.command &&
  before.env === after.env &&
  before.input === after.input

/** The characters of a command's output an `error` move's note keeps: its last ones. */
const ERROR_NOTE_OUTPUT_CHARS = 1_000

/** A command's move: its target, the edge it took, and the note it carries. */
interface CommandMove {
  readonly to: StateName
  readonly by: string
  readonly note: Option.Option<string>
}

/**
 * Where a command's end moves the run (`RunState`): exit 0 `pass`; with an
 * `error` edge exit 1 `fail` and any other end `error`, with a note; without
 * one any other end `fail`.
 */
const commandMove = (name: StateName, state: RunState, end: CommandEnd): CommandMove => {
  if (Option.contains(end.exitCode, 0))
    return { to: state.on.pass, by: "pass", note: Option.none() }
  const error = Option.fromUndefinedOr(state.on.error)
  if (Option.isNone(error) || Option.contains(end.exitCode, 1)) {
    return { to: state.on.fail, by: "fail", note: Option.none() }
  }
  let how = "did not start"
  if (end.timedOut)
    how = `timed out after ${state.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS} seconds`
  if (Option.isSome(end.exitCode)) how = `exited ${end.exitCode.value}`
  const tail = end.output.trimEnd().slice(-ERROR_NOTE_OUTPUT_CHARS)
  return {
    to: error.value,
    by: "error",
    note: Option.some(
      `Check error: the ${name} command ${how}, so it gave no verdict. Its output ends:\n${tail}`,
    ),
  }
}

/**
 * Runs the pending command in the branch scope: under its named permit, for
 * at most its timeout, with its process committed as soon as the spawn
 * reports it. Its end moves the run and pokes the driver. A closed scope
 * (a passivation, a shutdown) kills the process group and commits nothing:
 * the next activation asks `interrupted`.
 */
const startCommand = Effect.fn("Machines.startCommand")(function* (
  run: Run,
  state: RunState,
  action: CommandAction,
  shipped: Readonly<Record<string, string>>,
) {
  const drivers = yield* MachineDrivers
  const permits = (yield* ExtensionContext).Permits
  // The command outlives this call, in the branch scope: it keeps the services it runs against.
  const services = yield* Effect.context<
    | MachineStore
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | ChildProcessSpawner
    | GentPlatform
  >()
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bun = bunCommand(yield* (yield* GentPlatform).execPath)
  // The definition's files, in a temp directory the command's scope removes.
  const writtenFiles = Effect.gen(function* () {
    const entries = Object.entries(shipped)
    if (entries.length === 0) return {}
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-machine-files-" })
    const written: Record<string, string> = {}
    for (const [name, content] of entries) {
      const file = path.join(dir, name)
      yield* fs.writeFileString(file, content)
      written[name] = file
    }
    return written
  })
  const timeout = Duration.seconds(state.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS)
  const record = (process: CommandProcess) =>
    whileCommandPending(run.run, action, (current) => {
      const recorded = PendingAction.cases.Command.make({ ...action, process })
      return {
        after: { ...current, pending: Option.some(recorded) },
        steps: [MachineStep.cases.Recorded.make({ action: recorded })],
      }
    }).pipe(Effect.orDie, Effect.provideContext(services))
  const ended = (result: CommandEnd) =>
    whileCommandPending(run.run, action, (current) => {
      const { to, by, note } = commandMove(action.state, state, result)
      const outputTail = result.output.slice(-OUTPUT_TAIL_CHARS)
      const value: Schema.Json = {
        exitCode: Option.getOrNull(result.exitCode),
        timedOut: result.timedOut,
        output: outputTail,
        ...omitUndefined({
          reused: Option.getOrUndefined(Option.liftPredicate(true, () => result.reused)),
        }),
      }
      return {
        after: {
          ...current,
          state: to,
          pending: Option.none(),
        },
        steps: [
          MachineStep.cases.CommandEnded.make({
            state: action.state,
            timedOut: result.timedOut,
            outputTail,
            ...omitUndefined({
              exitCode: Option.getOrUndefined(result.exitCode),
              reused: Option.getOrUndefined(Option.liftPredicate(true, () => result.reused)),
            }),
          }),
          MachineStep.cases.Saved.make({ state: action.state, value }),
          MachineStep.cases.Moved.make({
            from: action.state,
            to,
            by,
            ...omitUndefined({
              note: Option.getOrUndefined(note),
              // A screen's pass judges no round: the next check judges them.
              judged: Option.getOrUndefined(
                Option.liftPredicate(false, () => state.screen === true && by === "pass"),
              ),
            }),
          }),
        ],
      }
    })
  // The visit's log: rendered as the command is, so a template names the same visit.
  const logFile = (files: Readonly<Record<string, string>>) =>
    Option.map(Option.fromUndefinedOr(state.log), (log) =>
      path.resolve(
        run.cwd,
        render(log, { ...templateScope(run, action.visit), files, bun: Option.some(bun) }),
      ),
    )
  const commandResult = Effect.gen(function* () {
    const files = yield* writtenFiles
    const scope = { ...templateScope(run, action.visit), files, bun: Option.some(bun) }
    const command = render(state.run, scope)
    return yield* runBashCommand(
      command,
      Option.some(run.cwd),
      Option.map(logFile(files), (file): CommandOutputFile => ({ file, mode: "log" })),
      Option.some({ launch: action.launch, recorded: record }),
    )
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.map(
      Option.match({
        onNone: (): CommandEnd => ({
          exitCode: Option.none(),
          timedOut: true,
          output: "",
          reused: false,
        }),
        onSome: (output): CommandEnd => ({
          exitCode: Option.some(output.exitCode),
          timedOut: false,
          output: [output.stdout, output.stderr].filter((text) => text.length > 0).join("\n"),
          reused: false,
        }),
      }),
    ),
    // A spawn that fails ran nothing: the command fails with the error as its output.
    Effect.catch((error) =>
      Effect.succeed<CommandEnd>({
        exitCode: Option.none(),
        timedOut: false,
        output: String(error),
        reused: false,
      }),
    ),
  )
  const permitted = Option.match(Option.fromUndefinedOr(state.permit), {
    onNone: () => commandResult,
    onSome: (named) =>
      permits
        .with(named.name, named.limit ?? 1, commandResult)
        .pipe(Effect.mapError((error) => new MachineFault({ message: error.message }))),
  })
  const keyed = receiptKeyOf(run, state, action.visit, shipped, bun)
  // A pass is kept under the key as the visit left the checkout, when the
  // pass still holds for it (`passHolds`): a change made while it ran keeps none.
  const keepAfter = (before: ReceiptKey, pass: PassReceipt) =>
    Effect.gen(function* () {
      const after = yield* keyed
      if (Option.isNone(after) || !passHolds(before, after.value)) return
      yield* (yield* MachineStore).keepReceipt(after.value, pass)
    }).pipe(
      Effect.catchTag("MachineStorageError", (error) =>
        Effect.logWarning("machines.receipt.keep.failed").pipe(
          Effect.annotateLogs({ run: run.run, error: error.message }),
        ),
      ),
    )
  // A reused visit's log names the pass it reused, and holds that pass's output.
  const reuseLog = (pass: PassReceipt) =>
    Option.match(logFile({}), {
      onNone: () => Effect.succeed(false),
      onSome: (file) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true })
          yield* fs.writeFileString(
            file,
            `gent ran no command on this visit: it reused the pass of run ${pass.run}, visit ${pass.visit}, at ${isoOf(pass.at)}, at the same head, command, environment and inputs. The end of that pass's output (at most ${OUTPUT_TAIL_CHARS} characters; that visit's log holds all of it):\n${pass.output}`,
          )
          return true
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("machines.receipt.log.failed").pipe(
              Effect.annotateLogs({ run: run.run, file, cause: Cause.pretty(cause) }),
              Effect.as(false),
            ),
          ),
        ),
    })
  // A kept pass at the same key ends the command at once.
  const receipted = Effect.gen(function* () {
    const store = yield* MachineStore
    const key = yield* keyed
    const kept = yield* Effect.transposeOption(Option.map(key, store.receipt)).pipe(
      Effect.map(Option.flatten),
      Effect.catchTag("MachineStorageError", () => Effect.succeedNone),
    )
    if (Option.isSome(key) && Option.isSome(kept)) {
      // The log the reuse wrote is in the checkout now: the next visit reads the key with it.
      if (yield* reuseLog(kept.value)) yield* keepAfter(key.value, kept.value)
      const end: CommandEnd = {
        exitCode: Option.some(0),
        timedOut: false,
        output: kept.value.output,
        reused: true,
      }
      return end
    }
    const result = yield* permitted
    if (Option.isNone(key) || result.timedOut || !Option.contains(result.exitCode, 0)) return result
    const at = yield* Clock.currentTimeMillis
    yield* keepAfter(key.value, {
      output: result.output.slice(-OUTPUT_TAIL_CHARS),
      run: run.run,
      visit: action.visit,
      at,
    })
    return result
  })
  const work = receipted.pipe(
    Effect.flatMap(ended),
    // Permit acquisition failed before spawning: fail the run as a typed
    // machine fault, rather than taking an exit-code edge or logging a defect.
    Effect.catchTag("MachineFault", (fault) => failRun(run.run, fault.message)),
    // The end is committed, or the scope ended the group: no later server
    // needs the receipt. A crash before this keeps it for recovery.
    Effect.ensuring(removeCommandReceipt(action.launch)),
    Effect.andThen(drivers.poke(run.run)),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      return Effect.logWarning("machines.command.failed").pipe(
        Effect.annotateLogs({ run: run.run, cause: Cause.pretty(cause) }),
        Effect.andThen(drivers.poke(run.run)),
      )
    }),
    Effect.provideContext(services),
  )
  yield* drivers.runCommand(run.run, work)
})

/**
 * Stops what a pending command no fiber here runs left: its group, found from
 * the process the spawn copied, else from the launcher's receipt. True when
 * nothing of it runs (`stopLostCommand`).
 */
const stopLostAction = (action: CommandAction) =>
  stopLostCommand(Option.fromUndefinedOr(action.process), Option.some(action.launch))

/**
 * A pending command no fiber of this process runs: a stop or a crash cut it
 * short, so it is never run again. Its recorded process group is stopped; a
 * group that is not shown gone may still run, and the ask offers no retry.
 */
const recoverCommand = Effect.fn("Machines.recoverCommand")(function* (
  run: Run,
  action: CommandAction,
) {
  const state = yield* runStateOf(run, action.state)
  const gone = yield* stopLostAction(action)
  const asking = askingRun(run, {
    state,
    name: action.state,
    visit: action.visit,
    reason: "interrupted",
    mayStillRun: !gone,
    lead: [MachineStep.cases.Interrupted.make({ state: action.state })],
  })
  yield* commitMove(run, asking.after, asking.steps)
})

/**
 * Stops what a stopped run left open (`stopPending`), then settles it: the
 * `Settled` step says when a process of it may still run. Settled, the run
 * wakes nobody.
 */
const settleStop = Effect.fn("Machines.settleStop")(function* (run: Run) {
  const mayStillRun = yield* Option.match(run.pending, {
    onNone: () => Effect.succeed(false),
    onSome: (action) => stopPending(run, action),
  })
  if (mayStillRun) {
    yield* Effect.logWarning("machines.stop.unproven").pipe(Effect.annotateLogs({ run: run.run }))
  }
  yield* commitMove(
    run,
    { ...run, pending: Option.none(), notifiedAt: Option.some(yield* Clock.currentTimeMillis) },
    [
      MachineStep.cases.Settled.make(
        omitUndefined({
          mayStillRun: Option.getOrUndefined(Option.liftPredicate(mayStillRun, Boolean)),
        }),
      ),
    ],
  )
})

/**
 * Stops what a pending action left open; true when a process of it may
 * still run. A round is found by its id, which the key fixes, so a round a
 * send admitted is stopped even when its receipt was never committed, and a
 * thread that never got the round (a refused send) is left alone. A command
 * is ended through its fiber here, else through its recorded process group;
 * a group not shown gone, or one with no record, may still run. A round
 * whose thread Threads refuses (`ThreadError`) may still run too. Any other
 * failure fails the step, and the driver tries it again after its backoff.
 */
const stopPending = (run: Run, action: PendingAction) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Ask: () => Effect.succeed(false),
      Round: (round) =>
        Effect.gen(function* () {
          const threads = yield* threadsOf
          const roundId = yield* Option.match(Option.fromUndefinedOr(round.round), {
            onSome: Effect.succeed,
            onNone: () => threads.sendRound(round.key),
          })
          const found = yield* threads.findRound(roundId)
          if (Option.isSome(found) && found.value.status !== "ended") {
            yield* threads.stop(found.value.thread, Option.some(`machine-stop:${run.run}`))
          }
          return false
        }).pipe(
          // Threads refused (the round's thread is not this session's now): no
          // stop reaches the worker, and no later try would.
          Effect.catchTag("ThreadError", (error) =>
            Effect.logWarning("machines.stop.round.refused").pipe(
              Effect.annotateLogs({ run: run.run, error: error.message }),
              Effect.as(true),
            ),
          ),
        ),
      Command: (command) =>
        Effect.gen(function* () {
          const drivers = yield* MachineDrivers
          const fiber = yield* drivers.command(run.run)
          if (Option.isSome(fiber)) {
            // The fiber's scope ends the process group as it closes.
            yield* Fiber.interrupt(fiber.value)
            return false
          }
          return !(yield* stopLostAction(command))
        }),
      // The push itself is never undone; the gate loses its waiter, and a
      // later loop open adopts it.
      Integrate: (integrate) => Effect.as(releaseGate(integrate), false),
    }),
  )

/**
 * Where the next owner message lands: the place saved for it, else the
 * owner thread's current place, saved first, so a second delivery after a
 * crash goes where the first went. A saved place whose session is gone is
 * replaced once.
 */
const deliveryPlaceOf = Effect.fn("Machines.deliveryPlace")(function* (run: Run) {
  const ctx = yield* ExtensionContext
  const saved = run.deliveryPlace
  if (Option.isSome(saved)) {
    const session = yield* ctx.Session.getSession(saved.value.sessionId)
    if (Predicate.isNotUndefined(session)) return Option.some({ run, place: saved.value })
  }
  const place = yield* currentThreadPlace({ sent: run.host, thread: run.ownerThread })
  const committed = yield* commitMove(run, { ...run, deliveryPlace: Option.some(place) }, [
    MachineStep.cases.PlaceSaved.make({ place }),
  ])
  return Option.map(committed, (next) => ({ run: next, place }))
})

/** Sends one owner message under `sourceId`, then commits `after`; the queue drops a repeat. */
const deliver = Effect.fn("Machines.deliver")(function* (
  run: Run,
  message: {
    readonly sourceId: string
    readonly content: string
    readonly customType: string
    readonly details: Schema.Json
  },
  settle: (
    run: Run,
    at: number,
  ) => { readonly after: RunRecord; readonly steps: ReadonlyArray<MachineStep> },
) {
  const ctx = yield* ExtensionContext
  const target = yield* deliveryPlaceOf(run)
  if (Option.isNone(target)) return
  yield* ctx.Session.send({
    delivery: "queue",
    ...target.value.place,
    sourceId: message.sourceId,
    wake: true,
    content: message.content,
    metadata: { customType: message.customType, details: message.details },
  })
  const settled = settle(target.value.run, yield* Clock.currentTimeMillis)
  yield* commitMove(
    target.value.run,
    { ...settled.after, deliveryPlace: Option.none() },
    settled.steps,
  )
})

const reasonLine = (action: AskAction, state: MachineState, scope: TemplateScope) => {
  switch (action.reason) {
    case "asked":
      if (state.kind === "ask") return render(state.ask, scope)
      return "The run asks."
    case "no-verdict":
      return "The worker gave no verdict twice: a dead round, no thread.reply, or a reply whose next is not a choice."
    case "exhausted":
      return `The state was visited past its cap (visit ${action.visit}).`
    case "interrupted":
      if (state.kind === "run" && action.mayStillRun === true) {
        return "The command was cut short, and its process may still run: retry is not offered."
      }
      if (state.kind === "run") return "The command was cut short; its output is lost."
      return "The worker's round was stopped from outside the machine."
  }
}

const deliverAsk = Effect.fn("Machines.deliverAsk")(function* (run: Run, action: AskAction) {
  const definition = yield* definitionOf(run)
  const state = yield* stateIn(definition, action.state)
  const scope = templateScope(run, action.visit)
  const line = reasonLine(action, state, scope)
  const required = Option.fromUndefinedOr(action.requires)
  const content = [
    `Machine ${run.machine} (${run.run}) asks at ${action.state} (${action.reason}).`,
    line,
    ...Option.toArray(Option.map(required, requirementLine)),
    `Choices: ${action.choices.join(" | ")}`,
    `Answer with machine.answer({ run: "${run.run}", askId: "${action.askId}", choice }).`,
  ].join("\n")
  const details: Schema.Json = {
    run: run.run,
    machine: run.machine,
    askId: action.askId,
    state: action.state,
    reason: action.reason,
    choices: [...action.choices],
    ...omitUndefined({
      mayStillRun: action.mayStillRun,
      requires: Option.getOrUndefined(
        Option.map(required, (requires) => ({
          file: requires.file,
          headings: [...requires.headings],
          choices: [...requires.choices],
        })),
      ),
    }),
  }
  yield* deliver(
    run,
    { sourceId: `machine-ask:${action.askId}`, content, customType: MACHINE_ASK_TYPE, details },
    (current, at) => ({
      after: {
        ...current,
        pending: Option.some(PendingAction.cases.Ask.make({ ...action, deliveredAt: at })),
      },
      steps: [MachineStep.cases.Delivered.make({ askId: action.askId })],
    }),
  )
})

/** Tells the owner a run reached a final state or failed, once. */
const notifyEnd = Effect.fn("Machines.notifyEnd")(function* (run: Run) {
  let content = `${run.machine} finished in ${run.state}`
  if (run.status === "failed") {
    content = `${run.machine} (${run.run}) failed: ${Option.getOrElse(run.error, () => "unknown")}`
  } else {
    const definition = decodeDefinitionJson(run.definitionJson)
    const say = Option.flatMap(definition, (found) => {
      const state = found.states[run.state]
      if (Predicate.isUndefined(state) || state.kind !== "final") return Option.none()
      return Option.fromUndefinedOr(state.say)
    })
    if (Option.isSome(say)) content = render(say.value, templateScope(run, 1))
  }
  const details: Schema.Json = {
    run: run.run,
    machine: run.machine,
    status: run.status,
    state: run.state,
    ...omitUndefined({ error: Option.getOrUndefined(run.error) }),
  }
  yield* deliver(
    run,
    { sourceId: `machine-end:${run.run}`, content, customType: MACHINE_END_TYPE, details },
    (current, at) => ({
      after: { ...current, notifiedAt: Option.some(at) },
      steps: [MachineStep.cases.Notified.make({})],
    }),
  )
})

// ── ask and answer ──────────────────────────────────────────────────────────

/** The caller's thread key: the thread its session belongs to. */
const callerThread = Effect.fn("Machines.callerThread")(function* () {
  const ctx = yield* ExtensionContext
  const caller = yield* ctx.Session.getSession(ctx.sessionId)
  return Option.getOrElse(
    Option.map(Option.fromUndefinedOr(caller), sessionThread),
    () => ctx.sessionId,
  )
})

/** The run, read by a session of its owner's thread. */
const ownedRun = Effect.fn("Machines.ownedRun")(function* (runId: RunId) {
  const store = yield* MachineStore
  const found = yield* store.read(runId)
  if (Option.isNone(found)) return yield* new MachineError({ message: `No run ${runId}` })
  const owner = yield* callerThread()
  if (found.value.ownerThread !== owner) {
    return yield* new MachineError({
      message: `Run ${runId} belongs to another thread; machine.list shows yours`,
    })
  }
  return found.value
})

/** Fires the host's record now: its fire reads the row the caller committed. */
const kick = Effect.fn("Machines.kick")(function* (run: Run) {
  const ctx = yield* ExtensionContext
  yield* ctx.Session.wakeAt({
    ...run.host,
    sourceId: runSource(run.run),
    at: yield* Clock.currentTimeMillis,
  })
})

/** Where a choice takes the run, by the ask's reason and state (B2). */
const moveFor = (state: MachineState, action: AskAction, choice: Verdict) => {
  if (choice === "stop") return { stop: true, to: action.state }
  if (choice === "retry") return { stop: false, to: action.state }
  if (state.kind === "thread" && choice === "continue") {
    return { stop: false, to: state.next ?? action.state }
  }
  if (state.kind === "run") {
    if (choice === "pass") return { stop: false, to: state.on.pass }
    if (choice === "error") return { stop: false, to: state.on.error ?? state.on.fail }
    return { stop: false, to: state.on.fail }
  }
  if (state.kind === "integrate") {
    if (choice === "green") return { stop: false, to: state.on.green }
    return { stop: false, to: state.on.red }
  }
  if (state.kind === "thread" || state.kind === "ask") {
    return { stop: false, to: state.on?.[choice] ?? action.state }
  }
  return { stop: true, to: action.state }
}

/**
 * The ask state's requirement, when this visit owes its file: the run owes it
 * from an earlier visit (`RunMemo.owed`), or entered this one by one of its
 * `after` edges (a verdict move by its verdict, any other move by its `by`).
 */
const requirementOf = (
  run: Run,
  state: MachineState,
  name: StateName,
): Option.Option<AnswerRequirement> => {
  if (state.kind !== "ask") return Option.none()
  const entry = Option.map(
    Option.filter(run.lastMove, (move) => move.to === name),
    (move) => move.verdict ?? move.by,
  )
  return Option.filter(
    Option.fromUndefinedOr(state.requires),
    (requires) =>
      run.owed.has(name) ||
      Option.exists(entry, (edge) => requires.after.some((after) => after === edge)),
  )
}

/** The file's text, or none when the run's cwd holds no file there. */
const fileText = Effect.fn("Machines.fileText")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(Effect.option)
})

/**
 * The requirement as the ask of this visit applies it, when the visit owes
 * the file: the file resolved from the run's cwd, and the digest of its text
 * at the ask, the mark an answer's file must differ from.
 */
const appliedRequirement = Effect.fn("Machines.appliedRequirement")(function* (
  run: Run,
  state: MachineState,
  name: StateName,
  visit: number,
) {
  const requires = requirementOf(run, state, name)
  if (Option.isNone(requires)) return Option.none<AppliedRequirement>()
  const path = yield* Path.Path
  const file = path.resolve(run.cwd, render(requires.value.file, templateScope(run, visit)))
  const text = yield* fileText(file)
  const digest = yield* Effect.transposeOption(Option.map(text, sha256Hex))
  return Option.some<AppliedRequirement>({
    choices: requires.value.choices,
    file,
    headings: requires.value.headings,
    ...omitUndefined({ digest: Option.getOrUndefined(digest) }),
  })
})

/** The text under each markdown heading of `content`, by its lowercased heading. */
const sectionsOf = (content: string): ReadonlyMap<string, string> => {
  const sections = new Map<string, string>()
  let current = Option.none<string>()
  for (const line of content.split(/\r?\n/)) {
    const heading = Option.fromNullishOr(/^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line))
    if (Option.isSome(heading)) {
      const name = (heading.value[1] ?? "").toLowerCase()
      current = Option.some(name)
      sections.set(name, sections.get(name) ?? "")
      continue
    }
    for (const name of Option.toArray(current)) {
      sections.set(name, `${sections.get(name) ?? ""}${line}\n`)
    }
  }
  return sections
}

/**
 * What the requirement's file lacks for its ask: none when its text changed
 * since the ask (a digest that differs from the recorded one, so a touched or
 * copied stale file does not pass) and holds text under each heading.
 */
const requirementGaps = Effect.fn("Machines.requirementGaps")(function* (
  requires: AppliedRequirement,
) {
  const content = yield* fileText(requires.file)
  if (Option.isNone(content)) return ["no file"]
  const digest = yield* sha256Hex(content.value)
  if (digest === requires.digest) return ["unchanged since the ask"]
  const sections = sectionsOf(content.value)
  return requires.headings.flatMap((heading) => {
    const text = sections.get(heading.toLowerCase())
    if (Predicate.isUndefined(text)) return [`no heading ${heading}`]
    if (text.trim().length === 0) return [`nothing under ${heading}`]
    return []
  })
})

/** The ask's line on a requirement: which choices need which file. */
const requirementLine = (requires: AppliedRequirement) =>
  `Before ${requires.choices.join(", ")}: write ${requires.file} with text under the headings ${requires.headings.join(", ")}; the run refuses those choices until it holds them, changed since this ask.`

/**
 * Whether the answer meets the ask's requirement: true when `choice` is one
 * it guards and the recorded file changed and holds every heading, false when
 * it guards nothing here. Refuses (`unmet`) a guarded choice whose file has
 * a gap, and one on a visit that owes the file but whose ask kept no record.
 */
const requirementMet = Effect.fn("Machines.requirementMet")(function* (
  run: Run,
  state: MachineState,
  action: AskAction,
  choice: Verdict,
) {
  const ask = { askId: action.askId, choices: action.choices }
  const owes = Option.isSome(
    Option.filter(requirementOf(run, state, action.state), (requires) =>
      requires.choices.includes(choice),
    ),
  )
  // The ask records what it applied; a visit that owes the file with no record refuses.
  if (owes && Predicate.isUndefined(action.requires)) {
    return yield* new MachineAnswerRefused({
      message: `Answer refused (unmet): ${choice} needs the file ${action.state}'s requires names, and ask ${action.askId} kept no record of it at its dispatch`,
      reason: "unmet",
      ask,
    })
  }
  const required = Option.filter(Option.fromUndefinedOr(action.requires), (requires) =>
    requires.choices.includes(choice),
  )
  if (Option.isNone(required)) return false
  const gaps = yield* requirementGaps(required.value)
  if (gaps.length > 0) {
    return yield* new MachineAnswerRefused({
      message: `Answer refused (unmet): ${choice} needs ${required.value.file} with text under ${required.value.headings.join(", ")}, changed since this ask: ${gaps.join("; ")}`,
      reason: "unmet",
      ask,
    })
  }
  return true
})

/** `machine.answer`'s input; exported, with the tool, for a test that runs two answers at once. */
export const AnswerParams = Schema.Struct({
  run: RunId.annotate({ description: "The run, from machine.start or machine.list." }),
  askId: AskId.annotate({ description: "The ask's id, from the ask message." }),
  choice: Verdict.annotate({ description: "One of the choices the ask offers." }),
  note: Schema.optionalKey(
    Schema.String.annotate({ description: "Words the run saves with the choice." }),
  ),
})
type AnswerParams = typeof AnswerParams.Type

/**
 * Answers one ask. The checks run in one fixed order, and the first that
 * holds decides: an ask that was answered is decided by that answer (the
 * same choice and note are admitted again, any other conflicts); an ask that
 * was never answered and is no longer current is stale; a choice the current
 * ask does not offer is invalid; a choice whose required file is missing or
 * incomplete is unmet, and the run stays at the ask. The answer commits, then kicks the host; a
 * commit another writer beat starts again from the top.
 */
const answer = Effect.fn("Machines.answer")(function* (params: AnswerParams) {
  const store = yield* MachineStore
  while (true) {
    const run = yield* ownedRun(params.run)
    const prior = yield* store.answered(run.run, params.askId)
    if (Option.isSome(prior)) {
      if (prior.value.choice === params.choice && prior.value.note === params.note) {
        yield* kick(run)
        return { run: run.run, status: "admitted" as const }
      }
      return yield* new MachineAnswerRefused({
        message: `Answer refused (conflict): ask ${params.askId} was answered ${prior.value.choice}`,
        reason: "conflict",
      })
    }
    const current = Option.filter(
      run.pending,
      (action): action is AskAction =>
        run.status === "asking" && action._tag === "Ask" && action.askId === params.askId,
    )
    if (Option.isNone(current)) {
      const ask = Option.flatMap(run.pending, (action) => {
        if (action._tag !== "Ask" || run.status !== "asking") return Option.none()
        return Option.some({ askId: action.askId, choices: action.choices })
      })
      return yield* new MachineAnswerRefused({
        message: `Answer refused (stale): ask ${params.askId} is not the run's current ask`,
        reason: "stale",
        ...omitUndefined({ ask: Option.getOrUndefined(ask) }),
      })
    }
    const action = current.value
    if (!action.choices.includes(params.choice)) {
      return yield* new MachineAnswerRefused({
        message: `Answer refused (invalid): ${params.choice} is not one of ${action.choices.join(", ")}`,
        reason: "invalid",
        ask: { askId: action.askId, choices: action.choices },
      })
    }
    const definition = yield* definitionOf(run).pipe(
      Effect.mapError((fault) => new MachineError({ message: fault.message })),
    )
    const state = yield* stateIn(definition, action.state).pipe(
      Effect.mapError((fault) => new MachineError({ message: fault.message })),
    )
    const met = yield* requirementMet(run, state, action, params.choice)
    const move = moveFor(state, action, params.choice)
    // An answer that chose a thread state's verdict moves the run as that verdict would.
    const verdict = Option.liftPredicate(
      params.choice,
      (choice) => state.kind === "thread" && Object.hasOwn(state.on ?? {}, choice),
    )
    const answered = MachineStep.cases.Answered.make({
      askId: action.askId,
      choice: params.choice,
      ...omitUndefined({ note: params.note }),
    })
    const value: Schema.Json = { choice: params.choice, ...omitUndefined({ note: params.note }) }
    // A retry of an exhausted ask grants the state one visit past its cap.
    const granted = Option.liftPredicate(
      MachineStep.cases.Granted.make({ state: action.state }),
      () => params.choice === "retry" && action.reason === "exhausted",
    )
    let after: RunRecord = { ...run, status: "running", state: move.to, pending: Option.none() }
    let steps: ReadonlyArray<MachineStep> = [
      answered,
      MachineStep.cases.Saved.make({ state: action.state, value }),
      ...Option.toArray(granted),
      MachineStep.cases.Moved.make({
        from: action.state,
        to: move.to,
        by: "answer",
        ...omitUndefined({
          verdict: Option.getOrUndefined(verdict),
          met: Option.getOrUndefined(Option.liftPredicate(met, Boolean)),
        }),
      }),
    ]
    if (move.stop) {
      after = { ...run, status: "stopped", pending: Option.none() }
      steps = [answered, MachineStep.cases.Stopped.make({})]
    }
    const committed = yield* store.commit(run, after, steps)
    if (Option.isNone(committed)) continue
    yield* kick(committed.value)
    return { run: run.run, status: "admitted" as const }
  }
})

/** Stops a run: committed first, then the host is kicked and its driver stops what is open. */
const stopRun = Effect.fn("Machines.stop")(function* (runId: RunId) {
  const store = yield* MachineStore
  while (true) {
    const run = yield* ownedRun(runId)
    if (run.status === "stopped") {
      if (Option.isNone(run.notifiedAt)) yield* kick(run)
      return { run: run.run, status: "stopped" as const }
    }
    if (isTerminal(run.status)) {
      return yield* new MachineError({ message: `Run ${runId} already ended: ${run.status}` })
    }
    const ctx = yield* ExtensionContext
    // Publish a start-only trigger before the stop. A future wait may still
    // replace the immediate kick, and a crash may prevent that kick entirely.
    yield* ctx.Session.wakeAt({ ...run.host, sourceId: stopSource(run.run) })
    const committed = yield* store.commit(run, { ...run, status: "stopped" }, [
      MachineStep.cases.Stopped.make({}),
    ])
    if (Option.isNone(committed)) continue
    yield* kick(committed.value)
    return { run: run.run, status: "stopped" as const }
  }
})

// ── tools ───────────────────────────────────────────────────────────────────

/** The project file a definition lives in. */
const definitionPath = Effect.fn("Machines.definitionPath")(function* (name: string) {
  const ctx = yield* ExtensionContext
  const path = yield* Path.Path
  return path.join(ctx.cwd, ".gent", "machines", `${name}.json`)
})

const sha256Hex = Effect.fn("Machines.sha256")(function* (text: string) {
  const crypto = yield* Crypto.Crypto
  return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(text)))
})

const DefineResult = Schema.Struct({
  name: MachineName,
  path: Schema.String,
  /** The SHA-256 of the file, 16 hex. */
  digest: Schema.String,
  written: Schema.Boolean,
})

/**
 * Where a definition's project file stands after a write: `written` where
 * no file was, `upgraded` from a shipped version nobody edited since gent
 * wrote it, `unchanged` when it already holds the definition, or `kept` --
 * a file of the owner's a ship leaves as it was.
 */
type DefinitionWrite = "written" | "upgraded" | "unchanged" | "kept"

/**
 * A definition the `machine.define` checks admit, its project file, and
 * the file's text with no marker and with the shipped one: the marker is
 * the unmarked text's digest (16 hex).
 */
const definitionText = Effect.fn("Machines.definitionText")(function* (
  proposed: MachineDefinition,
) {
  const definition = yield* checkedDefinition(proposed)
  const path = yield* definitionPath(definition.name)
  const text = `${yield* Schema.encodeEffect(DefinitionFile)(definition)}\n`
  const digest = (yield* sha256Hex(text)).slice(0, 16)
  const marked = `${yield* Schema.encodeEffect(DefinitionFile)({ shipped: digest, ...definition })}\n`
  return { name: definition.name, path, digest, text, marked }
})

/** A file's text, or none when no file is there: an unreadable one fails. */
const readIfThere = Effect.fn("Machines.readIfThere")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  )
})

/** Whether a file's text is a shipped write nobody edited: without its marker line it hashes to the marker. */
const untouchedShipped = Effect.fn("Machines.untouchedShipped")(function* (text: string) {
  const mark = Option.fromNullOr(SHIPPED_MARK.exec(text))
  if (Option.isNone(mark)) return false
  const unmarked = `{\n${text.slice(mark.value[0].length)}`
  return (yield* sha256Hex(unmarked)).slice(0, 16) === mark.value[1]
})

/** Writes `text` to a new file at `staged` and syncs it, so a rename or link publishes text the disk holds. */
const stageFile = (staged: string, text: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const handle = yield* fs.open(staged, { flag: "wx" })
      yield* handle.writeAll(new TextEncoder().encode(text))
      yield* handle.sync
    }),
  )

/** `machine.define`'s write: the file becomes the definition, with no marker, so it is the owner's. */
const defineFile = Effect.fn("Machines.defineFile")(function* (proposed: MachineDefinition) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { text, marked: _marked, ...target } = yield* definitionText(proposed)
  if (Option.contains(yield* readIfThere(target.path), text)) {
    return { ...target, outcome: "unchanged" as const }
  }
  yield* fs.makeDirectory(path.dirname(target.path), { recursive: true })
  yield* writeFileAtomic(target.path, text)
  return { ...target, outcome: "written" as const }
})

/** A definition as JSON holds it, before the schema brands its names. */
export type MachineDefinitionJson = typeof MachineDefinition.Encoded

/**
 * Writes a definition another extension ships, through the checks
 * `machine.define` runs, marked as shipped (`DefinitionFile`). A file a
 * ship wrote that nobody edited since is replaced by this version
 * (`upgraded`); any other file of that name -- edited, written by
 * `machine.define`, or by a gent before the marker -- is the owner's: it is
 * kept, and the outcome says so. A ship never replaces a file that appeared
 * or changed since its read: a new file is published by a hard link, which
 * fails on a file already there, and an upgrade reads the file again after
 * staging and renames only over the text it read. The window left is that
 * second read to the rename.
 */
export const shipDefinition = Effect.fn("Machines.shipDefinition")(function* (
  definition: MachineDefinitionJson,
) {
  const decoded = yield* Schema.decodeEffect(MachineDefinition)(definition).pipe(
    Effect.mapError((cause) => new MachineError({ message: `Not a machine: ${cause.message}` })),
  )
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const { text, marked, ...target } = yield* definitionText(decoded)
  const result = (outcome: DefinitionWrite) => ({ ...target, outcome })
  // The file holds this definition, as a ship or as machine.define wrote it.
  const settled = (found: Option.Option<string>) => {
    if (Option.contains(found, marked) || Option.contains(found, text)) return result("unchanged")
    return result("kept")
  }
  const before = yield* readIfThere(target.path)
  if (Option.isSome(before)) {
    const found = settled(before)
    if (found.outcome === "unchanged" || !(yield* untouchedShipped(before.value))) return found
  }
  yield* fs.makeDirectory(path.dirname(target.path), { recursive: true })
  const staged = `${target.path}.${yield* crypto.randomUUIDv7()}.tmp`
  const publish = Option.match(before, {
    // A hard link fails on a file that appeared since the read.
    onNone: () =>
      fs.link(staged, target.path).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      ),
    // A rename replaces only the text the decision read.
    onSome: (read) =>
      Effect.flatMap(readIfThere(target.path), (now) => {
        if (!Option.contains(now, read)) return Effect.succeed(false)
        return Effect.as(fs.rename(staged, target.path), true)
      }),
  })
  const published = yield* stageFile(staged, marked).pipe(
    Effect.andThen(publish),
    Effect.ensuring(fs.remove(staged).pipe(Effect.ignore)),
  )
  if (!published) return settled(yield* readIfThere(target.path))
  if (Option.isSome(before)) return result("upgraded")
  return result("written")
})

const MachineDefineTool = tool({
  id: "machine.define",
  resources: [MachineStoreResource],
  description:
    "Define a machine: a state machine of thread rounds, commands and asks that runs with no turn of yours between its steps. Writes .gent/machines/<name>.json in the project; the same content writes nothing. A refusal lists every problem.",
  promptSnippet: "Define a reusable state machine of rounds, commands and asks",
  params: Schema.Struct({ definition: MachineDefinition }),
  output: DefineResult,
  execute: Effect.fn("MachineDefineTool.execute")(function* (params) {
    const { outcome, ...written } = yield* defineFile(params.definition)
    return { ...written, written: outcome === "written" }
  }),
})

const StartParamsSchema = Schema.Struct({
  machine: MachineName.annotate({ description: "The machine's name, as machine.define wrote it." }),
  input: Schema.optionalKey(
    Schema.Json.annotate({ description: "The run's input: templates read it as {{input.*}}." }),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Where the run's threads start and its commands run; default yours.",
    }),
  ),
})

const MachineStartTool = tool({
  id: "machine.start",
  resources: [MachineStoreResource, MachineDriversResource],
  description:
    "Start a run of a defined machine and return at admission, never its outcome. The run moves through its states with no turn of yours: you are woken only when it asks, reaches a final state, or fails.",
  promptSnippet: "Start a run of a defined machine",
  promptGuidelines: [
    "After machine.start, end your turn: an ask, the run's end and a failure each wake you as a message. Do not poll machine.status.",
    "Answer an ask with machine.answer, with the run, the askId and one of its choices.",
  ],
  params: StartParamsSchema,
  output: Schema.Struct({ run: RunId, state: StateName }),
  execute: Effect.fn("MachineStartTool.execute")(function* (params) {
    const ctx = yield* ExtensionContext
    const store = yield* MachineStore
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (Option.isNone(yield* Effect.serviceOption(Threads))) {
      return yield* new MachineError({
        message: "machine.start needs the threads of @gent/session-tools",
      })
    }
    const toolCallId = yield* Effect.fromOption(
      Option.fromUndefinedOr(ctx.toolCallId),
      () => new MachineError({ message: "machine.start requires a host-owned tool call" }),
    )
    const file = yield* definitionPath(params.machine)
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError(
          () =>
            new MachineError({ message: `No machine ${params.machine}: ${file} is not readable` }),
        ),
      )
    // Read as the file it is; the run's definition encoding has no marker.
    const definition = yield* Schema.decodeEffect(DefinitionFile)(text).pipe(
      Effect.mapError(
        (cause) => new MachineError({ message: `${file} is not a machine: ${cause.message}` }),
      ),
      Effect.flatMap(checkedDefinition),
    )
    if (definition.name !== params.machine) {
      return yield* new MachineError({
        message: `${file} defines ${definition.name}, not ${params.machine}`,
      })
    }
    const digest = yield* sha256Hex([ctx.sessionId, ctx.branchId, toolCallId].join("\n"))
    const runId = RunId.make(`run-${digest.slice(0, 16)}`)
    const existing = yield* store.read(runId)
    if (Option.isSome(existing)) return { run: runId, state: existing.value.state }
    const cwd = path.resolve(ctx.cwd, params.cwd ?? ".")
    yield* checkRemotes(definition, cwd)
    yield* checkRoles(definition, cwd)
    const host = { sessionId: ctx.sessionId, branchId: ctx.branchId }
    const input = params.input ?? {}
    yield* checkVia(definition, input)
    const run: RunRecord = {
      run: runId,
      machine: definition.name,
      definitionJson: yield* Schema.encodeEffect(DefinitionJson)(definition),
      host,
      ownerThread: yield* callerThread(),
      deliveryPlace: Option.none(),
      cwd,
      input,
      roles: {},
      state: definition.start,
      status: "running",
      pending: Option.none(),
      seq: 1,
      notifiedAt: Option.none(),
      error: Option.none(),
      createdAt: yield* Clock.currentTimeMillis,
    }
    // The record first: a stop before the row leaves a record the hook drops.
    yield* ctx.Session.wakeAt({ ...host, sourceId: runSource(runId) })
    const project = yield* ctx.Accounts.project(cwd)
    yield* store.insert(
      run,
      MachineStep.cases.Started.make({ machine: definition.name, input, project }),
    )
    yield* armDriver(runId)
    return { run: runId, state: definition.start }
  }),
})

export const MachineAnswerTool = tool({
  id: "machine.answer",
  resources: [MachineStoreResource],
  description:
    "Answer a run's ask with one of its choices, and return at admission. The same answer again is admitted again; another answer to an answered ask conflicts, and an answer to an ask that is no longer current is stale.",
  promptSnippet: "Answer a machine run's ask",
  params: AnswerParams,
  output: Schema.Struct({ run: RunId, status: Schema.Literal("admitted") }),
  execute: (params) => answer(params),
})

const StepView = Schema.Struct({ seq: Schema.Int, at: Schema.Finite, step: MachineStep })

/** One run as `machine.list` and `MachinesRpc.Runs` show it, with no steps. */
export const MachineRunView = Schema.Struct({
  run: RunId,
  machine: MachineName,
  state: StateName,
  status: RunStatus,
  pending: Schema.optionalKey(PendingAction),
  visits: Schema.Record(Schema.String, Count),
  error: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
})
export type MachineRunView = typeof MachineRunView.Type

const runView = (run: Run): MachineRunView => ({
  run: run.run,
  machine: run.machine,
  state: run.state,
  status: run.status,
  visits: run.visits.counts,
  createdAt: run.createdAt,
  ...omitUndefined({
    pending: Option.getOrUndefined(run.pending),
    error: Option.getOrUndefined(run.error),
  }),
})

/**
 * How one model fared in one state of a machine, over every run of it. A
 * check (a command's `pass` or `fail`, except a screen's pass: `RunState.screen`)
 * and a gate (`green` or `red`) count for each model that ran a round since
 * the run's last one. `accepted`: the
 * runs it had rounds in that reached a final state that accepts the work,
 * and those rounds, so `rounds / runs` is
 * what a run that got there took of it.
 */
export const ModelQuality = Schema.Struct({
  state: StateName,
  model: ModelId,
  rounds: Count,
  /** Rounds that ended with no verdict. */
  dead: Count,
  /** Rounds that stopped on size (`oversize`), whatever they replied. */
  oversize: Count,
  /** Rounds whose turn was priced, and their summed cost. */
  priced: Count,
  costUsd: Schema.Finite,
  verdicts: Schema.Record(Schema.String, Count),
  checks: Schema.Struct({ pass: Count, fail: Count }),
  gates: Schema.Struct({ green: Count, red: Count }),
  accepted: Schema.Struct({ runs: Count, rounds: Count }),
})
export type ModelQuality = typeof ModelQuality.Type

/** One state and model's record while it is counted. */
interface QualityTally {
  readonly state: StateName
  readonly model: ModelId
  rounds: number
  dead: number
  oversize: number
  priced: number
  costUsd: number
  // A verdict is the model's own word: a Map, so `constructor` counts as itself.
  readonly verdicts: Map<string, number>
  readonly checks: { pass: number; fail: number }
  readonly gates: { green: number; red: number }
  readonly accepted: { runs: number; rounds: number }
}

/**
 * What one run's log has counted so far: each row's rounds in it, the row of
 * its latest round, and the rows a check or a gate has yet to judge.
 */
interface RunTally {
  readonly rounds: Map<QualityTally, number>
  latest: Option.Option<QualityTally>
  readonly sinceCheck: Set<QualityTally>
  readonly sinceGate: Set<QualityTally>
}

/** The `by` of a command's move, and of an integrate's. */
const isCheckMove = Schema.is(Schema.Literals(["pass", "fail"]))
const isGateMove = Schema.is(Schema.Literals(["green", "red"]))

const tallyRound = (row: QualityTally, step: RoundEnded, run: RunTally): void => {
  row.rounds += 1
  if (step.dead) row.dead += 1
  if (Predicate.isNotUndefined(step.costUsd)) {
    row.priced += 1
    row.costUsd += step.costUsd
  }
  if (Predicate.isNotUndefined(step.verdict)) {
    row.verdicts.set(step.verdict, (row.verdicts.get(step.verdict) ?? 0) + 1)
  }
  run.rounds.set(row, (run.rounds.get(row) ?? 0) + 1)
  run.latest = Option.some(row)
  run.sinceCheck.add(row)
  run.sinceGate.add(row)
}

const tallyMove = (step: MovedStep, run: RunTally): void => {
  const by = step.by
  // A size stop moves off the round that ended just before it.
  if (by === "oversize") for (const row of Option.toArray(run.latest)) row.oversize += 1
  // A screen's pass (`judged: false`) leaves the rounds to the next check that judges them.
  if (isCheckMove(by) && step.judged !== false) {
    for (const row of run.sinceCheck) row.checks[by] += 1
    run.sinceCheck.clear()
  }
  if (isGateMove(by)) {
    for (const row of run.sinceGate) row.gates[by] += 1
    run.sinceGate.clear()
  }
}

const tallyFinish = (run: RunTally): void => {
  for (const [row, count] of run.rounds) {
    row.accepted.runs += 1
    row.accepted.rounds += count
  }
}

/** Counts one run's steps into `tallyOf`'s rows. */
const tallyRun = (
  steps: ReadonlyArray<MachineStep>,
  tallyOf: (state: StateName, model: ModelId) => QualityTally,
): void => {
  const run: RunTally = {
    rounds: new Map(),
    latest: Option.none(),
    sinceCheck: new Set(),
    sinceGate: new Set(),
  }
  for (const step of steps) {
    if (step._tag === "RoundEnded" && Predicate.isNotUndefined(step.model)) {
      tallyRound(tallyOf(step.state, step.model), step, run)
    }
    if (step._tag === "Moved") tallyMove(step, run)
    if (step._tag === "Finished" && step.accepted !== false) tallyFinish(run)
  }
}

/** Each state and model's record over `outcomes` (by run, oldest first), by state then model. */
const qualityOf = (outcomes: ReadonlyArray<RunOutcome>): ReadonlyArray<ModelQuality> => {
  const rows = new Map<string, QualityTally>()
  const tallyOf = (state: StateName, model: ModelId): QualityTally => {
    const key = `${state}\u0000${model}`
    const found = rows.get(key)
    if (Predicate.isNotUndefined(found)) return found
    const row: QualityTally = {
      state,
      model,
      rounds: 0,
      dead: 0,
      oversize: 0,
      priced: 0,
      costUsd: 0,
      verdicts: new Map(),
      checks: { pass: 0, fail: 0 },
      gates: { green: 0, red: 0 },
      accepted: { runs: 0, rounds: 0 },
    }
    rows.set(key, row)
    return row
  }
  const byRun = new Map<RunId, Array<MachineStep>>()
  for (const outcome of outcomes) {
    const steps = byRun.get(outcome.run) ?? []
    steps.push(outcome.step)
    byRun.set(outcome.run, steps)
  }
  for (const steps of byRun.values()) tallyRun(steps, tallyOf)
  return [...rows.values()]
    .toSorted(
      (left, right) =>
        Order.String(left.state, right.state) || Order.String(left.model, right.model),
    )
    .map((row) => ({ ...row, verdicts: Object.fromEntries(row.verdicts) }))
}

/** The steps `machine.status` shows, newest last. */
const STATUS_STEPS = 20

/**
 * One run as `machine.status` and `MachinesRpc.Status` read it: its view,
 * its last steps, and how each model fared in each state of its machine.
 */
export const MachineRunStatus = Schema.Struct({
  ...MachineRunView.fields,
  steps: Schema.Array(StepView),
  quality: Schema.Array(ModelQuality),
})
export type MachineRunStatus = typeof MachineRunStatus.Type

const RunStatusParams = Schema.Struct({ run: RunId })

const runStatus = Effect.fn("Machines.runStatus")(function* (params: typeof RunStatusParams.Type) {
  const store = yield* MachineStore
  const run = yield* ownedRun(params.run)
  const steps = yield* store.steps(run.run, STATUS_STEPS)
  const quality = qualityOf(yield* store.outcomesOf(run.machine))
  return { ...runView(run), steps, quality }
})

/**
 * One visit of a state, as the TUI's run page draws it: when it began and
 * ended, the thread and model of its newest round, its rounds and what the
 * priced ones cost, and how it ended. `outcome`: the round's verdict, a
 * check's `pass` or `fail`, a gate's `green` or `red`, an ask's answer,
 * `exhausted`, or the run's end (`stopped`, `failed`); none while the visit
 * is open and on a final state. `dead`: its newest round ended with no
 * verdict. `to`: the state the run moved to from it. `seq`: its first step,
 * the visit's key in the run.
 */
const StateVisit = Schema.Struct({
  seq: Count,
  state: StateName,
  visit: PositiveInt,
  at: Schema.Finite,
  endedAt: Schema.optionalKey(Schema.Finite),
  thread: Schema.optionalKey(SessionId),
  model: Schema.optionalKey(ModelId),
  rounds: Count,
  priced: Count,
  costUsd: Schema.Finite,
  dead: Schema.Boolean,
  outcome: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(StateName),
})
type StateVisit = typeof StateVisit.Type

/** A visit while its steps are folded in. */
interface VisitTally {
  readonly seq: number
  readonly state: StateName
  readonly visit: number
  readonly at: number
  endedAt: Option.Option<number>
  thread: Option.Option<SessionId>
  model: Option.Option<ModelId>
  rounds: number
  priced: number
  costUsd: number
  dead: boolean
  outcome: Option.Option<string>
  to: Option.Option<StateName>
}

/** A `Moved.by` that names the mechanism, not the key: the round's verdict or the ask's answer is the outcome. */
const isMechanismMove = Schema.is(Schema.Literals(["verdict", "answer"]))

/** The visits a run's steps fold to, and the first step of the visit still open. */
interface FoldedVisits {
  readonly trail: ReadonlyArray<StateVisit>
  readonly open: Option.Option<number>
}

/** A fold over a run's visit steps: the visits so far, the open one, the run's memo. */
interface VisitFold {
  readonly visits: Array<VisitTally>
  open: Option.Option<VisitTally>
  readonly counts: Readonly<Record<string, number>>
}

type VisitStep = { readonly seq: number; readonly at: number; readonly step: MachineStep }

/** Begin a visit at step `seq`; it is not open until the caller opens it. */
const beginVisit = (
  fold: VisitFold,
  seq: number,
  state: StateName,
  visit: number,
  at: number,
): VisitTally => {
  const entry: VisitTally = {
    seq,
    state,
    visit,
    at,
    endedAt: Option.none(),
    thread: Option.none(),
    model: Option.none(),
    rounds: 0,
    priced: 0,
    costUsd: 0,
    dead: false,
    outcome: Option.none(),
    to: Option.none(),
  }
  fold.visits.push(entry)
  return entry
}

/** End the open visit at `at`, if one is open. */
const endVisit = (fold: VisitFold, at: number): void => {
  if (Option.isSome(fold.open)) fold.open.value.endedAt = Option.some(at)
  fold.open = Option.none()
}

/** The run's end ends its open visit with `outcome`; an answer (`stop`) keeps its word. */
const settleVisit = (fold: VisitFold, outcome: string, at: number): void => {
  if (Option.isSome(fold.open)) {
    const entry = fold.open.value
    entry.outcome = Option.orElse(entry.outcome, () => Option.some(outcome))
  }
  endVisit(fold, at)
}

/** The open visit, when it is the action's state and visit. */
const openVisitFor = (fold: VisitFold, action: PendingAction): Option.Option<VisitTally> =>
  Option.filter(fold.open, (entry) => entry.state === action.state && entry.visit === action.visit)

/** A round's thread and model, kept on its visit. */
const roundReceipt = (entry: VisitTally, action: PendingAction): void => {
  if (action._tag !== "Round") return
  entry.thread = Option.orElse(Option.fromUndefinedOr(action.thread), () => entry.thread)
  entry.model = Option.orElse(Option.fromUndefinedOr(action.model), () => entry.model)
}

/** A dispatch of the open visit stays in it; any other ends it and begins one. */
const foldDispatched = (fold: VisitFold, seq: number, at: number, action: PendingAction): void => {
  const current = openVisitFor(fold, action)
  if (Option.isSome(current)) {
    roundReceipt(current.value, action)
    return
  }
  endVisit(fold, at)
  const entry = beginVisit(fold, seq, action.state, action.visit, at)
  roundReceipt(entry, action)
  fold.open = Option.some(entry)
}

/** A round's end tallies on the open visit of its state. */
const foldRoundEnded = (fold: VisitFold, step: RoundEnded): void => {
  const entry = Option.filter(fold.open, (value) => value.state === step.state)
  if (Option.isNone(entry)) return
  const tally = entry.value
  tally.rounds += 1
  tally.dead = step.dead
  tally.model = Option.orElse(Option.fromUndefinedOr(step.model), () => tally.model)
  tally.outcome = Option.fromUndefinedOr(step.verdict)
  if (Predicate.isNotUndefined(step.costUsd)) {
    tally.priced += 1
    tally.costUsd += step.costUsd
  }
}

/**
 * A move ends the open visit of its state, with where the run went. A move
 * off a state out of rounds has no open visit: it refuses the visit past
 * the state's count.
 */
const foldMoved = (fold: VisitFold, seq: number, at: number, step: MovedStep): void => {
  const entry = Option.filter(fold.open, (value) => value.state === step.from)
  if (Option.isSome(entry)) {
    entry.value.to = Option.some(step.to)
    if (!isMechanismMove(step.by)) entry.value.outcome = Option.some(step.by)
    endVisit(fold, at)
    return
  }
  endVisit(fold, at)
  if (step.by !== "exhausted") return
  const refused = beginVisit(fold, seq, step.from, (fold.counts[step.from] ?? 0) + 1, at)
  refused.endedAt = Option.some(at)
  refused.outcome = Option.some(step.by)
  refused.to = Option.some(step.to)
}

/** One visit step on the fold. */
const foldVisitStep = (fold: VisitFold, { seq, at, step }: VisitStep): void => {
  switch (step._tag) {
    case "Dispatched":
      return foldDispatched(fold, seq, at, step.action)
    case "Recorded":
      return Option.match(openVisitFor(fold, step.action), {
        onNone: () => {},
        onSome: (entry) => roundReceipt(entry, step.action),
      })
    case "RoundEnded":
      return foldRoundEnded(fold, step)
    case "Answered":
      if (Option.isSome(fold.open)) fold.open.value.outcome = Option.some(step.choice)
      return
    case "Moved":
      return foldMoved(fold, seq, at, step)
    case "Finished": {
      endVisit(fold, at)
      const visit = Math.max(1, fold.counts[step.state] ?? 0)
      beginVisit(fold, seq, step.state, visit, at).endedAt = Option.some(at)
      return
    }
    case "Stopped":
      return settleVisit(fold, "stopped", at)
    case "Failed":
      return settleVisit(fold, "failed", at)
    default:
      return
  }
}

/**
 * Each state visit of a run, oldest first, from its steps (`VISIT_TAGS`).
 * The run has one pending action: a dispatch of the open visit's state and
 * visit (a resumed round, a retry, a rerun, a no-verdict ask) stays in it,
 * and any other dispatch ends the open visit and begins one. A round, an
 * answer and a move belong to the open visit; a stop or a failure ends it.
 * Two visits have no dispatch: a move off a state out of rounds
 * (`exhausted`) refuses the visit past its count, and a final state's
 * `Finished` is its visit. `counts` is the run's memo, and neither state's
 * count changes after that step. A read from a visit's first step folds to
 * the same visits as the whole log.
 */
const stateVisits = (
  steps: ReadonlyArray<VisitStep>,
  counts: Readonly<Record<string, number>>,
): FoldedVisits => {
  const fold: VisitFold = { visits: [], open: Option.none(), counts }
  for (const step of steps) foldVisitStep(fold, step)
  return {
    trail: fold.visits.map((entry) => ({
      seq: entry.seq,
      state: entry.state,
      visit: entry.visit,
      at: entry.at,
      rounds: entry.rounds,
      priced: entry.priced,
      costUsd: entry.costUsd,
      dead: entry.dead,
      ...omitUndefined({
        endedAt: Option.getOrUndefined(entry.endedAt),
        thread: Option.getOrUndefined(entry.thread),
        model: Option.getOrUndefined(entry.model),
        outcome: Option.getOrUndefined(entry.outcome),
        to: Option.getOrUndefined(entry.to),
      }),
    })),
    open: Option.map(fold.open, (entry) => entry.seq),
  }
}

/**
 * One run as the TUI's run page reads it through `MachinesRpc.Page`: its
 * status, machine, start and pending action, and its state visits from
 * step `since` on (`trail`). `next` is the next read's `since`: the open
 * visit's first step, else the step after the run's last. A visit before
 * it never changes, so a reader keeps what it read and reads only what is
 * new.
 */
export const MachineRunPage = Schema.Struct({
  run: RunId,
  machine: MachineName,
  status: RunStatus,
  createdAt: Schema.Finite,
  pending: Schema.optionalKey(PendingAction),
  since: Count,
  next: Count,
  trail: Schema.Array(StateVisit),
})
export type MachineRunPage = typeof MachineRunPage.Type

const RunPageParams = Schema.Struct({
  run: RunId,
  /** The first step the visits are read from: the last page's `next`; the whole log without it. */
  since: Schema.optionalKey(Count),
})

/**
 * The run page's read: the run's row and the visit steps from `since`
 * through the row's seq, the steps its memo was folded over. It reads no
 * other run's log and no step a kept visit holds.
 */
const runPage = Effect.fn("Machines.runPage")(function* (params: typeof RunPageParams.Type) {
  const store = yield* MachineStore
  const run = yield* ownedRun(params.run)
  const since = params.since ?? 0
  const steps = yield* store.visitSteps(run.run, { since, through: run.seq })
  const folded = stateVisits(steps, run.visits.counts)
  return {
    run: run.run,
    machine: run.machine,
    status: run.status,
    createdAt: run.createdAt,
    since,
    next: Option.getOrElse(folded.open, () => Math.max(since, run.seq + 1)),
    trail: folded.trail,
    ...omitUndefined({ pending: Option.getOrUndefined(run.pending) }),
  }
})

const ThreadQualityParams = Schema.Struct({ session: SessionId })

/**
 * How each model fared in the state whose newest round ran on `session`'s
 * thread, in every run of its machine; empty when no run recorded a round
 * on it.
 */
const threadQuality = Effect.fn("Machines.threadQuality")(function* (
  params: typeof ThreadQualityParams.Type,
) {
  const ctx = yield* ExtensionContext
  const store = yield* MachineStore
  const session = yield* ctx.Session.getSession(params.session)
  const thread = Option.getOrElse(
    Option.map(Option.fromUndefinedOr(session), sessionThread),
    () => params.session,
  )
  const found = yield* store.roundOn(thread)
  if (Option.isNone(found)) return []
  const run = yield* ownedRun(found.value.run)
  const quality = qualityOf(yield* store.outcomesOf(run.machine))
  return quality.filter((row) => row.state === found.value.state)
})

const MachineStatusTool = tool({
  id: "machine.status",
  resources: [MachineStoreResource],
  readonly: true,
  description:
    "Read one run: its state, status, pending action, visits, its last steps, and how each model fared in each state of its machine over every run.",
  promptSnippet: "Read a machine run",
  params: RunStatusParams,
  output: MachineRunStatus,
  execute: runStatus,
})

/** The runs the caller's thread started, newest first, as `machine.list` and `MachinesRpc.Runs` read them. */
const ownedRuns = Effect.fn("Machines.ownedRuns")(function* () {
  const store = yield* MachineStore
  const runs = yield* store.ownedBy(yield* callerThread())
  return runs.map(runView)
})

/**
 * What a client outside any turn reads of runs and does to them (`gent ctl
 * request`, the TUI's band and run page), asked as a session of the owner's
 * thread: the views `machine.status` and `machine.list` give, the run
 * page's visits, and the stop `machine.stop` makes.
 */
export const MachinesRpc = defineRequests(MACHINES_EXTENSION_ID, {
  Status: request({
    id: "run-status",
    description: "Read one run your thread owns: its state, status, pending action and last steps",
    answersDuringTurn: true,
    input: RunStatusParams,
    output: MachineRunStatus,
    resources: [MachineStoreResource],
    execute: runStatus,
  }),
  Page: request({
    id: "run-page",
    description:
      "Read one run your thread owns as the run page draws it: its status and its state visits from a step on",
    answersDuringTurn: true,
    input: RunPageParams,
    output: MachineRunPage,
    resources: [MachineStoreResource],
    execute: runPage,
  }),
  // The store's commit is the stop's own lock, as `machine.stop`'s in a turn.
  Stop: request({
    id: "run-stop",
    description:
      "Stop a run your thread owns: its open round's thread is stopped and its command is killed",
    answersDuringTurn: true,
    input: RunStatusParams,
    output: Schema.Struct({ run: RunId, status: Schema.Literal("stopped") }),
    resources: [MachineStoreResource],
    execute: (params) => stopRun(params.run),
  }),
  Runs: request({
    id: "run-list",
    description: "List the runs your thread started, newest first",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: Schema.Array(MachineRunView),
    resources: [MachineStoreResource],
    execute: () => ownedRuns(),
  }),
  Quality: request({
    id: "thread-quality",
    description:
      "How each model fared in the state a session's thread works rounds of, in your runs' machine: its rounds, cost, verdicts, checks, gates and finished runs",
    answersDuringTurn: true,
    input: ThreadQualityParams,
    output: Schema.Array(ModelQuality),
    resources: [MachineStoreResource],
    execute: threadQuality,
  }),
})

const MachineListTool = tool({
  id: "machine.list",
  resources: [MachineStoreResource],
  readonly: true,
  description: "List the runs your thread started, newest first.",
  promptSnippet: "List your machine runs",
  params: Tool.EmptyParams,
  output: Schema.Array(MachineRunView),
  execute: () => ownedRuns(),
})

export const MachineStopTool = tool({
  id: "machine.stop",
  resources: [MachineStoreResource],
  description:
    "Stop a run: its open round's thread is stopped and its command is killed. It wakes nobody.",
  promptSnippet: "Stop a machine run",
  params: Schema.Struct({ run: RunId }),
  output: Schema.Struct({ run: RunId, status: Schema.Literal("stopped") }),
  execute: (params) => stopRun(params.run),
})

// ── registration ────────────────────────────────────────────────────────────

/**
 * The `wakeDue` hook: a run's record fired on its host. The driver is armed;
 * the record stays while the run is active, delivered or not, so a fire
 * that races an answer never takes the run's only trigger. A round that
 * waits for its account keeps its time: the driver sets it again on every
 * activation (`waitOut`), and a newer arm outlives this fire's answer.
 */
const runDue = Effect.fn("Machines.due")(function* (input: WakeDueInput) {
  const store = yield* MachineStore
  const prefix = [RUN_SOURCE_PREFIX, STOP_SOURCE_PREFIX].find((prefix) =>
    input.sourceId.startsWith(prefix),
  )
  if (Predicate.isUndefined(prefix)) return WakeNext.cases.Done.make({})
  const runId = Schema.decodeOption(RunId)(input.sourceId.slice(prefix.length))
  if (Option.isNone(runId)) return WakeNext.cases.Done.make({})
  const found = yield* store.read(runId.value)
  if (Option.isNone(found) || !isActive(found.value)) return WakeNext.cases.Done.make({})
  yield* armDriver(runId.value)
  return WakeNext.cases.AtStart.make({})
})

/**
 * The loop-open repair: every active run this branch hosts gets its record
 * again and its driver, after a branch generation was rebuilt or the
 * extension was disabled and enabled. A record armed with no time keeps the
 * time a waiting round's driver set.
 */
const repairHost = Effect.fn("Machines.repair")(function* () {
  const ctx = yield* ExtensionContext
  const store = yield* MachineStore
  const runs = yield* store.activeOn({ sessionId: ctx.sessionId, branchId: ctx.branchId })
  for (const run of runs) {
    yield* ctx.Session.wakeAt({ ...run.host, sourceId: runSource(run.run) })
    yield* armDriver(run.run)
  }
})

const logFailure = (event: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) =>
    Effect.logWarning(event).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
  )

export const MachinesExtension = defineExtension({
  id: MACHINES_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", MachineStoreResource, MachineDriversResource)
    yield* host.register(
      "tool",
      MachineDefineTool,
      MachineStartTool,
      MachineAnswerTool,
      MachineStatusTool,
      MachineListTool,
      MachineStopTool,
    )
    yield* host.register(
      "request",
      MachinesRpc.Status,
      MachinesRpc.Page,
      MachinesRpc.Stop,
      MachinesRpc.Runs,
      MachinesRpc.Quality,
    )
    yield* host.on("wakeDue", (input) => runDue(input))
    yield* host.on("loopOpen", () => repairHost().pipe(logFailure("machines.repair.failed")))
    yield* host.on("sessionDeleted", ({ sessionId }) =>
      Effect.flatMap(MachineStore, (store) => store.removeHostSession(sessionId)),
    )
  }),
})
