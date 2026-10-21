/**
 * Machines: state machines defined as data, run by a host interpreter
 * outside any turn (`@gent/machines`).
 *
 * A definition names thread roles and states. A `thread` state sends a round
 * to a role's thread through the `Threads` service with `notify: "none"`, so
 * a round's end moves the run and wakes nobody; its `thread.reply` value
 * names the next state. A `run` state spawns a command in the run's cwd. An
 * `ask` state asks the owner and waits for `machine.answer`. A `final` state
 * ends the run. `machine.define` writes a definition to
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
  Path,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { Tool } from "effect/ai"
import { Hex } from "effect/encoding"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { Migrator, SqlClient } from "effect/sql"
import {
  AgentName,
  BranchId,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  omitUndefined,
  request,
  resolveDataDir,
  SessionId,
  sessionThread,
  tool,
  type WakeDueInput,
  WakeNext,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import {
  type CommandProcess,
  commandLaunch,
  removeCommandReceipt,
  runBashCommand,
  stopLostCommand,
} from "./exec-tools.js"
import {
  currentThreadPlace,
  StartParams,
  ThreadBusy,
  Threads,
  type ThreadSendInput,
  ThreadsOverCap,
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

/** One role: a thread's spec, as `thread.start` takes it. Default agent: `worker`, which keeps the session cache. */
const ThreadRole = Schema.Struct({
  agent: StartParams.fields.agent,
  model: StartParams.fields.model,
  effort: StartParams.fields.effort,
  account: StartParams.fields.account,
  instructions: Schema.optionalKey(Template),
  tools: StartParams.fields.tools,
})

/** A loop cap: past `maxVisits` entries (default 10) the run goes to `exhausted`, else asks. */
const VisitCap = {
  maxVisits: Schema.optionalKey(PositiveInt),
  exhausted: Schema.optionalKey(StateName),
}

const ThreadState = Schema.Struct({
  kind: Schema.Literal("thread"),
  thread: RoleName,
  say: Template,
  /** Unconditional: the round's text is saved, and the run moves on. */
  next: Schema.optionalKey(StateName),
  /** By verdict: the round must `thread.reply` a value whose `next` is one of these keys. */
  on: Schema.optionalKey(Schema.Record(Verdict, StateName)),
  /** `true`: a new thread on every visit. A number: a new thread from that visit on. */
  fresh: Schema.optionalKey(Schema.Union([Schema.Boolean, PositiveInt])),
  ...VisitCap,
})
type ThreadState = typeof ThreadState.Type

/** P4's bash `permit: { name, limit }`; until P4, one server's machines share it. */
const Permit = Schema.Struct({ name: Slug, limit: Schema.optionalKey(PositiveInt) })

const RunState = Schema.Struct({
  kind: Schema.Literal("run"),
  run: Template,
  permit: Schema.optionalKey(Permit),
  /** Default 3600. A timeout takes `fail`. */
  timeoutSeconds: Schema.optionalKey(PositiveInt),
  on: Schema.Struct({ pass: StateName, fail: StateName }),
  ...VisitCap,
})
type RunState = typeof RunState.Type

const AskState = Schema.Struct({
  kind: Schema.Literal("ask"),
  ask: Template,
  /** The allowed answers, each with its next state. */
  on: Schema.Record(Verdict, StateName),
})

const FinalState = Schema.Struct({
  kind: Schema.Literal("final"),
  /** The line the owner's wake carries; default "<machine> finished in <state>". */
  say: Schema.optionalKey(Template),
})

const MachineState = Schema.Union([ThreadState, RunState, AskState, FinalState]).pipe(
  Schema.toTaggedUnion("kind"),
)
type MachineState = typeof MachineState.Type

const MachineDefinition = Schema.Struct({
  name: MachineName,
  threads: Schema.Record(RoleName, ThreadRole),
  start: StateName,
  states: Schema.Record(StateName, MachineState),
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
   * then, holding nothing. `fresh`: the round runs on a new thread, as a
   * usage limit's rerun does.
   */
  Round: {
    state: StateName,
    visit: PositiveInt,
    key: Schema.String,
    attempt: PositiveInt,
    thread: Schema.optionalKey(SessionId),
    round: Schema.optionalKey(Schema.String),
    notBefore: Schema.optionalKey(Schema.Finite),
    fresh: Schema.optionalKey(Schema.Boolean),
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
  Ask: {
    state: StateName,
    visit: PositiveInt,
    askId: AskId,
    reason: AskReason,
    choices: Schema.Array(Verdict),
    /** An interrupted command whose process group a restart could not show gone. */
    mayStillRun: Schema.optionalKey(Schema.Boolean),
    deliveredAt: Schema.optionalKey(Schema.Finite),
  },
})
type PendingAction = typeof PendingAction.Type
type RoundAction = Extract<PendingAction, { readonly _tag: "Round" }>
type CommandAction = Extract<PendingAction, { readonly _tag: "Command" }>
type AskAction = Extract<PendingAction, { readonly _tag: "Ask" }>

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

/** One row of the append-only log. */
const MachineStep = Schema.TaggedUnion({
  Started: { machine: MachineName, input: Schema.Json },
  Dispatched: { action: PendingAction },
  /** The pending action gained its receipt: a round's thread and id, a command's process. */
  Recorded: { action: PendingAction },
  /** Where the next owner message lands, saved before it is sent. */
  PlaceSaved: { place: PlaceRecord },
  RoundEnded: {
    state: StateName,
    round: Schema.String,
    verdict: Schema.optionalKey(Verdict),
    dead: Schema.Boolean,
  },
  CommandEnded: {
    state: StateName,
    exitCode: Schema.optionalKey(Schema.Int),
    timedOut: Schema.Boolean,
    outputTail: Schema.String,
  },
  Interrupted: { state: StateName },
  /**
   * The pending round waits until `until`: the account had no lane for it
   * (`lane`), or its worker died at a usage limit (`quota`). No visit is spent.
   */
  Waiting: { state: StateName, until: Schema.Finite, reason: Schema.Literals(["lane", "quota"]) },
  Delivered: { askId: AskId },
  Answered: { askId: AskId, choice: Verdict, note: Schema.optionalKey(Schema.String) },
  Moved: { from: StateName, to: StateName, by: Schema.String },
  Finished: { state: StateName },
  Failed: { error: Schema.String },
  Stopped: {},
  /** A stopped run's open round or command was stopped. */
  /** A process the stopped run started may still run: its group was not shown gone. */
  Settled: { mayStillRun: Schema.optionalKey(Schema.Boolean) },
  Notified: {},
})
type MachineStep = typeof MachineStep.Type

// ── errors ──────────────────────────────────────────────────────────────────

class MachineError extends Schema.TaggedError<MachineError, { readonly brand: unique symbol }>()(
  "MachineError",
  { message: Schema.String },
) {}

/**
 * An answer the run refuses. `conflict`: the ask was answered with another
 * choice. `stale`: the ask was never answered and is no longer the current
 * one. `invalid`: the current ask does not offer the choice.
 */
class MachineAnswerRefused extends Schema.TaggedError<
  MachineAnswerRefused,
  { readonly brand: unique symbol }
>()("MachineAnswerRefused", {
  message: Schema.String,
  reason: Schema.Literals(["stale", "conflict", "invalid"]),
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
const TEMPLATE_HEADS: ReadonlySet<string> = new Set(["input", "all", "visit"])

/** `{{ref}}`: the one template form. */
const TEMPLATE_SLOT = /\{\{\s*([^{}\s]+)\s*\}\}/g

const slotsOf = (template: string): ReadonlyArray<ReadonlyArray<string>> =>
  [...template.matchAll(TEMPLATE_SLOT)].map((match) => (match[1] ?? "").split("."))

const templatesOf = (state: MachineState): ReadonlyArray<string> => {
  switch (state.kind) {
    case "thread":
      return [state.say]
    case "run":
      return [state.run]
    case "ask":
      return [state.ask]
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
      ]
    case "run":
      return [
        state.on.pass,
        state.on.fail,
        ...Option.toArray(Option.fromUndefinedOr(state.exhausted)),
      ]
    case "ask":
      return Object.values(state.on)
    case "final":
      return []
  }
}

const exhaustedOf = (state: MachineState): Option.Option<StateName> => {
  if (state.kind === "thread" || state.kind === "run") {
    return Option.fromUndefinedOr(state.exhausted)
  }
  return Option.none()
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
  if (state.kind === "thread" || state.kind === "run") {
    if (Predicate.isNotUndefined(state.exhausted) && Predicate.isUndefined(state.maxVisits)) {
      problems.push(`${name}: exhausted needs maxVisits`)
    }
  }
  if (state.kind === "thread" || state.kind === "ask") {
    const reserved = Object.keys(state.on ?? {}).filter((key) => RESERVED_KEYS.has(key))
    problems.push(...reserved.map((key) => `${name}: ${key} is a reserved choice`))
  }
  return problems
}

/** Whether a template slot names something a run holds. */
const slotResolves = (names: ReadonlySet<string>, slot: ReadonlyArray<string>) => {
  const [head = "", next = ""] = slot
  if (head === "all") return names.has(next)
  return TEMPLATE_HEADS.has(head) || names.has(head)
}

const templateProblems = (
  names: ReadonlySet<string>,
  name: string,
  state: MachineState,
): ReadonlyArray<string> =>
  templatesOf(state)
    .flatMap(slotsOf)
    .filter((slot) => !slotResolves(names, slot))
    .map((slot) => `${name}: {{${slot.join(".")}}} names no state`)

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
 * Every problem of a definition the schema admits, at once: the graph's
 * names, edges, reachability, templates, and cycles of `exhausted` edges.
 */
const definitionProblems = (definition: MachineDefinition): ReadonlyArray<string> => {
  const names = new Set<string>(Object.keys(definition.states))
  const reserved = TEMPLATE_HEADS.values()
    .filter((head) => names.has(head))
    .map((head) => `${head} is a reserved name, not a state`)
    .toArray()
  const perState = Object.entries(definition.states).flatMap(([name, state]) => [
    ...stateProblems(definition, names, name, state),
    ...templateProblems(names, name, state),
  ])
  return [
    ...reserved,
    ...perState,
    ...reachProblems(definition, names),
    ...exhaustedCycleProblems(definition, names),
  ]
}

const DefinitionJson = Schema.fromJsonString(MachineDefinition)
const DefinitionFile = Schema.fromJsonString(MachineDefinition, { space: 2 })
const decodeDefinitionJson = Schema.decodeUnknownOption(DefinitionJson)

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

interface TemplateScope {
  readonly input: Schema.Json
  readonly context: RunContext
  readonly visit: number
}

const slotValue = (scope: TemplateScope, slot: ReadonlyArray<string>): Option.Option<string> => {
  const [head = "", ...rest] = slot
  if (head === "visit") return Option.some(String(scope.visit))
  if (head === "input") return Option.map(pathInto(scope.input, rest), jsonText)
  if (head === "all") {
    const [state = "", ...path] = rest
    const values = Option.fromUndefinedOr(scope.context.all[state])
    return Option.flatMap(values, (all) => Option.map(pathInto(all, path), jsonText))
  }
  const last = Option.fromUndefinedOr(scope.context.last[head])
  return Option.flatMap(last, (value) => Option.map(pathInto(value, rest), jsonText))
}

/** Fills each `{{ref}}`; a missing path is empty text. */
const render = (template: string, scope: TemplateScope): string =>
  template.replace(TEMPLATE_SLOT, (_whole, ref: string) =>
    Option.getOrElse(slotValue(scope, ref.split(".")), () => "").slice(-SLOT_CHARS),
  )

const saved = (context: RunContext, state: StateName, value: Schema.Json): RunContext => ({
  last: { ...context.last, [state]: value },
  all: { ...context.all, [state]: [...(context.all[state] ?? []), value] },
})

// ── runs ────────────────────────────────────────────────────────────────────

/** One run as its row holds it. */
interface Run {
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
  readonly context: RunContext
  readonly visits: Visits
  /** The thread of each role that is not fresh. */
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

const isTerminal = (status: RunStatus) =>
  status === "final" || status === "failed" || status === "stopped"

/** A run with work left: a step to take, an ask to answer, or an end to settle. */
const isActive = (run: Run) => !isTerminal(run.status) || Option.isNone(run.notifiedAt)

/** The core wake record of a run: on its host branch, with no time while the run is active. */
const runSource = (run: RunId) => `machine-run:${run}`
const RUN_SOURCE_PREFIX = "machine-run:"

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
  context_json: Schema.fromJsonString(RunContext),
  visits_json: Schema.fromJsonString(Visits),
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

const runOfRow = (row: typeof RunRow.Type): Run => ({
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
  context: row.context_json,
  visits: row.visits_json,
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
const encodeContext = Schema.encodeEffect(Schema.fromJsonString(RunContext))
const encodeVisits = Schema.encodeEffect(Schema.fromJsonString(Visits))
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

const stateOfStep = (step: MachineStep, fallback: StateName): StateName => {
  switch (step._tag) {
    case "Dispatched":
    case "Recorded":
      return step.action.state
    case "RoundEnded":
    case "CommandEnded":
    case "Interrupted":
    case "Waiting":
    case "Finished":
      return step.state
    case "Moved":
      return step.to
    default:
      return fallback
  }
}

// ── storage ─────────────────────────────────────────────────────────────────

/**
 * The tables, in the server's database. Machines run their own migrations,
 * recorded in their own table (`machine_migrations`), as threads do, so
 * their ids never meet core's chain.
 */
const machineTablesMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(
    [
      `CREATE TABLE IF NOT EXISTS machine_runs (
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
        context_json TEXT NOT NULL,
        visits_json TEXT NOT NULL,
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
      `CREATE INDEX IF NOT EXISTS machine_runs_host ON machine_runs (host_session_id, host_branch_id)
        WHERE status IN ('running','asking') OR notified_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS machine_runs_owner ON machine_runs (owner_thread, created_at)`,
      `CREATE TABLE IF NOT EXISTS machine_steps (
        run TEXT NOT NULL REFERENCES machine_runs(run) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        state TEXT NOT NULL,
        step_json TEXT NOT NULL,
        PRIMARY KEY (run, seq)
      )`,
    ],
    (statement) => sql.unsafe(statement),
    { discard: true },
  )
})

const migrateMachineTables = Migrator.make({})({
  loader: Migrator.fromRecord({ "1_machine_tables": machineTablesMigration }),
  table: "machine_migrations",
}).pipe(Effect.mapError(storageError("Machine table migration failed")))

/** At most this many rounds and commands run at once in one server, over every machine. */
const MAX_ACTIVE_MACHINE_STEPS = 4

/** A crash-debt ticket no driver claims within this goes back. */
const TICKET_TTL = Duration.minutes(10)

/**
 * The step permits: one per open round or command, held per run from before
 * its `Dispatched` commit to its receipt or its ask. A run that held one when
 * the server stopped gets a ticket at the next build, so the work a crash
 * left counts first.
 */
interface StepPermits {
  /** Takes the run's permit, or claims its ticket; a run that holds one keeps it. */
  readonly acquire: (run: RunId) => Effect.Effect<void>
  /** Gives the run's permit back; a run that holds none is left alone. */
  readonly release: (run: RunId) => Effect.Effect<void>
}

interface MachineStoreService {
  readonly insert: (run: Run, started: MachineStep) => Effect.Effect<void, MachineStorageError>
  readonly read: (run: RunId) => Effect.Effect<Option.Option<Run>, MachineStorageError>
  /**
   * Writes `after` and appends `steps` in one transaction, only while the
   * row is at `before.seq`: the new run, or none when another writer moved
   * it first.
   */
  readonly commit: (
    before: Run,
    after: Run,
    steps: ReadonlyArray<MachineStep>,
  ) => Effect.Effect<Option.Option<Run>, MachineStorageError>
  readonly steps: (
    run: RunId,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly at: number; readonly step: MachineStep }>,
    MachineStorageError
  >
  /** The `Answered` step of one ask, once it was answered. */
  readonly answered: (
    run: RunId,
    askId: AskId,
  ) => Effect.Effect<
    Option.Option<Extract<MachineStep, { readonly _tag: "Answered" }>>,
    MachineStorageError
  >
  readonly ownedBy: (thread: SessionId) => Effect.Effect<ReadonlyArray<Run>, MachineStorageError>
  /** The runs a branch hosts that have work left. */
  readonly activeOn: (host: PlaceRecord) => Effect.Effect<ReadonlyArray<Run>, MachineStorageError>
  readonly removeHostSession: (sessionId: SessionId) => Effect.Effect<void, MachineStorageError>
  readonly permits: StepPermits
  /**
   * Runs `effect` under the named command permit, made with the first limit
   * asked (default 1). Until P4, it bounds one server's machines only.
   */
  readonly withPermit: (
    permit: Option.Option<typeof Permit.Type>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const makeStepPermits = Effect.fn("MachineStore.stepPermits")(function* (
  debt: ReadonlyArray<RunId>,
) {
  const semaphore = yield* Semaphore.make(MAX_ACTIVE_MACHINE_STEPS)
  // The runs that hold a permit; a ticket's expiry fiber gives it back unclaimed.
  const held = new Map<RunId, Option.Option<Fiber.Fiber<void>>>()
  const lock = yield* Semaphore.make(1)
  const giveBack = (run: RunId) =>
    Effect.suspend(() => {
      if (!held.has(run)) return Effect.void
      held.delete(run)
      return semaphore.release(1)
    }).pipe(lock.withPermits(1))
  for (const run of debt.slice(0, MAX_ACTIVE_MACHINE_STEPS)) {
    yield* semaphore.take(1)
    const expiry = yield* Effect.sleep(TICKET_TTL).pipe(
      Effect.andThen(Effect.logInfo("machines.ticket.expired").pipe(Effect.annotateLogs({ run }))),
      Effect.andThen(giveBack(run)),
      Effect.forkScoped,
    )
    held.set(run, Option.some(expiry))
  }
  const claim = (run: RunId) =>
    Effect.suspend(() => {
      const found = held.get(run)
      if (Predicate.isUndefined(found)) return Effect.succeed(false)
      held.set(run, Option.none())
      return Option.match(found, {
        onNone: () => Effect.succeed(true),
        onSome: (expiry) => Effect.as(Fiber.interrupt(expiry), true),
      })
    }).pipe(lock.withPermits(1))
  const permits: StepPermits = {
    acquire: Effect.fn("MachineStore.acquireStep")(function* (run: RunId) {
      if (yield* claim(run)) return
      const mark = Effect.suspend(() => {
        if (held.has(run)) return semaphore.release(1)
        held.set(run, Option.none())
        return Effect.void
      }).pipe(lock.withPermits(1))
      // The take and the mark are one step: an interrupt between them would leak a permit.
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* semaphore.takeIfAvailable(1))) {
            yield* Effect.logDebug("machines.step.waiting").pipe(Effect.annotateLogs({ run }))
            yield* restore(semaphore.take(1))
          }
          yield* mark
        }),
      )
    }),
    release: Effect.fn("MachineStore.releaseStep")(function* (run: RunId) {
      const found = yield* Effect.sync(() => held.get(run)).pipe(lock.withPermits(1))
      if (Predicate.isUndefined(found)) return
      if (Option.isSome(found)) yield* Fiber.interrupt(found.value)
      yield* giveBack(run)
    }),
  }
  return permits
})

const RUN_COLUMNS = `run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
  owner_session_id, owner_branch_id, cwd, input_json, context_json, visits_json, roles_json,
  state, status, pending_json, seq, notified_at, error, created_at, updated_at`

/**
 * The run tables, the step permits and the command permits. Building it runs
 * the migrations it lacks and reads the crash debt. It is a server resource:
 * one server's machines share the permits.
 */
export class MachineStore extends Context.Service<MachineStore, MachineStoreService>()(
  "@gent/extensions/src/machines/MachineStore",
) {
  static Live: Layer.Layer<MachineStore, MachineStorageError, SqlClient.SqlClient> = Layer.effect(
    MachineStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrateMachineTables

      const decodeRuns = (rows: ReadonlyArray<unknown>) =>
        Effect.forEach(rows, (row) => Effect.map(decodeRunRow(row), runOfRow)).pipe(
          Effect.mapError(storageError("A machine run row does not decode")),
        )

      // The runs that held a step when the last server stopped, oldest first.
      // A round that waits for its account held none.
      const bootAt = yield* Clock.currentTimeMillis
      const debtRows = yield* sql`
        SELECT run FROM machine_runs
        WHERE status = 'running'
          AND json_extract(pending_json, '$._tag') IN ('Round', 'Command')
          AND COALESCE(json_extract(pending_json, '$.notBefore'), 0) <= ${bootAt}
        ORDER BY created_at ASC, run ASC
      `.pipe(Effect.mapError(storageError("Failed to read the machine step debt")))
      const debt = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ run: RunId })))(
        debtRows,
      ).pipe(Effect.mapError(storageError("A machine run id does not decode")))
      const permits = yield* makeStepPermits(debt.map((row) => row.run))

      const commandPermits = new Map<string, Semaphore.Semaphore>()
      const permitLock = yield* Semaphore.make(1)
      const commandPermit = (permit: typeof Permit.Type) =>
        Effect.gen(function* () {
          const found = commandPermits.get(permit.name)
          if (Predicate.isNotUndefined(found)) return found
          const made = yield* Semaphore.make(permit.limit ?? 1)
          commandPermits.set(permit.name, made)
          return made
        }).pipe(permitLock.withPermits(1))

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
            const contextJson = yield* encodeContext(run.context)
            const visitsJson = yield* encodeVisits(run.visits)
            const rolesJson = yield* encodeRoles(run.roles)
            const now = yield* Clock.currentTimeMillis
            yield* Effect.gen(function* () {
              const inserted = yield* sql`INSERT INTO machine_runs (
                  run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
                  cwd, input_json, context_json, visits_json, roles_json, state, status, seq,
                  created_at, updated_at
                ) VALUES (
                  ${run.run}, ${run.machine}, ${run.definitionJson}, ${run.host.sessionId},
                  ${run.host.branchId}, ${run.ownerThread}, ${run.cwd}, ${inputJson},
                  ${contextJson}, ${visitsJson}, ${rolesJson}, ${run.state}, ${run.status}, 1,
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
            const contextJson = yield* encodeContext(after.context)
            const visitsJson = yield* encodeVisits(after.visits)
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
                  context_json = ${contextJson},
                  visits_json = ${visitsJson},
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
              return Option.some<Run>({ ...after, seq })
            }).pipe(sql.withTransaction)
          },
          Effect.mapError(storageError("Failed to commit a machine step")),
        ),
        steps: Effect.fn("MachineStore.steps")(
          function* (run, limit) {
            const rows = yield* sql`SELECT seq, at, step_json FROM machine_steps
              WHERE run = ${run} ORDER BY seq DESC LIMIT ${limit}`
            const decoded = yield* decodeStepRows(rows)
            return decoded
              .map((row) => ({ seq: row.seq, at: row.at, step: row.step_json }))
              .toReversed()
          },
          Effect.mapError(storageError("Failed to read machine steps")),
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
        permits,
        withPermit: (permit) => (effect) =>
          Option.match(permit, {
            onNone: () => effect,
            onSome: (named) =>
              Effect.flatMap(commandPermit(named), (semaphore) =>
                effect.pipe(semaphore.withPermits(1)),
              ),
          }),
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

const isStepAction = Predicate.or(Predicate.isTagged("Round"), Predicate.isTagged("Command"))

const isRoundOrCommand = (pending: Option.Option<PendingAction>) =>
  Option.exists(pending, isStepAction)

/** When the pending round may be sent: none when it does not wait. */
const waitsUntil = (pending: Option.Option<PendingAction>, now: number) =>
  Option.flatMap(pending, (action) => {
    if (action._tag !== "Round" || Predicate.isUndefined(action.notBefore)) return Option.none()
    return Option.liftPredicate(action.notBefore, (until) => until > now)
  })

/** A running run that takes a step now: not one whose round waits for its account. */
const takesStep = (run: Run, now: number) =>
  run.status === "running" && Option.isNone(waitsUntil(run.pending, now))

/** A row whose end is settled and whose seq is the one the driver last acted on. */
const isDone = (run: Run, seq: number) =>
  isTerminal(run.status) && Option.isSome(run.notifiedAt) && run.seq === seq

/** How long a refused send (busy, over the cap) waits for a round end before it tries again. */
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
 * kept while the run asks, runs a command or waits for a permit.
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

const capOf = (state: ThreadState | RunState) => state.maxVisits ?? DEFAULT_MAX_VISITS

const visitsOf = (visits: Visits, state: StateName) => visits.counts[state] ?? 0

const visited = (visits: Visits, state: StateName): Visits => ({
  ...visits,
  counts: { ...visits.counts, [state]: visitsOf(visits, state) + 1 },
})

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
    case "run":
      if (reason === "interrupted" && mayStillRun) return control(["pass", "fail", "stop"])
      return control(["pass", "fail", "retry", "stop"])
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
    readonly visits?: Visits
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
    }),
  })
  steps.push(MachineStep.cases.Dispatched.make({ action }))
  const after: Run = {
    ...run,
    status: "asking",
    pending: Option.some(action),
    visits: input.visits ?? run.visits,
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

const isWaitRefusal = (error: unknown): error is ThreadBusy | ThreadsOverCap =>
  Schema.is(ThreadBusy)(error) || Schema.is(ThreadsOverCap)(error)

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
const commitMove = (before: Run, after: Run, steps: ReadonlyArray<MachineStep>) =>
  Effect.flatMap(MachineStore, (store) => store.commit(before, after, steps))

/** A fault the run cannot ask about: it fails, and its end is told to the owner. */
const failRun = Effect.fn("Machines.fail")(function* (run: RunId, error: string) {
  const store = yield* MachineStore
  const found = yield* store.read(run)
  if (Option.isNone(found) || isTerminal(found.value.status)) return
  const current = found.value
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
    const now = yield* Clock.currentTimeMillis
    if (!isRoundOrCommand(run.pending) || Option.isSome(waitsUntil(run.pending, now))) {
      yield* store.permits.release(run.run)
    }
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
            onNone: () =>
              Effect.flatMap(MachineStore, (store) => store.permits.acquire(run.run)).pipe(
                Effect.andThen(awaitRound(run, pending, signals)),
              ),
          }),
        ),
      Command: (pending) => awaitCommand(run, pending, signals),
    }),
  )

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
  wait: { readonly until: number; readonly reason: "lane" | "quota" },
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

/** Removes the run's core record once its end is settled. */
const withdrawWake = Effect.fn("Machines.withdrawWake")(function* (run: Run) {
  const ctx = yield* ExtensionContext
  yield* ctx.Session.cancelWake({ ...run.host, sourceId: runSource(run.run) })
})

/** Enters the run's current state, as one more visit. */
const enter = Effect.fn("Machines.enter")(function* (run: Run, signals: Signals) {
  const store = yield* MachineStore
  const definition = yield* definitionOf(run)
  const name = run.state
  const state = yield* stateIn(definition, name)
  const visit = visitsOf(run.visits, name) + 1
  if (state.kind === "thread" || state.kind === "run") {
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
  const visits = visited(run.visits, name)
  switch (state.kind) {
    case "final":
      yield* commitMove(run, { ...run, status: "final", visits }, [
        MachineStep.cases.Finished.make({ state: name }),
      ])
      return
    case "ask": {
      const asking = askingRun(run, { state, name, visit, reason: "asked", lead: [], visits })
      yield* commitMove(run, asking.after, asking.steps)
      return
    }
    case "run": {
      yield* store.permits.acquire(run.run)
      const ctx = yield* ExtensionContext
      const action = PendingAction.cases.Command.make({
        state: name,
        visit,
        startedAt: yield* Clock.currentTimeMillis,
        launch: yield* commandLaunch(yield* resolveDataDir(ctx.home)),
      })
      const committed = yield* commitMove(run, { ...run, visits, pending: Option.some(action) }, [
        MachineStep.cases.Dispatched.make({ action }),
      ])
      if (Option.isSome(committed)) yield* startCommand(committed.value, state, action)
      return
    }
    case "thread": {
      yield* store.permits.acquire(run.run)
      const action = PendingAction.cases.Round.make({
        state: name,
        visit,
        key: `machine:${run.run}:${run.seq + 1}`,
        attempt: 1,
      })
      const committed = yield* commitMove(run, { ...run, visits, pending: Option.some(action) }, [
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
})

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
 * busy thread or the running cap waits for a round end and sends again. An
 * account with no lane (`LaneUnavailable`) makes the round wait until the
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
      waitForAccount(recorded.run, recorded.action, { until: lane.retryAt, reason: "lane" }).pipe(
        Effect.as(true),
      ),
    ),
    Effect.mapError(threadFault),
  )
  // Refused (the thread is busy, or the cap is full): any round end may free
  // it. The driver then reads the row again, so a stop or an answer that came
  // meanwhile decides before the next send.
  if (!admitted) yield* awaitSignal(signals, { ends: true, within: REFUSED_SEND_WAIT })
})

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
 * run's, kept across visits) and commits it with the round's id: the run and
 * the round as committed, or none when another writer moved the row first.
 */
const recordRoundTarget = Effect.fn("Machines.recordRoundTarget")(function* (
  run: Run,
  state: ThreadState,
  action: RoundAction,
) {
  const threads = yield* threadsOf
  const definition = yield* definitionOf(run)
  const role = definition.threads[state.thread] ?? {}
  const fresh = ownThread(state, action)
  const spec: Omit<ThreadStartInput, "key" | "name"> = {
    agent: role.agent ?? WORKER_AGENT,
    cwd: run.cwd,
    notify: "none",
    ...omitUndefined({
      model: role.model,
      effort: role.effort,
      account: role.account,
      instructions: role.instructions,
      tools: role.tools,
    }),
  }
  const known = Option.liftPredicate(
    Option.fromUndefinedOr(run.roles[state.thread]),
    () => !fresh,
  ).pipe(Option.flatten)
  const thread = yield* Option.match(
    Option.orElse(Option.fromUndefinedOr(action.thread), () => known),
    {
      onSome: Effect.succeed,
      onNone: () => {
        let start = {
          key: `machine:${run.run}:role:${state.thread}`,
          name: `${run.machine}-${state.thread}`,
        }
        if (fresh) {
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
    },
  )
  const round = yield* threads.sendRound(action.key)
  const recorded = PendingAction.cases.Round.make({ ...action, thread, round })
  let roles = run.roles
  if (!fresh) roles = { ...run.roles, [state.thread]: thread }
  const committed = yield* commitMove(run, { ...run, roles, pending: Option.some(recorded) }, [
    MachineStep.cases.Recorded.make({ action: recorded }),
  ])
  return Option.map(committed, (next) => ({ run: next, action: recorded, thread, round }))
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
  if (view.status === "open") {
    // Open, stopped from outside or not: the worker's turn still runs (a
    // stopped turn may hold out in an uninterruptible tool). Its end, which
    // Threads publishes whether the round was stopped or not, decides.
    yield* awaitSignal(signals, { ends: true })
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
        MachineStep.cases.RoundEnded.make({ state: name, round: roundId, dead: true }),
        MachineStep.cases.Interrupted.make({ state: name }),
      ],
    })
    yield* commitMove(run, asking.after, asking.steps)
    return
  }
  if (view.streamFailed && !view.interrupted && Predicate.isNotUndefined(view.retryAt)) {
    // The key is the `Waiting` step's seq: unique in the run, and short on a second death.
    const rerun = PendingAction.cases.Round.make({
      state: action.state,
      visit: action.visit,
      key: `machine:${run.run}:${run.seq + 2}`,
      attempt: action.attempt,
      fresh: true,
    })
    yield* waitForAccount(run, rerun, { until: view.retryAt, reason: "quota" }, [
      MachineStep.cases.RoundEnded.make({ state: name, round: roundId, dead: true }),
    ])
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
    ...omitUndefined({
      verdict: Option.getOrUndefined(Option.flatten(verdict)),
    }),
  })
  if (dead && action.attempt === 1) {
    // A dead worker gave no verdict: the round runs once more, on a new thread.
    const retry = PendingAction.cases.Round.make({
      state: action.state,
      visit: action.visit,
      key: `${action.key}:retry`,
      attempt: 2,
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
  const value: Schema.Json = { text: view.text, reply: view.reply }
  const committed = yield* commitMove(
    run,
    { ...run, state: to, pending: Option.none(), context: saved(run.context, name, value) },
    [ended, MachineStep.cases.Moved.make({ from: name, to, by: "verdict" })],
  )
  if (Option.isSome(committed) && ownThread(state, action)) {
    yield* threads
      .stop(action.thread, Option.some(`machine-done:${action.key}`))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("machines.thread.stop.failed").pipe(
            Effect.annotateLogs({ run: run.run, cause: Cause.pretty(cause) }),
          ),
        ),
      )
  }
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
  change: (run: Run) => { readonly after: Run; readonly steps: ReadonlyArray<MachineStep> },
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
) {
  const drivers = yield* MachineDrivers
  const store = yield* MachineStore
  // The command outlives this call, in the branch scope: it keeps the services it runs against.
  const services = yield* Effect.context<
    MachineStore | FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner
  >()
  const command = render(state.run, templateScope(run, action.visit))
  const timeout = Duration.seconds(state.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS)
  const record = (process: CommandProcess) =>
    whileCommandPending(run.run, action, (current) => {
      const recorded = PendingAction.cases.Command.make({ ...action, process })
      return {
        after: { ...current, pending: Option.some(recorded) },
        steps: [MachineStep.cases.Recorded.make({ action: recorded })],
      }
    }).pipe(Effect.orDie, Effect.provideContext(services))
  const ended = (result: {
    readonly exitCode: Option.Option<number>
    readonly timedOut: boolean
    readonly output: string
  }) =>
    whileCommandPending(run.run, action, (current) => {
      const passed = Option.contains(result.exitCode, 0)
      let to = state.on.fail
      let by = "fail"
      if (passed) {
        to = state.on.pass
        by = "pass"
      }
      const outputTail = result.output.slice(-OUTPUT_TAIL_CHARS)
      const value: Schema.Json = {
        exitCode: Option.getOrNull(result.exitCode),
        output: outputTail,
      }
      return {
        after: {
          ...current,
          state: to,
          pending: Option.none(),
          context: saved(current.context, action.state, value),
        },
        steps: [
          MachineStep.cases.CommandEnded.make({
            state: action.state,
            timedOut: result.timedOut,
            outputTail,
            ...omitUndefined({ exitCode: Option.getOrUndefined(result.exitCode) }),
          }),
          MachineStep.cases.Moved.make({
            from: action.state,
            to,
            by,
          }),
        ],
      }
    })
  const work = runBashCommand(
    command,
    Option.some(run.cwd),
    Option.none(),
    Option.some({ launch: action.launch, recorded: record }),
  ).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    store.withPermit(Option.fromUndefinedOr(state.permit)),
    Effect.map(
      Option.match({
        onNone: () => ({ exitCode: Option.none<number>(), timedOut: true, output: "" }),
        onSome: (output) => ({
          exitCode: Option.some(output.exitCode),
          timedOut: false,
          output: [output.stdout, output.stderr].filter((text) => text.length > 0).join("\n"),
        }),
      }),
    ),
    // A spawn that fails ran nothing: the command fails with the error as its output.
    Effect.catch((error) =>
      Effect.succeed({ exitCode: Option.none<number>(), timedOut: false, output: String(error) }),
    ),
    Effect.flatMap(ended),
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
          if (Option.isSome(found) && found.value.status === "open") {
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
  ) => { readonly after: Run; readonly steps: ReadonlyArray<MachineStep> },
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
  const line = reasonLine(action, state, templateScope(run, action.visit))
  const content = [
    `Machine ${run.machine} (${run.run}) asks at ${action.state} (${action.reason}).`,
    line,
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
    ...omitUndefined({ mayStillRun: action.mayStillRun }),
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
    return { stop: false, to: state.on.fail }
  }
  if (state.kind === "thread" || state.kind === "ask") {
    return { stop: false, to: state.on?.[choice] ?? action.state }
  }
  return { stop: true, to: action.state }
}

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
 * ask does not offer is invalid. The answer commits, then kicks the host; a
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
    const move = moveFor(state, action, params.choice)
    const answered = MachineStep.cases.Answered.make({
      askId: action.askId,
      choice: params.choice,
      ...omitUndefined({ note: params.note }),
    })
    const value: Schema.Json = { choice: params.choice, ...omitUndefined({ note: params.note }) }
    // A retry of an exhausted ask grants the state one visit past its cap.
    let grants = run.visits.grants
    if (params.choice === "retry" && action.reason === "exhausted") {
      grants = { ...grants, [action.state]: (grants[action.state] ?? 0) + 1 }
    }
    let after: Run = {
      ...run,
      status: "running",
      state: move.to,
      pending: Option.none(),
      context: saved(run.context, action.state, value),
      visits: { ...run.visits, grants },
    }
    let steps: ReadonlyArray<MachineStep> = [
      answered,
      MachineStep.cases.Moved.make({ from: action.state, to: move.to, by: "answer" }),
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
    if (run.status === "stopped") return { run: run.run, status: "stopped" as const }
    if (isTerminal(run.status)) {
      return yield* new MachineError({ message: `Run ${runId} already ended: ${run.status}` })
    }
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

const MachineDefineTool = tool({
  id: "machine.define",
  resources: [MachineStoreResource],
  description:
    "Define a machine: a state machine of thread rounds, commands and asks that runs with no turn of yours between its steps. Writes .gent/machines/<name>.json in the project; the same content writes nothing. A refusal lists every problem.",
  promptSnippet: "Define a reusable state machine of rounds, commands and asks",
  params: Schema.Struct({ definition: MachineDefinition }),
  output: DefineResult,
  execute: Effect.fn("MachineDefineTool.execute")(function* (params) {
    const definition = yield* checkedDefinition(params.definition)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = yield* definitionPath(definition.name)
    const content = `${yield* Schema.encodeEffect(DefinitionFile)(definition)}\n`
    const digest = (yield* sha256Hex(content)).slice(0, 16)
    const existing = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.contains(existing, content)) {
      return { name: definition.name, path: file, digest, written: false }
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* writeFileAtomic(file, content)
    return { name: definition.name, path: file, digest, written: true }
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
    const definition = yield* Schema.decodeEffect(DefinitionJson)(text).pipe(
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
    const host = { sessionId: ctx.sessionId, branchId: ctx.branchId }
    const input = params.input ?? {}
    const run: Run = {
      run: runId,
      machine: definition.name,
      definitionJson: yield* Schema.encodeEffect(DefinitionJson)(definition),
      host,
      ownerThread: yield* callerThread(),
      deliveryPlace: Option.none(),
      cwd: path.resolve(ctx.cwd, params.cwd ?? "."),
      input,
      context: { last: {}, all: {} },
      visits: { counts: {}, grants: {} },
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
    yield* store.insert(run, MachineStep.cases.Started.make({ machine: definition.name, input }))
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

const RunView = Schema.Struct({
  run: RunId,
  machine: MachineName,
  state: StateName,
  status: RunStatus,
  pending: Schema.optionalKey(PendingAction),
  visits: Schema.Record(Schema.String, Count),
  error: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
})

const runView = (run: Run): typeof RunView.Type => ({
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

/** The steps `machine.status` shows, newest last. */
const STATUS_STEPS = 20

/** One run as `machine.status` and `MachinesRpc.Status` read it: its view and its last steps. */
export const MachineRunStatus = Schema.Struct({ ...RunView.fields, steps: Schema.Array(StepView) })
export type MachineRunStatus = typeof MachineRunStatus.Type

const RunStatusParams = Schema.Struct({ run: RunId })

const runStatus = Effect.fn("Machines.runStatus")(function* (params: typeof RunStatusParams.Type) {
  const store = yield* MachineStore
  const run = yield* ownedRun(params.run)
  const steps = yield* store.steps(run.run, STATUS_STEPS)
  return { ...runView(run), steps }
})

const MachineStatusTool = tool({
  id: "machine.status",
  resources: [MachineStoreResource],
  readonly: true,
  description: "Read one run: its state, status, pending action, visits, and its last steps.",
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

/** One run as `machine.list` and `MachinesRpc.Runs` show it, with no steps. */
export type MachineRunView = typeof RunView.Type

/**
 * What a client outside any turn reads of runs (`gent ctl request`, the
 * TUI's band): the views `machine.status` and `machine.list` give, asked as
 * a session of the owner's thread.
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
  Runs: request({
    id: "run-list",
    description: "List the runs your thread started, newest first",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: Schema.Array(RunView),
    resources: [MachineStoreResource],
    execute: () => ownedRuns(),
  }),
})

const MachineListTool = tool({
  id: "machine.list",
  resources: [MachineStoreResource],
  readonly: true,
  description: "List the runs your thread started, newest first.",
  promptSnippet: "List your machine runs",
  params: Tool.EmptyParams,
  output: Schema.Array(RunView),
  execute: () => ownedRuns(),
})

const MachineStopTool = tool({
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
  if (!input.sourceId.startsWith(RUN_SOURCE_PREFIX)) return WakeNext.cases.Done.make({})
  const runId = Schema.decodeOption(RunId)(input.sourceId.slice(RUN_SOURCE_PREFIX.length))
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
    yield* host.register("request", MachinesRpc.Status, MachinesRpc.Runs)
    yield* host.on("wakeDue", (input) => runDue(input))
    yield* host.on("loopOpen", () => repairHost().pipe(logFailure("machines.repair.failed")))
    yield* host.on("sessionDeleted", ({ sessionId }) =>
      Effect.flatMap(MachineStore, (store) => store.removeHostSession(sessionId)),
    )
  }),
})
