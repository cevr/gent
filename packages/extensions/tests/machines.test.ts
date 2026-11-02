import { decodeRequestReply } from "@gent/core/protocol"
import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Sink,
  Schema,
  Scope,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { ChildProcessSpawner } from "effect/process"
import { AiError } from "effect/ai"
import { TestClock } from "effect/testing"
import { BunServices } from "@effect/platform-bun"
import { BunSqlite } from "@gent/core/host-bun"
import type * as Prompt from "effect/ai/Prompt"
import { workspaceIdForCwd } from "@gent/core/host"
import {
  CredentialSlot,
  defineExtension,
  defineRequests,
  defineResource,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  ExtensionId,
  type CapabilityRef,
  Model,
  ModelId,
  omitUndefined,
  ProviderId,
  SessionId,
  type QuotaReading,
  ref,
  reportProviderQuota,
  reportProviderStopReason,
  request,
  runProcess,
  tool,
  WakeNext,
} from "@gent/core/extensions/api"
import {
  ConfigService,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  finishPart,
  LanguageModelLayers,
  runToolWithCtx,
  TEST_MODEL_ID,
  testLeafContext,
  testToolContext,
  textDeltaPart,
  UserConfig,
  advanceUntil,
  waitFor,
} from "@gent/core/test-utils"
import type { Session } from "@gent/core/protocol"
import {
  AnswerParams,
  MACHINE_ASK_TYPE,
  MACHINE_END_TYPE,
  MachineAnswerTool,
  type MachineDefinitionJson,
  MachineRunPage,
  MachineRunStatus,
  MachineStopTool,
  MachinesExtension,
  MachinesRpc,
  MachineStore,
  roundEndSignal,
  shipDefinition,
} from "../src/machines.js"
import { THREAD_ROUND_END_TYPE } from "../src/threads.js"
import { ORCHESTRATE_LIGHT_MACHINE, ORCHESTRATE_MACHINE } from "../src/workflows.js"
import {
  acted,
  billed,
  call,
  type Client,
  encodeJson,
  isWorkerRequest,
  lastUserText,
  restartableHome,
  sendCalls,
  type SessionKey,
  type SnapshotMessage,
  starterStep,
  toolCalls,
} from "./helpers/routed-session"
import { e2ePreset } from "./helpers/test-preset"
import { CANDIDATE, fakeGitHub, FIX, OUTSIDE, type Pr, REPO, SUBJECT } from "./helpers/fake-github"
import { scopedEnv } from "./helpers/process-env"

// ── the routed models ───────────────────────────────────────────────────────

/**
 * One worker round, as its rendered `say` names it: `STATE <state> <visit>`,
 * or `Unit <unit>, <state>, visit <visit>.` in the shipped orchestrate
 * machine; `MODE <mode>`.
 */
interface RoundCall {
  readonly state: string
  readonly visit: number
  readonly mode: string
  readonly text: string
  readonly prompt: Prompt.Prompt
}

const STATE_HEADER = /^STATE (\S+) (\d+)$/m
const UNIT_HEADER = /^Unit \S+, (\S+), visit (\d+)\.$/m

/**
 * The newest user text that is not a host status update: a new date's note
 * may follow the round's own text.
 */
const roundTextOf = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (message.role !== "user") return []
      return [
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ]
    })
    .findLast((text) => !text.startsWith("<host-context-update>")) ?? lastUserText(prompt)

const roundCallOf = (prompt: Prompt.Prompt): RoundCall => {
  const text = roundTextOf(prompt)
  const header = STATE_HEADER.exec(text) ?? UNIT_HEADER.exec(text)
  const mode = /^MODE (\S*)$/m.exec(text)
  return {
    state: header?.[1] ?? "unknown",
    visit: Number(header?.[2] ?? "0"),
    mode: mode?.[1] ?? "",
    text,
    prompt,
  }
}

/** A worker's answer: `thread.reply` with `value` first, then a line of text. */
const replyWith = (round: RoundCall, value: Schema.Json) => {
  if (acted(round.prompt)) return billed(`replied ${round.state} ${round.visit}`)
  return toolCalls([
    { tool: "thread.reply", id: `reply-${round.state}-${round.visit}`, input: { value } },
  ])
}

/** A round whose model call never ends, once `entered` holds. */
const hangAfter = (entered: Effect.Effect<void>) => Stream.unwrap(Effect.as(entered, Stream.never))

/** A worker step that fails at a usage limit resetting in 60 s: past the retry cap, so the turn ends on it. */
const usageLimited = () =>
  Stream.fail(
    AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(60) }),
    }),
  )

/** A worker step the provider refuses for good: the round dies with no retry time. */
const refusedStep = () =>
  Stream.fail(
    AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.ContentPolicyError({ description: "refused" }),
    }),
  )

type WorkerStream =
  | ReturnType<typeof billed>
  | ReturnType<typeof usageLimited>
  | ReturnType<typeof refusedStep>

interface MachineModels {
  /** Each worker round's first model call appends `<state>:<visit>`, outside any database. */
  readonly calls: Ref.Ref<ReadonlyArray<string>>
  /** Each worker round's rendered message, by `<state>:<visit>`. */
  readonly texts: Ref.Ref<ReadonlyArray<readonly [string, string]>>
  readonly worker: (round: RoundCall) => Effect.Effect<WorkerStream>
  /** Runs before each owner model call, with the call's prompt. */
  readonly owner?: (prompt: Prompt.Prompt) => Effect.Effect<void>
}

/** The owner runs its `CALL` lines; a worker answers by its state and visit. */
const machineModels = (models: MachineModels) =>
  LanguageModelLayers.testStream((options) =>
    Effect.gen(function* () {
      if (!isWorkerRequest(options.prompt)) {
        if (Predicate.isNotUndefined(models.owner)) yield* models.owner(options.prompt)
        return starterStep(options.prompt)
      }
      const round = roundCallOf(options.prompt)
      if (!acted(options.prompt)) {
        const key = `${round.state}:${round.visit}`
        yield* Ref.update(models.calls, (all) => [...all, key])
        yield* Ref.update(models.texts, (all) => [...all, [key, round.text] as const])
      }
      return yield* models.worker(round)
    }),
  )

const makeModels = (
  worker: MachineModels["worker"],
  owner?: MachineModels["owner"],
): Effect.Effect<MachineModels> =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const texts = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([])
    return { calls, texts, worker, ...omitUndefined({ owner }) }
  })

// ── machines ────────────────────────────────────────────────────────────────

/** implement → review (changes|accepted) → verify (`true`) → decide (ask) → done. */
const TRACK = {
  name: "track",
  threads: { impl: {}, rev: {} },
  start: "implement",
  states: {
    implement: {
      kind: "thread",
      thread: "impl",
      say: "STATE implement {{visit}}\nSPEC {{input.spec}}\nFINDINGS {{review.reply.findings}}\nECHO implemented",
      next: "review",
    },
    review: {
      kind: "thread",
      thread: "rev",
      say: "STATE review {{visit}}",
      on: { accepted: "verify", changes: "implement" },
    },
    verify: { kind: "run", run: "true", on: { pass: "decide", fail: "implement" } },
    decide: { kind: "ask", ask: "Merge {{input.spec}}?", on: { merge: "done", drop: "done" } },
    done: { kind: "final", say: "track finished" },
  },
}

/** The worker of the track: review 1 asks for changes with a finding, review 2 accepts. */
const trackWorker = (round: RoundCall): Effect.Effect<WorkerStream> => {
  if (round.state === "review" && round.visit === 1) {
    return Effect.succeed(replyWith(round, { next: "changes", findings: "F1" }))
  }
  if (round.state === "review") return Effect.succeed(replyWith(round, { next: "accepted" }))
  return Effect.succeed(billed(`${round.state} ${round.visit} done`))
}

const TRACK_MOVES = [
  "implement→review",
  "review→implement",
  "implement→review",
  "review→verify",
  "verify→decide",
]

/** gate (ask) → work (thread) → check (ask) → done. */
const TWO_ASKS = {
  name: "two-asks",
  threads: { worker: {} },
  start: "gate",
  states: {
    gate: { kind: "ask", ask: "Go?", on: { go: "work", drop: "done" } },
    work: { kind: "thread", thread: "worker", say: "STATE work {{visit}}", next: "check" },
    check: { kind: "ask", ask: "Ok?", on: { ok: "done" } },
    done: { kind: "final" },
  },
}

/** work (thread) → gate (ask: again | done): the same role thread on every visit. */
const LOOP = {
  name: "loop",
  threads: { worker: {} },
  start: "work",
  states: {
    work: { kind: "thread", thread: "worker", say: "STATE work {{visit}}", next: "gate" },
    gate: { kind: "ask", ask: "Again?", on: { again: "work", done: "done" } },
    done: { kind: "final" },
  },
}

/** The visits of b the long loop allows: a and b take turns until b runs out. */
const LONG_LOOP_VISITS = 20

/** a ↔ b over `true` until b is out of rounds and moves to done: a long log, with no model. */
const LONG_LOOP = {
  name: "long-loop",
  threads: {},
  start: "a",
  states: {
    a: { kind: "run", run: "true", on: { pass: "b", fail: "done" }, maxVisits: 30 },
    b: {
      kind: "run",
      run: "true",
      on: { pass: "a", fail: "done" },
      maxVisits: LONG_LOOP_VISITS,
      exhausted: "done",
    },
    done: { kind: "final" },
  },
}

/** One command that records its run, then outlives any test. */
const VERIFY_ONLY = {
  name: "verify-only",
  threads: {},
  start: "verify",
  states: {
    verify: {
      kind: "run",
      run: "echo ran >> ran.log; sleep 60",
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
}

/** One round whose verdict decides; the worker's `MODE` says how it answers. */
const JUDGE = {
  name: "judge",
  threads: { judge: {} },
  start: "judge",
  states: {
    judge: {
      kind: "thread",
      thread: "judge",
      say: "STATE judge {{visit}}\nMODE {{input.mode}}",
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
}

/** One round, then an ask: the boot budget's machine. */
const BUDGET = {
  name: "budget",
  threads: { worker: {} },
  start: "work",
  states: {
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}\nMODE {{input.tag}}",
      next: "hold",
    },
    hold: { kind: "ask", ask: "Hold?", on: { go: "done" } },
    done: { kind: "final" },
  },
}

// ── reading a run ───────────────────────────────────────────────────────────

const StartedRun = Schema.Struct({ run: Schema.String, state: Schema.String })
const decodeStartedRun = Schema.decodeUnknownSync(StartedRun)

const ListedRun = Schema.Struct({ run: Schema.String, status: Schema.String, state: Schema.String })
const decodeListedRuns = Schema.decodeUnknownSync(Schema.Array(ListedRun))

const RunRowView = Schema.Struct({
  state: Schema.String,
  status: Schema.String,
  pending_json: Schema.NullOr(Schema.String),
  notified_at: Schema.NullOr(Schema.Finite),
})
const decodeRunRows = Schema.decodeUnknownSync(Schema.Array(RunRowView))

const runRow = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT state, status, pending_json, notified_at FROM machine_runs
      WHERE run = ${run}`
    return Option.fromUndefinedOr(decodeRunRows(rows)[0])
  })

const StepView = Schema.Struct({
  _tag: Schema.String,
  state: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Json),
  mayStillRun: Schema.optionalKey(Schema.Boolean),
  until: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String),
  dead: Schema.optionalKey(Schema.Boolean),
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  by: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  verdict: Schema.optionalKey(Schema.String),
  met: Schema.optionalKey(Schema.Boolean),
  handedOffTokens: Schema.optionalKey(Schema.Finite),
  windowTokens: Schema.optionalKey(Schema.Finite),
  askId: Schema.optionalKey(Schema.String),
  reused: Schema.optionalKey(Schema.Boolean),
  round: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  maker: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  role: Schema.optionalKey(Schema.String),
  configRole: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cacheRead: Schema.Finite,
      cacheWrite: Schema.Finite,
    }),
  ),
  project: Schema.optionalKey(Schema.String),
  accepted: Schema.optionalKey(Schema.Boolean),
  action: Schema.optionalKey(
    Schema.Struct({
      _tag: Schema.String,
      state: Schema.String,
      thread: Schema.optionalKey(Schema.String),
    }),
  ),
})
const decodeStep = Schema.decodeUnknownSync(Schema.fromJsonString(StepView))
const decodeStepJson = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ step_json: Schema.String })),
)

const stepsOf = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT step_json FROM machine_steps WHERE run = ${run} ORDER BY seq`
    return decodeStepJson(rows).map((row) => decodeStep(row.step_json))
  })

const moves = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.flatMap((step) => {
    if (step._tag !== "Moved") return []
    return [`${step.from ?? ""}→${step.to ?? ""}`]
  })

const decodeNotifies = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ notify: Schema.String })),
)
const roundNotifies = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT notify FROM thread_rounds ORDER BY started_at`
  return decodeNotifies(rows).map((row) => row.notify)
})

const decodeRoundEnds = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      ended_at: Schema.NullOr(Schema.Finite),
      stopped_at: Schema.NullOr(Schema.Finite),
    }),
  ),
)
/** Every thread round's end and stop times, oldest first. */
const roundEnds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT ended_at, stopped_at FROM thread_rounds ORDER BY started_at`
  return decodeRoundEnds(rows)
})

const decodeRecords = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ at: Schema.NullOr(Schema.Finite) })),
)

/** The core wake records of a run. */
const runRecords = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT at FROM branch_wakes WHERE source_id = ${`machine-run:${run}`}`
    return decodeRecords(rows).map((record) => Option.fromNullishOr(record.at))
  })

const decodeRole = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ thread: Schema.String })))

/** The thread a run keeps for `role`. */
const roleThread = (run: string, role: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT json_extract(roles_json, ${`$.${role}`}) AS thread
      FROM machine_runs WHERE run = ${run}`
    return decodeRole(rows)[0]?.thread ?? ""
  })

const AskDetails = Schema.Struct({
  run: Schema.String,
  askId: Schema.String,
  state: Schema.String,
  reason: Schema.String,
  choices: Schema.Array(Schema.String),
  mayStillRun: Schema.optionalKey(Schema.Boolean),
  requires: Schema.optionalKey(
    Schema.Struct({
      file: Schema.String,
      headings: Schema.Array(Schema.String),
      choices: Schema.Array(Schema.String),
    }),
  ),
})
const decodeAsk = Schema.decodeUnknownSync(AskDetails)

const ofType = (messages: ReadonlyArray<SnapshotMessage>, type: string) =>
  messages.filter((message) => message.metadata?.customType === type)

/** The owner's `count`-th ask (from 1), once its turn ended. */
const askDetails = (client: Client, owner: SessionKey, count: number, within = 15_000) =>
  Effect.gen(function* () {
    const snapshot = yield* waitFor(
      client.session.getSnapshot(owner),
      (current) =>
        current.runtime._tag === "Idle" &&
        ofType(current.messages, MACHINE_ASK_TYPE).length >= count,
      within,
      `ask ${count} reached the owner`,
    )
    return decodeAsk(ofType(snapshot.messages, MACHINE_ASK_TYPE)[count - 1]?.metadata?.details)
  })

const waitForEnd = (client: Client, owner: SessionKey) =>
  waitFor(
    client.session.getSnapshot(owner),
    (current) =>
      current.runtime._tag === "Idle" && ofType(current.messages, MACHINE_END_TYPE).length > 0,
    15_000,
    "the run's end reached the owner",
  )

const startRun = (
  client: Client,
  owner: SessionKey,
  definition: Schema.Json,
  machine: string,
  input: Schema.Json = {},
  /** Names this start's tool calls: a session holds each call id once. */
  tag = machine,
) =>
  Effect.gen(function* () {
    const [defined] = yield* call(client, owner, [
      ["machine.define", `define-${tag}`, { definition }],
    ])
    expect(defined?.failed).toBe(false)
    const [started] = yield* call(client, owner, [
      ["machine.start", `start-${tag}`, { machine, input }],
    ])
    expect(started?.failed).toBe(false)
    return decodeStartedRun(started?.result).run
  })

const ownerOf = (created: {
  readonly sessionId: SessionKey["sessionId"]
  readonly branchId: SessionKey["branchId"]
}) => ({
  sessionId: created.sessionId,
  branchId: created.branchId,
})

// ── C1: a track with no owner turn between rounds ───────────────────────────

describe("a machine run", () => {
  it.live("a track machine runs to its ask with no owner turn between rounds", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      // The owner's model counts its calls, and the first call whose prompt
      // holds the ask records how many came before it: the barrier.
      const ownerCalls = yield* Ref.make(0)
      const askTurn = yield* Deferred.make<number>()
      const models = yield* makeModels(trackWorker, (prompt) =>
        Effect.gen(function* () {
          const before = yield* Ref.getAndUpdate(ownerCalls, (count) => count + 1)
          if (lastUserText(prompt).includes("asks at decide")) {
            yield* Deferred.succeed(askTurn, before)
          }
        }),
      )
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, TRACK, "track", { spec: "S" })
      // Two `call` turns of two model calls each: no round woke the owner before the ask.
      expect(yield* Deferred.await(askTurn)).toBe(4)
      // An active run keeps its start-only record, so a server start activates its host.
      expect(yield* home.sql(runRecords(run))).toEqual([Option.none()])
      expect(moves(yield* home.sql(stepsOf(run)))).toEqual(TRACK_MOVES)
      const texts = yield* Ref.get(models.texts)
      expect(texts.find(([key]) => key === "implement:2")?.[1]).toContain("FINDINGS F1")
      expect(yield* home.sql(roundNotifies)).toEqual(["none", "none", "none", "none"])
      const ask = yield* askDetails(client, owner, 1)
      expect(ask).toMatchObject({
        run,
        state: "decide",
        reason: "asked",
        choices: ["merge", "drop"],
      })
      // machine.list takes no argument and names the owner's run where it waits.
      const [listed] = yield* call(client, owner, [["machine.list", "list-asking", {}]])
      expect(listed?.failed).toBe(false)
      expect(decodeListedRuns(listed?.result)).toEqual([{ run, status: "asking", state: "decide" }])
      const [answered] = yield* call(client, owner, [
        ["machine.answer", "answer-merge", { run, askId: ask.askId, choice: "merge" }],
      ])
      expect(answered?.failed).toBe(false)
      const ended = yield* waitForEnd(client, owner)
      expect(ofType(ended.messages, THREAD_ROUND_END_TYPE)).toEqual([])
      const row = yield* waitFor(
        home.sql(runRow(run)),
        (found) => Option.exists(found, (current) => Predicate.isNotNull(current.notified_at)),
        8_000,
        "the end was told",
      )
      expect(Option.map(row, (found) => [found.status, found.state])).toEqual(
        Option.some(["final", "done"]),
      )
      // A settled run withdraws its record.
      yield* waitFor(
        home.sql(runRecords(run)),
        (records) => records.length === 0,
        8_000,
        "the record went",
      )
      expect(yield* Ref.get(models.calls)).toEqual([
        "implement:1",
        "review:1",
        "implement:2",
        "review:2",
      ])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a track machine runs to its end through the RPC harness", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(trackWorker)
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer: machineModels(models),
        storagePath: `${home.home}/gent.db`,
        cwd: home.cwd,
        home: home.home,
      })
      const owner = { sessionId, branchId }
      const run = yield* startRun(client, owner, TRACK, "track", { spec: "S" })
      const ask = yield* askDetails(client, owner, 1)
      // A client outside any turn reads the run as a session of its owner's thread.
      const statusRef = ref(MachinesRpc.Status)
      const readStatus = (session: SessionKey) =>
        client.extension.request({
          ...session,
          extensionId: statusRef.extensionId,
          capabilityId: statusRef.capabilityId,
          input: { run },
        })
      const asking = yield* decodeRequestReply(MachineRunStatus)(yield* readStatus(owner))
      expect(asking.status).toBe("asking")
      expect(String(asking.state)).toBe("decide")
      expect(asking.steps.length).toBeGreaterThan(0)
      const stranger = yield* client.session.create({ cwd: home.cwd })
      const refused = yield* readStatus(stranger).pipe(Effect.as("answered"), Effect.flip)
      expect(String(refused)).toContain("belongs to another thread")
      // The band lists the runs of the thread in view, and none of another's.
      const runsRef = ref(MachinesRpc.Runs)
      const listRuns = (session: SessionKey) =>
        client.extension
          .request({
            ...session,
            extensionId: runsRef.extensionId,
            capabilityId: runsRef.capabilityId,
            input: {},
          })
          .pipe(Effect.flatMap(decodeRequestReply(runsRef.output)))
      const listed = yield* listRuns(owner)
      expect(listed.map((view) => [view.run, view.status, String(view.state)])).toEqual([
        [run, "asking", "decide"],
      ])
      expect(yield* listRuns(stranger)).toEqual([])
      yield* call(client, owner, [
        ["machine.answer", "answer-drop", { run, askId: ask.askId, choice: "drop" }],
      ])
      yield* waitForEnd(client, owner)
      expect(moves(yield* home.sql(stepsOf(run)))).toEqual([...TRACK_MOVES, "decide→done"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "the run page reads every state visit, then only the open one, and stops the run through the client requests",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer: machineModels(models),
          storagePath: `${home.home}/gent.db`,
          cwd: home.cwd,
          home: home.home,
        })
        const owner = { sessionId, branchId }
        const run = decodeRunId(yield* startRun(client, owner, TRACK, "track", { spec: "S" }))
        yield* askDetails(client, owner, 1)
        const pageRef = ref(MachinesRpc.Page)
        const page = yield* machinesRequest(client, owner, pageRef, { run })
        // A visit per state entry, oldest first: how each ended and where the run went.
        expect(
          page.trail.map((visit) => [
            `${visit.state}#${visit.visit}`,
            visit.rounds,
            visit.outcome ?? "",
            visit.to ?? "",
          ]),
        ).toEqual([
          ["implement#1", 1, "", "review"],
          ["review#1", 1, "changes", "implement"],
          ["implement#2", 1, "", "review"],
          ["review#2", 1, "accepted", "verify"],
          ["verify#1", 0, "pass", "decide"],
          ["decide#1", 0, "", ""],
        ])
        // A round's visit names the thread it ran on, as the run's own receipts do.
        const threads = roundThreads(yield* home.sql(stepsOf(run)))
        const [implementer, reviewer] = threads
        expect(
          page.trail
            .flatMap((visit) => Option.toArray(Option.fromUndefinedOr(visit.thread)))
            .map(String),
        ).toEqual([implementer, reviewer, implementer, reviewer].map(String))
        const open = page.trail.filter((visit) => Predicate.isUndefined(visit.endedAt))
        expect(open.map((visit) => `${visit.state}#${visit.visit}`)).toEqual(["decide#1"])
        // The next read starts at the open visit's first step: only that visit again.
        expect(page.since).toBe(0)
        expect(open.map((visit) => visit.seq)).toEqual([page.next])
        const again = yield* machinesRequest(client, owner, pageRef, { run, since: page.next })
        expect(again.trail).toEqual(open)
        expect(again.next).toBe(page.next)
        // Only the owner's thread stops it; a stop of a stopped run answers again.
        const stopRef = ref(MachinesRpc.Stop)
        const stranger = yield* client.session.create({ cwd: home.cwd })
        const refused = yield* machinesRequest(client, stranger, stopRef, { run }).pipe(Effect.flip)
        expect(String(refused)).toContain("belongs to another thread")
        expect(yield* machinesRequest(client, owner, stopRef, { run })).toEqual({
          run,
          status: "stopped",
        })
        expect(yield* machinesRequest(client, owner, stopRef, { run })).toEqual({
          run,
          status: "stopped",
        })
        // The stop ends the open visit: from its first step, and over the whole log.
        const stopped = yield* machinesRequest(client, owner, pageRef, { run, since: page.next })
        expect(stopped.status).toBe("stopped")
        expect(
          stopped.trail.map((visit) => [
            `${visit.state}#${visit.visit}`,
            visit.outcome ?? "",
            Predicate.isNumber(visit.endedAt),
          ]),
        ).toEqual([["decide#1", "stopped", true]])
        expect(stopped.next).toBeGreaterThan(page.next)
        const whole = yield* machinesRequest(client, owner, pageRef, { run })
        expect(whole.trail.filter((visit) => Predicate.isUndefined(visit.endedAt))).toEqual([])
        expect(whole.trail.slice(0, -1)).toEqual(page.trail.slice(0, -1))
        // The model's view of the run is the status it was: its steps, no trail.
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), { run })
        expect(status.status).toBe("stopped")
        expect(status.steps.length).toBeGreaterThan(0)
        expect(Object.hasOwn(status, "trail")).toBe(false)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "a long run's page reads its whole trail once, then only what is new, and never the machine's other runs",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const ran = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
            const owner = ownerOf(yield* client.session.create({}))
            const run = decodeRunId(yield* startRun(client, owner, LONG_LOOP, "long-loop"))
            yield* waitForEnd(client, owner)
            return { owner, run }
          }),
        )
        // Over the same file, with no server: the store counts what the page reads.
        const reads = yield* Ref.make({ outcomes: 0, steps: 0, rows: 0 })
        const counted = Layer.effect(
          MachineStore,
          Effect.map(MachineStore, (live) =>
            MachineStore.of({
              ...live,
              outcomesOf: (machine) =>
                Effect.andThen(
                  Ref.update(reads, (seen) => ({ ...seen, outcomes: seen.outcomes + 1 })),
                  live.outcomesOf(machine),
                ),
              steps: (run, limit) =>
                Effect.andThen(
                  Ref.update(reads, (seen) => ({ ...seen, steps: seen.steps + 1 })),
                  live.steps(run, limit),
                ),
              visitSteps: (run, window) =>
                live
                  .visitSteps(run, window)
                  .pipe(
                    Effect.tap((rows) =>
                      Ref.update(reads, (seen) => ({ ...seen, rows: seen.rows + rows.length })),
                    ),
                  ),
            }),
          ),
        ).pipe(
          Layer.provide(MachineStore.Live),
          Layer.provide(BunSqlite.file(`${home.home}/gent.db`)),
          Layer.provide(BunServices.layer),
        )
        const stub = testToolContext().Session
        // oxlint-disable-next-line effect/noNullish -- the facade's absent-session answer
        const absentSession: Session | undefined = undefined
        const ctx = testToolContext({
          ...ran.owner,
          cwd: home.cwd,
          home: home.home,
          Session: { ...stub, getSession: () => Effect.succeed(absentSession) },
        })
        // The handler as the registry runs it, typed by what this test gives it.
        const pageHandler: (
          input: typeof MachinesRpc.Page.input.Type,
        ) => Effect.Effect<
          MachineRunPage,
          Effect.Error<ReturnType<typeof MachinesRpc.Page.effect>>,
          MachineStore | ExtensionContext
        > = MachinesRpc.Page.effect
        const readPage = (since: Option.Option<number>) =>
          pageHandler({
            run: ran.run,
            ...omitUndefined({ since: Option.getOrUndefined(since) }),
          }).pipe(
            Effect.flatMap(Schema.encodeUnknownEffect(MachineRunPage)),
            Effect.flatMap(Schema.decodeUnknownEffect(MachineRunPage)),
            Effect.provideService(ExtensionContext, testLeafContext(ctx)),
            Effect.provide(counted),
          )
        const whole = yield* readPage(Option.none())
        // a and b take turns until b is out of rounds: its refused visit moves to done.
        expect(whole.status).toBe("final")
        expect(whole.trail).toHaveLength(LONG_LOOP_VISITS * 2 + 3)
        expect(
          whole.trail
            .slice(-3)
            .map((visit) => [`${visit.state}#${visit.visit}`, visit.outcome ?? "", visit.to ?? ""]),
        ).toEqual([
          [`a#${LONG_LOOP_VISITS + 1}`, "pass", "b"],
          [`b#${LONG_LOOP_VISITS + 1}`, "exhausted", "done"],
          ["done#1", "", ""],
        ])
        expect(whole.trail.filter((visit) => Predicate.isUndefined(visit.endedAt))).toEqual([])
        const read = yield* Ref.get(reads)
        expect(read.outcomes).toBe(0)
        expect(read.steps).toBe(0)
        // The run ended: the read from its `next` holds no visit and reads no step.
        const after = yield* readPage(Option.some(whole.next))
        expect(after.trail).toEqual([])
        expect(after.next).toBe(whole.next)
        expect(yield* Ref.get(reads)).toEqual(read)
        // A read from the last visit's first step reads that visit's steps alone.
        const last = whole.trail.at(-1)?.seq ?? 0
        const tail = yield* readPage(Option.some(last))
        expect(tail.trail).toEqual(whole.trail.slice(-1))
        expect((yield* Ref.get(reads)).rows - read.rows).toBe(1)
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
  )
})

// ── round ends while a driver waits ─────────────────────────────────────────

describe("a driver's round-end signal", () => {
  it.live("round ends that come while nothing takes them leave one signal and no backlog", () =>
    Effect.gen(function* () {
      const ends = yield* PubSub.unbounded<unknown>()
      const subscription = yield* PubSub.subscribe(ends)
      const signal = yield* roundEndSignal(subscription)
      yield* Effect.forEach(
        Array.from({ length: 1_000 }, (_, index) => index),
        (index) => PubSub.publish(ends, index),
      )
      const backlog = yield* waitFor(
        PubSub.remaining(subscription),
        (left) => left === 0,
        5_000,
        "the signal drained the subscription",
      )
      expect(backlog).toBe(0)
      // One take sees that ends came; nothing more waits behind it.
      yield* Queue.take(signal)
      expect(yield* Queue.size(signal)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )
})

// ── C2: a clean restart mid-round ───────────────────────────────────────────

/** The track, with the round at `hangOn` hanging once `entered` holds. */
const hangingTrack =
  (hangOn: string, entered: Deferred.Deferred<boolean>) =>
  (round: RoundCall): Effect.Effect<WorkerStream> => {
    if (`${round.state}:${round.visit}` === hangOn) {
      return Effect.succeed(hangAfter(Effect.asVoid(Deferred.succeed(entered, true))))
    }
    return trackWorker(round)
  }

/** Runs the first root until the round at `hangOn` hangs, and returns the run and its owner. */
const runUntilHang = (
  home: Effect.Success<typeof restartableHome>,
  calls: Ref.Ref<ReadonlyArray<string>>,
  hangOn: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<boolean>()
      const models = yield* makeModels(hangingTrack(hangOn, entered))
      const { client } = yield* createRpcClient(home.layerFor(machineModels({ ...models, calls })))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, TRACK, "track", { spec: "S" })
      yield* Deferred.await(entered)
      // The round's admission is committed: its id is in the pending action.
      yield* waitFor(
        home.sql(runRow(run)),
        (row) => Option.exists(row, (found) => (found.pending_json ?? "").includes('"round"')),
        8_000,
        "the round's id was committed",
      )
      return { owner, run }
    }),
  )

/** The second root, with no client call: the run's record activates its host. */
const resumeToAsk = (
  home: Effect.Success<typeof restartableHome>,
  calls: Ref.Ref<ReadonlyArray<string>>,
  run: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const models = yield* makeModels(trackWorker)
      yield* createRpcClient(home.layerFor(machineModels({ ...models, calls })))
      return yield* waitFor(
        home.sql(runRow(run)),
        (row) => Option.exists(row, (found) => found.status === "asking"),
        20_000,
        "the run reached decide",
      )
    }),
  )

describe("a machine run across a clean restart", () => {
  it.live(
    "a restart mid-round resumes the run with no owner message and reruns no ended round",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        const first = yield* runUntilHang(home, calls, "review:2")
        const row = yield* resumeToAsk(home, calls, first.run)
        expect(Option.map(row, (found) => found.state)).toEqual(Option.some("decide"))
        // review 2 ran twice: cut short, then resumed. No ended round ran again.
        expect(yield* Ref.get(calls)).toEqual([
          "implement:1",
          "review:1",
          "implement:2",
          "review:2",
          "review:2",
        ])
        expect(moves(yield* home.sql(stepsOf(first.run)))).toEqual(TRACK_MOVES)
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
  )

  it.live("a round the owner's Sabbath ended waits for the Sabbath's end as a sabbath wait", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const first = yield* runUntilHang(home, calls, "implement:1")
      const end = (yield* Clock.currentTimeMillis) + HOUR
      // As the Sabbath leaves a round whose turn it stopped at sunset, its
      // end recorded before a restart.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE thread_rounds
            SET ended_at = ${yield* Clock.currentTimeMillis}, stream_failed = 1,
                error = 'No run goes on in the owner''s Sabbath',
                retry_at = ${end}, retry_cause = 'sabbath'
            WHERE ended_at IS NULL`
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const models = yield* makeModels(trackWorker)
          yield* createRpcClient(home.layerFor(machineModels({ ...models, calls })))
          const steps = yield* waitFor(
            home.sql(stepsOf(first.run)),
            (found) => waitsOf(found).length === 1,
            20_000,
            "the round waits for the Sabbath's end",
          )
          expect(waitsOf(steps)).toEqual([{ reason: "sabbath", until: end }])
        }),
      )
      // The round the Sabbath ended did not run again before its end.
      expect(yield* Ref.get(calls)).toEqual(["implement:1"])
    }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
  )

  it.live("a round admitted but not recorded is sent again as the same round", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const first = yield* runUntilHang(home, calls, "implement:1")
      // As a process that died between the send and its record leaves the row.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE machine_runs
            SET pending_json = json_remove(pending_json, '$.round', '$.thread'), roles_json = '{}'
            WHERE run = ${first.run}`
        }),
      )
      yield* resumeToAsk(home, calls, first.run)
      // implement 1 was cut and resumed: the same key sent no second round.
      expect(yield* Ref.get(calls)).toEqual([
        "implement:1",
        "implement:1",
        "review:1",
        "implement:2",
        "review:2",
      ])
      expect(yield* home.sql(roundNotifies)).toHaveLength(4)
    }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
  )
})

/** An ask whose note the round reads, then a round capped at one visit that asks to go again. */
const REVISIT = {
  name: "revisit",
  threads: { worker: {} },
  start: "note",
  states: {
    note: { kind: "ask", ask: "Note?", on: { go: "work" } },
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}\nNOTE {{note.note}}",
      on: { again: "work", end: "done" },
      maxVisits: 1,
    },
    done: { kind: "final" },
  },
}

describe("a run's visits and saved values across a restart", () => {
  it.live("a grant, the visit count and a saved note come back from the step log", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels((round) =>
        Effect.succeed(replyWith(round, { next: "again" })),
      )
      const layer = () => home.layerFor(machineModels(models))
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(layer())
          const owner = ownerOf(yield* client.session.create({}))
          yield* startRun(client, owner, REVISIT, "revisit")
          yield* answerAsk(client, owner, 1, "go", "keep")
          expect(yield* askDetails(client, owner, 2)).toMatchObject({ reason: "exhausted" })
          return owner
        }),
      )
      const run = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(layer())
          const retried = yield* answerAsk(client, owner, 2, "retry")
          expect(yield* askDetails(client, owner, 3)).toMatchObject({ reason: "exhausted" })
          return retried.run
        }),
      )
      // The retry ran the one granted visit, and the round read the note
      // the first server saved.
      expect(yield* Ref.get(models.calls)).toEqual(["work:1", "work:2"])
      const texts = new Map(yield* Ref.get(models.texts))
      expect(texts.get("work:2")).toContain("NOTE keep")
      const stored = yield* home.sql(storedRun(run))
      expect(stored.visits).toEqual({ counts: { note: 1, work: 2 }, grants: { work: 1 } })
      expect(stored.context.last["note"]).toEqual({ choice: "go", note: "keep" })
    }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
  )
})

// ── C3: a command cut by a clean stop ───────────────────────────────────────

describe("a machine command across a clean stop", () => {
  it.live("a command cut by a stop asks interrupted and never runs again", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(trackWorker)
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
          const owner = ownerOf(yield* client.session.create({}))
          const run = yield* startRun(client, owner, VERIFY_ONLY, "verify-only")
          yield* waitFor(
            home.sql(runRow(run)),
            (row) =>
              Option.exists(row, (found) => (found.pending_json ?? "").includes('"process"')),
            8_000,
            "the command recorded its process",
          )
          // The process is recorded at its spawn: the stop waits until the command ran.
          yield* waitFor(
            Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(`${home.cwd}/ran.log`)).pipe(
              Effect.provide(BunServices.layer),
              Effect.orDie,
            ),
            (exists) => exists,
            8_000,
            "the command ran",
          )
          return { owner, run }
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
          // No client call until the run asks: the run's own record activates its host.
          yield* waitFor(
            home.sql(runRow(first.run)),
            (row) => Option.exists(row, (found) => found.status === "asking"),
            15_000,
            "the run asked",
          )
          const ask = yield* askDetails(client, first.owner, 1)
          expect(ask).toMatchObject({
            run: first.run,
            state: "verify",
            reason: "interrupted",
            choices: ["pass", "fail", "retry", "stop"],
          })
          // The closed scope killed the group, so nothing may still run.
          expect(ask.mayStillRun).toBeUndefined()
        }),
      )
      // The command ran once: the restart asked instead of running it again.
      const ran = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readFileString(`${home.cwd}/ran.log`),
      ).pipe(Effect.provide(BunServices.layer))
      expect(ran.trim().split("\n")).toEqual(["ran"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── a command past its time budget ──────────────────────────────────────────

const SLOW_CHECK = {
  name: "slow-check",
  threads: {},
  start: "check",
  states: {
    check: { kind: "run", run: "sleep 30", timeoutSeconds: 1, on: { pass: "done", fail: "done" } },
    done: { kind: "final" },
  },
}

describe("a machine command past its time budget", () => {
  it.live("fails, and saves that it timed out for the next state's template", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SLOW_CHECK, "slow-check")
      yield* waitFor(home.sql(runRow(run)), isSettled, 15_000, "the run's end was told")
      const steps = yield* home.sql(stepsOf(run))
      const saved = steps.flatMap((step) => {
        if (step._tag !== "Saved" || step.state !== "check") return []
        return [step.value]
      })
      // A killed command has no exit code, so only the flag tells a timeout from a red test.
      expect(saved).toMatchObject([{ timedOut: true, output: "" }])
    }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )
})

// ── a definition's shipped files ────────────────────────────────────────────

/** A command that prints the shipped file's path, then runs it. */
const SHIPPED_FILE = {
  name: "shipped-file",
  threads: {},
  start: "check",
  states: {
    check: {
      kind: "run",
      run: 'echo "{{files.probe.sh}}"\nbash "{{files.probe.sh}}" {{input.word}}',
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
  files: { "probe.sh": 'echo "probe ran with $1"' },
}

/**
 * Run states with an `error` edge: exit 1 takes `fail`, any other nonzero
 * exit takes `error`; the last runs a shipped TypeScript file on `{{bun}}`.
 */
const ERROR_EDGE = {
  name: "error-edge",
  threads: {},
  start: "one",
  states: {
    one: { kind: "run", run: "exit 1", on: { pass: "wrong", fail: "three", error: "wrong" } },
    three: {
      kind: "run",
      run: "echo three-ran; exit 3",
      on: { pass: "wrong", fail: "wrong", error: "runtime" },
    },
    runtime: {
      kind: "run",
      run: '{{bun}} "{{files.probe.ts}}" {{input.word}}',
      on: { pass: "done", fail: "wrong" },
    },
    wrong: { kind: "final" },
    done: { kind: "final" },
  },
  files: {
    "probe.ts":
      "console.log(typeof Bun, process.versions.bun === Bun.version, process.argv[2], process.env.BUN_BE_BUN)",
  },
}

describe("a definition's shipped files", () => {
  it.live("a command runs a shipped file from a temp directory its end removes", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SHIPPED_FILE, "shipped-file", { word: "hello" })
      yield* waitFor(home.sql(runRow(run)), isSettled, 15_000, "the run's end was told")
      const steps = yield* home.sql(stepsOf(run))
      expect(moves(steps)).toEqual(["check→done"])
      const output = steps.flatMap((step) => {
        if (step._tag !== "Saved" || step.state !== "check") return []
        return [Schema.decodeUnknownSync(Schema.Struct({ output: Schema.String }))(step.value)]
      })[0]?.output
      const [path = "", ran = ""] = (output ?? "").split("\n")
      expect(path).toEndWith("/probe.sh")
      expect(ran).toBe("probe ran with hello")
      expect(yield* fileExists(path)).toBe(false)
    }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )

  it.live(
    "a run state's error edge takes any end but exit 0 and 1, and {{bun}} runs a shipped file on gent's runtime",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRun(client, owner, ERROR_EDGE, "error-edge", { word: "hello" })
        yield* waitFor(home.sql(runRow(run)), isSettled, 15_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual(["one→three", "three→runtime", "runtime→done"])
        const moved = steps.filter((step) => step._tag === "Moved")
        expect(moved.map((step) => step.by)).toEqual(["fail", "error", "pass"])
        // Only the error move carries a note: what ended the command, and its output.
        expect(moved[0]?.note).toBeUndefined()
        expect(moved[1]?.note).toBe(
          "Check error: the three command exited 3, so it gave no verdict. Its output ends:\nthree-ran",
        )
        const output = steps.flatMap((step) => {
          if (step._tag !== "Saved" || step.state !== "runtime") return []
          return [Schema.decodeUnknownSync(Schema.Struct({ output: Schema.String }))(step.value)]
        })[0]?.output
        // BUN_BE_BUN makes a compiled gent run the file as Bun.
        expect(output?.trim()).toBe("object true hello 1")
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )

  it.live(
    "machine.define refuses a file or runtime slot outside a run state, or one naming no file",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const definition = {
          name: "files-refused",
          threads: { worker: {} },
          start: "work",
          states: {
            work: {
              kind: "thread",
              thread: "worker",
              say: "{{files.probe.sh}} {{bun}}",
              next: "check",
            },
            check: {
              kind: "run",
              run: '{{bun.path}} bash "{{files.other.sh}}"',
              on: { pass: "done", fail: "done" },
            },
            done: { kind: "final" },
          },
          files: { "probe.sh": "true" },
        }
        const [refused] = yield* call(client, owner, [
          ["machine.define", "define-files-refused", { definition }],
        ])
        expect(refused?.failed).toBe(true)
        const text = encodeJson(refused?.result)
        expect(text).toContain(
          "work: {{files.probe.sh}} names a file, and only a run state has files",
        )
        expect(text).toContain("check: {{files.other.sh}} names no shipped file")
        expect(text).toContain("work: {{bun}} names the runtime, and only a run state runs it")
        expect(text).toContain("check: {{bun.path}} names no runtime: the slot is {{bun}}")
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})

// ── a shipped definition's project file ─────────────────────────────────────

/** implement (thread) → decide (ask) → done: a definition an extension ships. */
const SHIPPED: MachineDefinitionJson = {
  name: "shipped",
  threads: { impl: {} },
  start: "implement",
  states: {
    implement: { kind: "thread", thread: "impl", say: "STATE implement {{visit}}", next: "decide" },
    decide: { kind: "ask", ask: "Merge {{input.spec}}?", on: { merge: "done", drop: "done" } },
    done: { kind: "final", say: "shipped finished" },
  },
}

/** The same machine as a later gent ships it: its ask reads differently. */
const SHIPPED_NEXT: MachineDefinitionJson = {
  ...SHIPPED,
  states: {
    ...SHIPPED.states,
    decide: { kind: "ask", ask: "Merge {{input.spec}} now?", on: { merge: "done", drop: "done" } },
  },
}

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const encodeFileText = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }))

/**
 * Ships a definition into `cwd` as `/orchestrate` does, on the Bun
 * platform; `fs` stands in for its file system when given.
 */
const shipInto = (
  cwd: string,
  definition: MachineDefinitionJson,
  fs: Option.Option<Layer.Layer<FileSystem.FileSystem>> = Option.none(),
) => {
  const shipped = shipDefinition(definition).pipe(
    Effect.provideService(ExtensionContext, testLeafContext(testToolContext({ cwd }))),
  )
  return Option.match(fs, {
    onNone: () => shipped,
    onSome: (layer) => Effect.provide(shipped, layer),
  }).pipe(Effect.provide(BunServices.layer))
}

/**
 * A file system on which another writer puts `racer` at `file` the moment a
 * ship stages its own text: a write between the ship's read and its publish.
 */
const racingFileSystem = (file: string, racer: string) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => ({
      ...fs,
      open: (path: string, options?: Parameters<FileSystem.FileSystem["open"]>[1]) => {
        if (!path.startsWith(`${file}.`)) return fs.open(path, options)
        return Effect.andThen(fs.writeFileString(file, racer), fs.open(path, options))
      },
    })),
  ).pipe(Layer.provide(BunServices.layer))

/** A file's text, and its inode and modification time: a write that replaces it changes them. */
const fileState = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file)
    return { text: yield* fs.readFileString(file), ino: info.ino, mtime: info.mtime }
  }).pipe(Effect.provide(BunServices.layer))

const writeText = (file: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(file, text)).pipe(
    Effect.provide(BunServices.layer),
  )

const scratchCwd = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "gent-shipped-" }),
).pipe(Effect.provide(BunServices.layer))

describe("a shipped definition's project file", () => {
  it.live(
    "a shipped file nobody edited takes the next shipped version, and the same version writes nothing",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratchCwd
        const first = yield* shipInto(cwd, SHIPPED)
        expect(first.outcome).toBe("written")
        expect(first.path).toBe(`${cwd}/.gent/machines/shipped.json`)
        const written = yield* fileState(first.path)
        // The marker opens the file: the digest of its text without that line.
        expect(written.text.startsWith(`{\n  "shipped": "${first.digest}",\n  "name"`)).toBe(true)
        const again = yield* shipInto(cwd, SHIPPED)
        expect(again.outcome).toBe("unchanged")
        expect(yield* fileState(first.path)).toEqual(written)
        const next = yield* shipInto(cwd, SHIPPED_NEXT)
        expect(next.outcome).toBe("upgraded")
        expect(next.digest).not.toBe(first.digest)
        const upgraded = yield* fileState(first.path)
        expect(upgraded.text).toContain("Merge {{input.spec}} now?")
        expect(upgraded.text.startsWith(`{\n  "shipped": "${next.digest}",\n`)).toBe(true)
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live("a shipped file the owner edited is kept, its marker left as gent wrote it", () =>
    Effect.gen(function* () {
      const cwd = yield* scratchCwd
      const first = yield* shipInto(cwd, SHIPPED)
      const shipped = yield* fileState(first.path)
      const edited = shipped.text.replace('"say": "shipped finished"', '"say": "mine"')
      expect(edited).not.toBe(shipped.text)
      yield* writeText(first.path, edited)
      const next = yield* shipInto(cwd, SHIPPED_NEXT)
      expect(next.outcome).toBe("kept")
      expect((yield* fileState(first.path)).text).toBe(edited)
      // A change to formatting alone is an edit too: the marker proves the text.
      const reformatted = shipped.text.replace('"name": "shipped"', '"name":  "shipped"')
      yield* writeText(first.path, reformatted)
      expect((yield* shipInto(cwd, SHIPPED_NEXT)).outcome).toBe("kept")
      expect((yield* fileState(first.path)).text).toBe(reformatted)
    }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "machine.define writes no marker: a later ship keeps its file, and a ship of the same definition writes nothing",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const file = `${home.cwd}/.gent/machines/shipped.json`
        // A shipped file the owner then defines becomes the owner's.
        expect((yield* shipInto(home.cwd, SHIPPED)).outcome).toBe("written")
        const [defined] = yield* call(client, owner, [
          ["machine.define", "define-shipped", { definition: SHIPPED }],
        ])
        expect(defined?.failed).toBe(false)
        const own = yield* fileState(file)
        expect(own.text).not.toContain('"shipped":')
        expect(decodeJsonText(own.text)).toEqual(SHIPPED)
        expect((yield* shipInto(home.cwd, SHIPPED)).outcome).toBe("unchanged")
        expect(yield* fileState(file)).toEqual(own)
        expect((yield* shipInto(home.cwd, SHIPPED_NEXT)).outcome).toBe("kept")
        expect(yield* fileState(file)).toEqual(own)
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a file another writer puts in place between the read and the publish is never replaced",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratchCwd
        const file = `${cwd}/.gent/machines/shipped.json`
        // No file at the read: the hard link refuses the one that appeared.
        const appeared = yield* shipInto(
          cwd,
          SHIPPED,
          Option.some(racingFileSystem(file, "appeared\n")),
        )
        expect(appeared.outcome).toBe("kept")
        expect((yield* fileState(file)).text).toBe("appeared\n")
        // A shipped file nobody edited at the read: the upgrade renames over only that text.
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(file)).pipe(
          Effect.provide(BunServices.layer),
        )
        expect((yield* shipInto(cwd, SHIPPED)).outcome).toBe("written")
        const changed = yield* shipInto(
          cwd,
          SHIPPED_NEXT,
          Option.some(racingFileSystem(file, "changed\n")),
        )
        expect(changed.outcome).toBe("kept")
        expect((yield* fileState(file)).text).toBe("changed\n")
      }).pipe(Effect.scoped, Effect.timeout("10 seconds")),
  )

  it.live(
    "the marker survives a decode and encode, and a run of a marked file is the run of the unmarked one",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const shipped = yield* shipInto(home.cwd, SHIPPED)
        const text = (yield* fileState(shipped.path)).text
        expect(`${encodeFileText(decodeJsonText(text))}\n`).toBe(text)
        const [started] = yield* call(client, owner, [
          ["machine.start", "start-marked", { machine: "shipped", input: { spec: "S" } }],
        ])
        expect(started?.failed).toBe(false)
        const marked = decodeStartedRun(started?.result).run
        expect(yield* askDetails(client, owner, 1)).toMatchObject({ run: marked, state: "decide" })
        const unmarked = yield* startRun(client, owner, SHIPPED, "shipped", { spec: "S" })
        expect(yield* askDetails(client, owner, 2)).toMatchObject({
          run: unmarked,
          state: "decide",
        })
        const runOf = (run: string) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const rows = yield* sql<{
              readonly definition_json: string
            }>`SELECT definition_json FROM machine_runs WHERE run = ${run}`
            const steps = yield* stepsOf(run)
            return { definition: rows.map((row) => decodeJsonText(row.definition_json)), steps }
          })
        const fromMarked = yield* home.sql(runOf(marked))
        const fromUnmarked = yield* home.sql(runOf(unmarked))
        // The run holds the definition alone, and moves as the unmarked one does.
        expect(fromMarked.definition).toEqual([SHIPPED])
        expect(fromUnmarked.definition).toEqual([SHIPPED])
        expect(moves(fromMarked.steps)).toEqual(["implement→decide"])
        expect(moves(fromUnmarked.steps)).toEqual(moves(fromMarked.steps))
      }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )
})

describe("a stopped machine command with no process to stop", () => {
  it.live(
    "a stop that cannot show the command's processes gone settles saying they may still run",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(trackWorker)
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
            const owner = ownerOf(yield* client.session.create({}))
            const run = yield* startRun(client, owner, VERIFY_ONLY, "verify-only")
            yield* waitFor(
              home.sql(runRow(run)),
              (row) =>
                Option.exists(row, (found) => (found.pending_json ?? "").includes('"process"')),
              8_000,
              "the command recorded its process",
            )
            return { owner, run }
          }),
        )
        // As a stop that landed while no server ran the command: no record of its
        // process survived, and its receipt holds none.
        const receipt = yield* home.sql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE machine_runs
            SET status = 'stopped', pending_json = json_remove(pending_json, '$.process')
            WHERE run = ${first.run}`
            const rows = yield* sql<{ readonly receipt: string }>`
              SELECT json_extract(pending_json, '$.launch.receipt') AS receipt
              FROM machine_runs WHERE run = ${first.run}`
            return rows[0]?.receipt ?? ""
          }),
        )
        expect(receipt).not.toBe("")
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(receipt, "not a process\n"),
        ).pipe(Effect.provide(BunServices.layer))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(home.layerFor(machineModels(models)))
            yield* waitFor(
              home.sql(runRow(first.run)),
              (row) => Option.exists(row, (found) => Predicate.isNotNull(found.notified_at)),
              15_000,
              "the stop settled",
            )
          }),
        )
        const settled = (yield* home.sql(stepsOf(first.run))).filter(
          (step) => step._tag === "Settled",
        )
        expect(settled.map((step) => [step._tag, step.mayStillRun])).toEqual([["Settled", true]])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── C4: answers ─────────────────────────────────────────────────────────────

const twoAsksWorker = (round: RoundCall): Effect.Effect<WorkerStream> =>
  Effect.succeed(billed(`${round.state} ${round.visit} done`))

describe("machine answers", () => {
  it.live("an answer repeats, conflicts, is invalid or arrives stale, in that order", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, TWO_ASKS, "two-asks")
      const first = yield* askDetails(client, owner, 1)
      const answer = (id: string, choice: string, askId: string) =>
        Effect.map(
          call(client, owner, [["machine.answer", id, { run, askId, choice }]]),
          ([result]) => result,
        )
      const ok = yield* answer("a1", "go", first.askId)
      const again = yield* answer("a2", "go", first.askId)
      const conflict = yield* answer("a3", "drop", first.askId)
      expect(ok?.failed).toBe(false)
      expect(again?.failed).toBe(false)
      expect(encodeJson(conflict?.result)).toContain("(conflict)")
      const second = yield* askDetails(client, owner, 2)
      expect(second.state).toBe("check")
      // An answered ask stays decided by its answer once the run moved on: conflict, not stale.
      const late = yield* answer("a4", "drop", first.askId)
      expect(encodeJson(late?.result)).toContain("(conflict)")
      const invalid = yield* answer("a5", "nope", second.askId)
      expect(encodeJson(invalid?.result)).toContain("(invalid)")
      const [stopped] = yield* call(client, owner, [["machine.stop", "s1", { run }]])
      expect(stopped?.failed).toBe(false)
      // Never answered, and no longer the current ask.
      const stale = yield* answer("a6", "ok", second.askId)
      expect(encodeJson(stale?.result)).toContain("(stale)")
      const row = yield* waitFor(
        home.sql(runRow(run)),
        (found) => Option.exists(found, (current) => Predicate.isNotNull(current.notified_at)),
        8_000,
        "the stop settled",
      )
      expect(Option.map(row, (found) => found.status)).toEqual(Option.some("stopped"))
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("two answers that read the same row commit one answer, and the later one admits it", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
          const owner = ownerOf(yield* client.session.create({}))
          const run = yield* startRun(client, owner, TWO_ASKS, "two-asks")
          const ask = yield* askDetails(client, owner, 1)
          return { owner, run, askId: ask.askId }
        }),
      )
      // Over the same file, with no server: the first two reads of the ask's
      // answer wait for each other, so both answers read one sequence and no
      // answer before either commits.
      const reads = yield* Ref.make(0)
      const bothRead = yield* Deferred.make<void>()
      const barrier = Layer.effect(
        MachineStore,
        Effect.map(MachineStore, (live) =>
          MachineStore.of({
            ...live,
            answered: (run, askId) =>
              live.answered(run, askId).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    const count = yield* Ref.updateAndGet(reads, (seen) => seen + 1)
                    if (count === 2) yield* Deferred.succeed(bothRead, void 0)
                    if (count <= 2) yield* Deferred.await(bothRead)
                  }),
                ),
              ),
          }),
        ),
      ).pipe(
        Layer.provide(MachineStore.Live),
        Layer.provide(BunSqlite.file(`${home.home}/gent.db`)),
        Layer.provide(BunServices.layer),
      )
      // No server reads the kick: each answer is admitted, and nothing runs after it.
      const stub = testToolContext().Session
      // ExtensionSessionService.getSession answers undefined for an absent session.
      // oxlint-disable-next-line effect/noNullish -- the facade's absent-session answer.
      const absentSession: Session | undefined = undefined
      const ctx = testToolContext({
        sessionId: first.owner.sessionId,
        branchId: first.owner.branchId,
        cwd: home.cwd,
        home: home.home,
        Session: { ...stub, getSession: () => Effect.succeed(absentSession) },
        Wakes: () => ({ wakeAt: () => Effect.void, cancelWake: () => Effect.succeed(true) }),
      })
      const input = yield* Schema.decodeEffect(AnswerParams)({
        run: first.run,
        askId: first.askId,
        choice: "go",
      })
      const answerGo = runToolWithCtx(MachineAnswerTool, input, ctx)
      const results = yield* Effect.all([answerGo, answerGo], { concurrency: 2 }).pipe(
        Effect.provide(barrier),
      )
      expect(results.map((result) => result.status)).toEqual(["admitted", "admitted"])
      // The later commit lost the compare, read again, and found the answer.
      expect(yield* Ref.get(reads)).toBeGreaterThanOrEqual(3)
      const steps = yield* home.sql(stepsOf(first.run))
      expect(steps.filter((step) => step._tag === "Answered")).toHaveLength(1)
      expect(moves(steps).filter((move) => move === "gate→work")).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("identical answers in one step commit one answer and one dispatch", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, TWO_ASKS, "two-asks")
      const first = yield* askDetails(client, owner, 1)
      // Six at once, so some read the row before another commits: the compare-and-set
      // sends those back to read again, where they find the answer.
      const input = { run, askId: first.askId, choice: "go", note: "all" }
      const twins = Array.from({ length: 6 }, (_, index) => `twin-${index + 1}`)
      const results = yield* call(
        client,
        owner,
        twins.map((id) => ["machine.answer", id, input] as const),
      )
      expect(results.map((result) => result?.failed)).toEqual(twins.map(() => false))
      yield* askDetails(client, owner, 2)
      const steps = yield* home.sql(stepsOf(run))
      expect(
        steps.filter((step) => step._tag === "Answered" && step.askId === first.askId),
      ).toHaveLength(1)
      expect(
        steps.filter((step) => step._tag === "Dispatched" && step.action?.state === "work"),
      ).toHaveLength(1)
      expect(yield* Ref.get(models.calls)).toEqual(["work:1"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── C6: stop from outside, exhausted cycles, no verdict ─────────────────────

const decodePendingThread = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ thread: Schema.String })),
)

describe("machine failures the owner decides", () => {
  it.live("a worker stopped from outside the machine makes the run ask interrupted", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const entered = yield* Deferred.make<boolean>()
      const models = yield* makeModels(() =>
        Effect.succeed(hangAfter(Effect.asVoid(Deferred.succeed(entered, true)))),
      )
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, JUDGE, "judge", { mode: "hang" })
      yield* Deferred.await(entered)
      const row = yield* waitFor(
        home.sql(runRow(run)),
        (found) =>
          Option.exists(found, (current) => (current.pending_json ?? "").includes('"round"')),
        8_000,
        "the round's id was committed",
      )
      const pending = decodePendingThread(
        Option.getOrElse(
          Option.flatMap(row, (found) => Option.fromNullishOr(found.pending_json)),
          () => "{}",
        ),
      )
      const [stopped] = yield* call(client, owner, [
        ["thread.stop", "stop-worker", { thread: pending.thread }],
      ])
      expect(stopped?.failed).toBe(false)
      const ask = yield* askDetails(client, owner, 1)
      expect(ask).toMatchObject({ run, state: "judge", reason: "interrupted" })
      expect(yield* Ref.get(models.calls)).toEqual(["judge:1"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "a worker stopped from outside whose turn holds out in a tool asks interrupted once the turn ends",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const entered = yield* Deferred.make<boolean>()
        const release = yield* Deferred.make<boolean>()
        // Released before the root closes, so a failed check cannot hang its close.
        yield* Effect.addFinalizer(() => Deferred.succeed(release, true))
        const hold = defineExtension({
          id: "machines-hold-probe",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "tool",
              tool({
                id: "probe.hold",
                description: "Hold until released.",
                params: Schema.Struct({}),
                output: Schema.String,
                execute: () =>
                  Effect.uninterruptible(
                    Deferred.succeed(entered, true).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as("released"),
                    ),
                  ),
              }),
            )
          }),
        })
        const models = yield* makeModels((round) => {
          if (acted(round.prompt)) return Effect.succeed(billed("held"))
          return Effect.succeed(toolCalls([{ tool: "probe.hold", id: "hold-1", input: {} }]))
        })
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            extensionInputs: [...e2ePreset.extensionInputs, hold],
            providerLayer: machineModels(models),
            storagePath: `${home.home}/gent.db`,
            cwd: home.cwd,
            home: home.home,
          }),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRun(client, owner, JUDGE, "judge", { mode: "hold" })
        yield* Deferred.await(entered)
        const row = yield* waitFor(
          home.sql(runRow(run)),
          (found) =>
            Option.exists(found, (current) => (current.pending_json ?? "").includes('"round"')),
          8_000,
          "the round's id was committed",
        )
        const pending = decodePendingThread(
          Option.getOrElse(
            Option.flatMap(row, (found) => Option.fromNullishOr(found.pending_json)),
            () => "{}",
          ),
        )
        // The stop waits 10 s for the held turn, then returns with the round open.
        const [stopped] = yield* call(
          client,
          owner,
          [["thread.stop", "stop-held", { thread: pending.thread }]],
          20_000,
        )
        expect(stopped?.failed).toBe(false)
        expect(Option.map(yield* home.sql(runRow(run)), (found) => found.status)).toEqual(
          Option.some("running"),
        )
        yield* Deferred.succeed(release, true)
        const ask = yield* askDetails(client, owner, 1)
        expect(ask).toMatchObject({ run, state: "judge", reason: "interrupted" })
      }).pipe(Effect.scoped, Effect.timeout("50 seconds")),
    60_000,
  )

  it.live("a stop that lands between a round's admission and its receipt stops the worker", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(() => Effect.succeed(hangAfter(Effect.void)))
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      // The write that admits the round also commits a stop of the running run,
      // as a machine.stop that lands before the machine records the receipt.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql.unsafe(`CREATE TRIGGER stop_at_admission AFTER INSERT ON thread_rounds
            BEGIN
              INSERT INTO machine_steps (run, seq, at, state, step_json)
                SELECT run, seq + 1, 0, state, '{"_tag":"Stopped"}'
                FROM machine_runs WHERE status = 'running';
              UPDATE machine_runs SET status = 'stopped', seq = seq + 1 WHERE status = 'running';
            END`)
        }),
      )
      const run = yield* startRun(client, owner, JUDGE, "judge", { mode: "hang" })
      yield* waitFor(
        home.sql(runRow(run)),
        (found) => Option.exists(found, (current) => Predicate.isNotNull(current.notified_at)),
        15_000,
        "the stop settled",
      )
      // The worker's round ended, stopped: nothing of the run still works.
      const rounds = yield* waitFor(
        home.sql(roundEnds),
        (found) =>
          found.length === 1 && found.every((round) => Predicate.isNotNull(round.ended_at)),
        15_000,
        "the worker's round ended",
      )
      expect(rounds.map((round) => Predicate.isNotNull(round.stopped_at))).toEqual([true])
      const settled = (yield* home.sql(stepsOf(run))).filter((step) => step._tag === "Settled")
      // No process of it may still run: the step says nothing of one.
      expect(settled.map((step) => [step._tag, Object.hasOwn(step, "mayStillRun")])).toEqual([
        ["Settled", false],
      ])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a stop whose round Threads refuses settles saying the worker may still run", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const entered = yield* Deferred.make<boolean>()
      const models = yield* makeModels(() =>
        Effect.succeed(hangAfter(Effect.asVoid(Deferred.succeed(entered, true)))),
      )
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, JUDGE, "judge", { mode: "hang" })
      yield* Deferred.await(entered)
      // The round names a thread this session never started: Threads refuses
      // to read or stop it, so no stop reaches the worker.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE thread_rounds SET thread = 'not-a-thread'`
        }),
      )
      const [stopped] = yield* call(client, owner, [["machine.stop", "stop-refused", { run }]])
      expect(stopped?.failed).toBe(false)
      yield* waitFor(
        home.sql(runRow(run)),
        (found) => Option.exists(found, (current) => Predicate.isNotNull(current.notified_at)),
        8_000,
        "the stop settled",
      )
      const settled = (yield* home.sql(stepsOf(run))).filter((step) => step._tag === "Settled")
      expect(settled.map((step) => [step._tag, step.mayStillRun])).toEqual([["Settled", true]])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a stop while the round waits for a busy thread settles at once", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const entered = yield* Deferred.make<boolean>()
      const models = yield* makeModels((round) => {
        if (round.text.includes("HANG")) {
          return Effect.succeed(hangAfter(Effect.asVoid(Deferred.succeed(entered, true))))
        }
        return twoAsksWorker(round)
      })
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, LOOP, "loop")
      const gate = yield* askDetails(client, owner, 1)
      // The owner gives the run's own role thread a round that never ends.
      const worker = yield* home.sql(roleThread(run, "worker"))
      const [busy] = yield* call(client, owner, [
        ["thread.send", "busy", { thread: worker, message: "HANG" }],
      ])
      expect(busy?.failed).toBe(false)
      yield* Deferred.await(entered)
      yield* call(client, owner, [
        ["machine.answer", "again", { run, askId: gate.askId, choice: "again" }],
      ])
      // The run entered work again, and its send meets the busy thread.
      yield* waitFor(
        home.sql(stepsOf(run)),
        (steps) =>
          steps.filter((step) => step._tag === "Dispatched" && step.action?.state === "work")
            .length === 2,
        8_000,
        "the second round was dispatched",
      )
      const [stopped] = yield* call(client, owner, [["machine.stop", "stop-loop", { run }]])
      expect(stopped?.failed).toBe(false)
      const row = yield* waitFor(
        home.sql(runRow(run)),
        (found) => Option.exists(found, (current) => Predicate.isNotNull(current.notified_at)),
        8_000,
        "the stop settled while the thread was still busy",
      )
      expect(Option.map(row, (found) => found.status)).toEqual(Option.some("stopped"))
      // The second visit's round was never sent: the thread stayed busy throughout.
      const calls = yield* Ref.get(models.calls)
      expect(calls.filter((key) => key.startsWith("work:"))).toEqual(["work:1"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("machine.define refuses cycles of exhausted edges, and lists each", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const definition = {
        name: "cycles",
        threads: { worker: {} },
        start: "a",
        states: {
          a: {
            kind: "thread",
            thread: "worker",
            say: "a",
            next: "b",
            maxVisits: 1,
            exhausted: "a",
          },
          b: {
            kind: "run",
            run: "true",
            on: { pass: "c", fail: "done" },
            maxVisits: 1,
            exhausted: "c",
          },
          c: {
            kind: "run",
            run: "true",
            on: { pass: "done", fail: "done" },
            maxVisits: 1,
            exhausted: "b",
          },
          done: { kind: "final" },
        },
      }
      const [refused] = yield* call(client, owner, [
        ["machine.define", "define-cycles", { definition }],
      ])
      expect(refused?.failed).toBe(true)
      const text = encodeJson(refused?.result)
      expect(text).toContain("exhausted edges form a cycle: a -> a")
      expect(text).toContain("exhausted edges form a cycle: b -> c -> b")
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a round with no verdict runs once more, then asks no-verdict", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels((round) => {
        if (round.mode === "seven") return Effect.succeed(replyWith(round, { next: 7 }))
        return Effect.succeed(billed("no reply"))
      })
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const silent = yield* startRun(client, owner, JUDGE, "judge", { mode: "silent" }, "silent")
      const first = yield* askDetails(client, owner, 1)
      expect(first).toMatchObject({
        run: silent,
        reason: "no-verdict",
        choices: ["pass", "fail", "retry", "stop"],
      })
      const seven = yield* startRun(client, owner, JUDGE, "judge", { mode: "seven" }, "seven")
      const second = yield* askDetails(client, owner, 2)
      expect(second).toMatchObject({ run: seven, reason: "no-verdict" })
      // Each run's round ran twice: once, and once more on a new thread.
      expect(yield* Ref.get(models.calls)).toEqual(["judge:1", "judge:1", "judge:1", "judge:1"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── a round too big for its thread ──────────────────────────────────────────

/** The model window every test round runs on: the test catalog names none. */
const TEST_WINDOW = 128_000

/**
 * work (thread, stops on size past 0.005 windows: 640 tokens) → end, or
 * decide (ask) → end. `input.pad` sizes the round's own message.
 */
const SIZE = {
  name: "size",
  threads: { worker: {} },
  start: "work",
  states: {
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}\nPAD {{input.pad}}",
      on: { done: "end" },
      oversize: { windows: 0.005, to: "decide" },
    },
    decide: { kind: "ask", ask: "SIZE {{visit.note}} decides.", on: { go: "end", drop: "end" } },
    end: { kind: "final" },
  },
}

/** A round's own message of about 1,000 tokens: past SIZE's limit once it leaves the context. */
const PAD = "x".repeat(4_000)

/**
 * A step the window cut: half a reply, then the stop reason Anthropic sends
 * when the window filled. The turn hands the window off and continues.
 */
const windowFullStep = () =>
  Stream.unwrap(
    Effect.as(
      reportProviderStopReason("model_context_window_exceeded"),
      Stream.fromIterable([
        textDeltaPart("the first half of the"),
        finishPart({ finishReason: "unknown", usage: { inputTokens: 1_000, outputTokens: 10 } }),
      ]),
    ),
  )

/**
 * A worker that plays `script` one worker model call at a step, across
 * rounds: `cut` is a step the window cut, `reply` answers `done`, `text`
 * ends the turn. The round's own header leaves the window at a handoff, so
 * a counter, not the prompt, picks the step.
 */
const scriptedWorker = (script: ReadonlyArray<"cut" | "reply" | "text">) =>
  Effect.gen(function* () {
    const step = yield* Ref.make(0)
    return (): Effect.Effect<WorkerStream> =>
      Effect.map(
        Ref.getAndUpdate(step, (count) => count + 1),
        (index) => {
          const next = script[index] ?? "text"
          if (next === "cut") return windowFullStep()
          if (next === "reply") {
            return toolCalls([
              {
                tool: "thread.reply",
                id: `reply-size-${index}`,
                input: { value: { next: "done" } },
              },
            ])
          }
          return billed("finished")
        },
      )
  })

const askText = (messages: ReadonlyArray<SnapshotMessage>) =>
  ofType(messages, MACHINE_ASK_TYPE)
    .flatMap((message) => message.parts)
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("\n")

const decodeRoundSizes = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      handed_off_tokens: Schema.Finite,
      window_tokens: Schema.NullOr(Schema.Finite),
    }),
  ),
)
/** Every thread round's tokens handed off and model window, oldest first. */
const roundSizes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT handed_off_tokens, window_tokens FROM thread_rounds ORDER BY started_at`
  return decodeRoundSizes(rows)
})

/** A run's first `RoundEnded` step. */
const roundEnded = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.find((step) => step._tag === "RoundEnded")

describe("a round too big for its thread", () => {
  it.live("a round whose own work past the limit left the context goes to decide", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const worker = yield* scriptedWorker(["cut", "reply", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SIZE, "size", { pad: PAD })
      const ask = yield* askDetails(client, owner, 1)
      expect(ask).toMatchObject({ run, state: "decide", reason: "asked", choices: ["go", "drop"] })
      const steps = yield* home.sql(stepsOf(run))
      // The size stop moves the run, though the round's verdict named `done`.
      expect(moves(steps)).toEqual(["work→decide"])
      const ended = roundEnded(steps)
      expect(ended).toMatchObject({ verdict: "done", windowTokens: TEST_WINDOW })
      const tokens = ended?.handedOffTokens ?? 0
      // The padded header left the context whole: about 1,000 tokens, past 640.
      expect(tokens).toBeGreaterThanOrEqual(1_000)
      expect(yield* home.sql(roundSizes)).toEqual([
        { handed_off_tokens: tokens, window_tokens: TEST_WINDOW },
      ])
      const note = steps.find((step) => step._tag === "Moved")
      expect(note).toMatchObject({ by: "oversize" })
      const text = askText((yield* client.session.getSnapshot(owner)).messages)
      expect(text).toContain(
        "SIZE Size stop: the work round (role worker, visit 1) replied done, but",
      )
      expect(text).toContain("tokens of its own work left the context")
      expect(text).toContain("the limit is 0.005 windows of 128k: too big for one round")
      expect(text).toContain("Replan its work into smaller units")
      expect(text).toContain("oversized. decides.")
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a round whose own work under the limit left the context moves on its verdict", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const worker = yield* scriptedWorker(["cut", "reply", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SIZE, "size", { pad: "short" })
      yield* waitForEnd(client, owner)
      const steps = yield* home.sql(stepsOf(run))
      expect(moves(steps)).toEqual(["work→end"])
      expect(steps.find((step) => step._tag === "Moved")?.by).toBe("verdict")
      const ended = roundEnded(steps)
      expect(ended).toMatchObject({ verdict: "done", windowTokens: TEST_WINDOW })
      // The cut handed off the short header and the half reply: some tokens, under 640.
      expect(ended?.handedOffTokens ?? 0).toBeGreaterThan(0)
      expect(ended?.handedOffTokens ?? 0).toBeLessThan(640)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a definition with no size limit loads, and its round moves on its verdict", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const worker = yield* scriptedWorker(["cut", "reply", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      // The same machine with no `oversize`: decide is reached by the round's verdict.
      const { oversize: _limit, ...work } = SIZE.states.work
      const unlimited = {
        ...SIZE,
        states: { ...SIZE.states, work: { ...work, on: { done: "decide" } } },
      }
      const run = yield* startRun(client, owner, unlimited, "size", { pad: PAD })
      yield* askDetails(client, owner, 1)
      const steps = yield* home.sql(stepsOf(run))
      expect(moves(steps)).toEqual(["work→decide"])
      expect(steps.find((step) => step._tag === "Moved")?.by).toBe("verdict")
      // The round still measures its size; only a limit stops on it.
      expect(roundEnded(steps)?.handedOffTokens ?? 0).toBeGreaterThanOrEqual(1_000)
      // A move by verdict has no note: the slot renders empty, with one space.
      const text = askText((yield* client.session.getSnapshot(owner)).messages)
      expect(text).toContain("SIZE decides.")
      expect(text).not.toContain("SIZE  decides.")
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a round on a continued thread counts only its own work, not earlier rounds'", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      // first: reply, end. second: a cut at its first step, reply, end.
      const worker = yield* scriptedWorker(["reply", "text", "cut", "reply", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const continued = {
        name: "size",
        threads: { worker: {} },
        start: "first",
        states: {
          first: {
            kind: "thread",
            thread: "worker",
            say: "STATE first {{visit}}\nPAD {{input.pad}}",
            next: "second",
          },
          second: {
            kind: "thread",
            thread: "worker",
            say: "STATE second {{visit}}",
            on: { done: "end" },
            oversize: { windows: 0.005, to: "decide" },
          },
          decide: { kind: "ask", ask: "SIZE {{visit.note}}", on: { go: "end" } },
          end: { kind: "final" },
        },
      }
      const run = yield* startRun(client, owner, continued, "size", { pad: PAD })
      yield* waitForEnd(client, owner)
      const steps = yield* home.sql(stepsOf(run))
      // The cut kept the second round's header and handed off the first
      // round's padded work, which is not the second round's: the second
      // moves on its verdict, its own size 0.
      expect(moves(steps)).toEqual(["first→second", "second→end"])
      expect(yield* home.sql(roundSizes)).toEqual([
        { handed_off_tokens: 0, window_tokens: TEST_WINDOW },
        { handed_off_tokens: 0, window_tokens: TEST_WINDOW },
      ])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a size stop with no verdict goes to decide before any retry or no-verdict ask", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const worker = yield* scriptedWorker(["cut", "text", "text", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SIZE, "size", { pad: PAD })
      const ask = yield* askDetails(client, owner, 1)
      expect(ask).toMatchObject({ run, state: "decide", reason: "asked" })
      const steps = yield* home.sql(stepsOf(run))
      expect(moves(steps)).toEqual(["work→decide"])
      expect(steps.find((step) => step._tag === "Moved")?.by).toBe("oversize")
      // One round: a no-verdict round would run once more on a new thread first.
      expect(yield* home.sql(roundSizes)).toHaveLength(1)
      const text = askText((yield* client.session.getSnapshot(owner)).messages)
      expect(text).toContain("the work round (role worker, visit 1) gave no verdict, but")
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a definition whose template names a visit field other than note is refused", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(() => Effect.succeed(billed("unused")))
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const definition = {
        ...SIZE,
        states: {
          ...SIZE.states,
          decide: { kind: "ask", ask: "SIZE {{visit.foo}}", on: { go: "end" } },
        },
      }
      const [refused] = yield* call(client, owner, [
        ["machine.define", "define-visit-field", { definition }],
      ])
      expect(refused?.failed).toBe(true)
      expect(encodeJson(refused?.result)).toContain("decide: {{visit.foo}} names no state")
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a definition whose ask requires a file for a choice it lacks, after a move no run makes, by a slot no run holds, or under a padded heading, is refused",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(() => Effect.succeed(billed("unused")))
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const requires = {
          choices: ["go"],
          after: ["exhausted", "oversize", "done"],
          file: "{{input.dir}}/why.md",
          headings: ["Why"],
        }
        const withRequires = (changed: Readonly<Record<string, Schema.Json>>) => ({
          ...SIZE,
          states: {
            ...SIZE.states,
            decide: {
              kind: "ask",
              ask: "SIZE",
              on: { go: "end" },
              requires: { ...requires, ...changed },
            },
          },
        })
        const define = (id: string, changed: Readonly<Record<string, Schema.Json>>) =>
          Effect.map(
            call(client, owner, [["machine.define", id, { definition: withRequires(changed) }]]),
            ([result]) => result,
          )
        // A move kind and a verdict a thread state's on names are both edges.
        expect((yield* define("define-requires-ok", {}))?.failed).toBe(false)
        const refused = yield* define("define-requires", {
          choices: ["go", "redo"],
          after: ["exhausted", "exhaustd"],
          file: "{{nowhere.dir}}/why.md",
        })
        expect(refused?.failed).toBe(true)
        const text = encodeJson(refused?.result)
        expect(text).toContain("decide: requires names no choice redo")
        expect(text).toContain("decide: requires after names no move exhaustd")
        expect(text).not.toContain("names no move exhausted")
        expect(text).toContain("decide: {{nowhere.dir}} names no state")
        // A file's heading is read trimmed: a padded one could never match.
        for (const [index, heading] of [" Why", "Why ", "Why\t"].entries()) {
          const padded = yield* define(`define-heading-${index}`, { headings: [heading] })
          expect(padded?.failed).toBe(true)
        }
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a decide entered by a size stop owes no diagnosis: its guarded choice is admitted", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const worker = yield* scriptedWorker(["cut", "reply", "text"])
      const models = yield* makeModels(worker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      // The shipped decide's edges, on a machine whose round can say stuck.
      const shipped = ORCHESTRATE_MACHINE.states["decide"]
      if (shipped?.kind !== "ask") return yield* Effect.die("the shipped decide is an ask")
      const after = shipped.requires?.after ?? []
      expect(after).toEqual(["exhausted", "stuck"])
      const definition = {
        ...SIZE,
        states: {
          ...SIZE.states,
          work: { ...SIZE.states.work, on: { done: "end", stuck: "decide" } },
          decide: {
            ...SIZE.states.decide,
            requires: { choices: ["go"], after, file: "{{input.dir}}/why.md", headings: ["Why"] },
          },
        },
      }
      const run = yield* startRun(client, owner, definition, "size", { pad: PAD, dir: home.cwd })
      const ask = yield* askDetails(client, owner, 1)
      expect(ask).toMatchObject({ state: "decide", reason: "asked" })
      expect(ask.requires).toBeUndefined()
      const [answered] = yield* call(client, owner, [
        ["machine.answer", "go-sized", { run: ask.run, askId: ask.askId, choice: "go" }],
      ])
      expect(answered?.failed).toBe(false)
      yield* waitForEnd(client, owner)
      expect(moves(yield* home.sql(stepsOf(run)))).toEqual(["work→decide", "decide→end"])
      expect(yield* fileExists(`${home.cwd}/why.md`)).toBe(false)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── an ask that requires a file ─────────────────────────────────────────────

/** work asks to go again; past its one visit it moves to decide by `exhausted`, where redo needs why.md. */
const REQUIRES = {
  name: "requires",
  threads: { worker: {} },
  start: "work",
  states: {
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}",
      on: { again: "work" },
      maxVisits: 1,
      exhausted: "decide",
    },
    decide: {
      kind: "ask",
      ask: "Decide.",
      on: { redo: "done", go: "done" },
      requires: {
        choices: ["redo"],
        after: ["exhausted"],
        file: "{{input.dir}}/why.md",
        headings: ["Why"],
      },
    },
    done: { kind: "final" },
  },
}

const WHY = "# Why\n\nThe round asks again for the same reason.\n"

const againWorker = (round: RoundCall) => Effect.succeed(replyWith(round, { next: "again" }))

describe("an ask that requires a file", () => {
  it.live(
    "a guarded answer needs the file changed since the ask: a stale, a touched or a restarted one is refused",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(againWorker)
        const layer = () => home.layerFor(machineModels(models))
        const file = `${home.cwd}/why.md`
        // A file from an earlier visit is there before the ask.
        yield* writeFiles(home.cwd, { "why.md": WHY })
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layer())
            const owner = ownerOf(yield* client.session.create({}))
            const run = yield* startRun(client, owner, REQUIRES, "requires", { dir: home.cwd })
            const ask = yield* askDetails(client, owner, 1)
            expect(ask).toMatchObject({
              state: "decide",
              requires: { file, headings: ["Why"], choices: ["redo"] },
            })
            const stale = yield* tryAnswer(client, owner, ask, "redo", "stale")
            expect(stale?.failed).toBe(true)
            expect(encodeJson(stale?.result)).toContain(
              `(unmet): redo needs ${file} with text under Why, changed since this ask: unchanged since the ask`,
            )
            // A touch gives the file a new mtime and keeps its text.
            yield* touchFile(file, 120)
            const touched = yield* tryAnswer(client, owner, ask, "redo", "touched")
            expect(touched?.failed).toBe(true)
            expect(encodeJson(touched?.result)).toContain("unchanged since the ask")
            return { owner, run, ask }
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layer())
            // A new server reads the digest the ask recorded.
            const restarted = yield* tryAnswer(client, first.owner, first.ask, "redo", "restarted")
            expect(restarted?.failed).toBe(true)
            expect(encodeJson(restarted?.result)).toContain("unchanged since the ask")
            yield* writeFiles(home.cwd, { "why.md": `${WHY}It reads the same file each visit.\n` })
            const admitted = yield* tryAnswer(client, first.owner, first.ask, "redo", "rewritten")
            expect(admitted?.failed).toBe(false)
            yield* waitForEnd(client, first.owner)
          }),
        )
        const steps = yield* home.sql(stepsOf(first.run))
        expect(steps.filter((step) => step._tag === "Moved").at(-1)).toMatchObject({
          from: "decide",
          to: "done",
          by: "answer",
          met: true,
        })
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
    65_000,
  )

  it.live("an ask that owes its file but kept no record of it refuses the guarded answer", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(againWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, REQUIRES, "requires", { dir: home.cwd })
      const ask = yield* askDetails(client, owner, 1)
      expect(ask.requires?.choices).toEqual(["redo"])
      yield* home.sql(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`UPDATE machine_runs
            SET pending_json = json_remove(pending_json, '$.requires') WHERE run = ${run}`,
        ),
      )
      yield* writeFiles(home.cwd, { "why.md": WHY })
      const refused = yield* tryAnswer(client, owner, ask, "redo", "unrecorded")
      expect(refused?.failed).toBe(true)
      expect(encodeJson(refused?.result)).toContain(
        `ask ${ask.askId} kept no record of it at its dispatch`,
      )
      // A choice the requirement does not guard is still admitted.
      yield* answerAsk(client, owner, 1, "go")
      yield* waitForEnd(client, owner)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

// ── waits for the account ───────────────────────────────────────────────────

const HOUR = 3_600_000

const work = CredentialSlot.make("work")

/**
 * One account, `work`, that every turn of the test's sessions spends from.
 * The owner's own turn reports the readings that refuse the rounds, and
 * goes on past them on extra usage; a round's lane does not read it.
 */
const oneAccount = {
  configServiceLayer: ConfigService.Test(
    new UserConfig({
      model: TEST_MODEL_ID,
      providers: { anthropic: { authOrder: [work], extraUsage: true } },
    }),
  ),
}

/** A 5-hour window that refuses every run until `resetAt`. */
const rejectedUntil = (resetAt: number): ReadonlyArray<QuotaReading> => [
  { window: "5h", utilization: 1, resetAt, rejected: true },
]

/** The owner's next model call reports the readings set, on the account it spends from. */
const quotaOwner = (readings: Ref.Ref<ReadonlyArray<QuotaReading>>) => () =>
  Effect.flatMap(Ref.getAndSet(readings, []), reportProviderQuota)

/** The sessions whose loops are open now: a waiting run's host is not among them. */
const LoopsProbe = defineRequests(ExtensionId.make("machines-loops-probe"), {
  Loops: request({
    id: "loops",
    description: "The sessions whose loops are open now.",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: Schema.Array(Schema.String),
    execute: () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        const loops = yield* ctx.Session.listActiveLoops
        return loops.map((loop) => String(loop.sessionId))
      }),
  }),
})

const loopsProbe = defineExtension({
  id: "machines-loops-probe",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", LoopsProbe.Loops)
  }),
})

/** The open loops, read from `observer`'s session so the read opens no other loop. */
const openLoops = (client: Client, observer: SessionKey) =>
  Effect.gen(function* () {
    const probe = ref(LoopsProbe.Loops)
    const reply = yield* client.extension.request({
      ...observer,
      extensionId: probe.extensionId,
      capabilityId: probe.capabilityId,
      input: {},
    })
    return yield* decodeRequestReply(Schema.Array(Schema.String))(reply)
  })

/** One round that moves on unconditionally, with a cap of one visit. */
const ONE_VISIT = {
  name: "one-visit",
  threads: { worker: {} },
  start: "work",
  states: {
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}",
      next: "done",
      maxVisits: 1,
    },
    done: { kind: "final" },
  },
}

/** One judged round, with a cap of one visit. */
const ONE_JUDGE = {
  name: "one-judge",
  threads: { judge: {} },
  start: "judge",
  states: {
    judge: {
      kind: "thread",
      thread: "judge",
      say: "STATE judge {{visit}}",
      on: { pass: "done", fail: "done" },
      maxVisits: 1,
    },
    done: { kind: "final" },
  },
}

/** One command that passes. */
const ONE_COMMAND = {
  name: "one-command",
  threads: {},
  start: "check",
  states: {
    check: { kind: "run", run: "true", on: { pass: "done", fail: "done" } },
    done: { kind: "final" },
  },
}

/** The real clock, beside the `TestClock` the runs wait on. */
const wallClock = Clock.Clock.defaultValue()

/** Lets work the virtual clock released settle, so a check that nothing ran means it. */
// oxlint-disable-next-line effect/noFixedWaitInTests -- an absence has no event to wait on; the pause is for real database I/O
const settle = Effect.sleep("300 millis").pipe(Effect.provideService(Clock.Clock, wallClock))

/** `call` on a virtual clock: the starter's turn is polled on the wall clock. */
const callOn = (
  client: Client,
  place: SessionKey,
  calls: ReadonlyArray<readonly [tool: string, id: string, input: Schema.Json]>,
) =>
  Effect.gen(function* () {
    const sent = yield* sendCalls(client, place, calls)
    return sent.results(
      yield* waitFor(client.session.getSnapshot(place), sent.ran, 10_000, sent.label),
    )
  })

const startRunOn = (
  client: Client,
  owner: SessionKey,
  definition: Schema.Json,
  machine: string,
  /** Names this start's tool calls: a session holds each call id once. */
  tag = machine,
  /** As machine.start reads none. */
  input: Schema.Json = {},
) =>
  Effect.gen(function* () {
    const [defined] = yield* callOn(client, owner, [
      ["machine.define", `define-${tag}`, { definition }],
    ])
    expect(defined?.failed).toBe(false)
    const [started] = yield* callOn(client, owner, [
      ["machine.start", `start-${tag}`, { machine, input }],
    ])
    expect(started?.failed).toBe(false)
    return decodeStartedRun(started?.result).run
  })

const decodePendingWait = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ key: Schema.String, notBefore: Schema.optionalKey(Schema.Finite) }),
  ),
)

/** The time the run's pending round waits until, if it waits. */
const pendingWait = (run: string) =>
  Effect.map(runRow(run), (row) =>
    Option.flatMap(
      Option.flatMap(row, (found) => Option.fromNullishOr(found.pending_json)),
      (json) => Option.fromUndefinedOr(decodePendingWait(json).notBefore),
    ),
  )

const decodeRunId = Schema.decodeUnknownSync(AnswerParams.fields.run)

/** The run as the store reads it: its row, and the fold of its steps. */
const storedRun = (run: string) =>
  Effect.flatMap(MachineStore, (store) => store.read(decodeRunId(run))).pipe(
    Effect.map(Option.getOrThrow),
    Effect.provide(MachineStore.Live),
  )

/** How often the run entered each state. */
const visitCounts = (run: string) => Effect.map(storedRun(run), (found) => found.visits.counts)

const waitsOf = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.flatMap((step) => {
    if (step._tag !== "Waiting") return []
    return [{ reason: step.reason, until: step.until }]
  })

/** The run's end was told to its owner. */
const isSettled = (row: Option.Option<typeof RunRowView.Type>) =>
  Option.exists(row, (found) => Predicate.isNotNull(found.notified_at))

const decodeRoundRetries = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ thread: Schema.String, retry_at: Schema.NullOr(Schema.Finite) })),
)
/** Each thread round's thread and its usage limit's reset, oldest first. */
const roundRetries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT thread, retry_at FROM thread_rounds ORDER BY started_at, rowid`
  return decodeRoundRetries(rows)
})

/** Wrap the runtime facade at the registered hooks; the real driver captures it on activation. */
const machinesWithContext = (change: (ctx: ExtensionContextService) => ExtensionContextService) =>
  defineExtension({
    id: MachinesExtension.manifest.id,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* MachinesExtension.setup.pipe(
        Effect.provideService(ExtensionHost, {
          ...host,
          on: (kind, handler) => {
            // The test delivers no clock fire while it orders the arm and stop.
            if (kind === "wakeDue")
              return host.on("wakeDue", () => Effect.succeed(WakeNext.cases.AtStart.make({})))
            return host.on(kind, (input) =>
              handler(input).pipe(Effect.updateService(ExtensionContext, change)),
            )
          },
        }),
      )
    }),
  })

/**
 * The machines extension with its runtime facade changed in every hook,
 * clock fires included: a server that starts with it runs the drivers its
 * runs' records arm on the changed facade.
 */
const machinesUnderFacade = (change: (ctx: ExtensionContextService) => ExtensionContextService) =>
  defineExtension({
    id: MachinesExtension.manifest.id,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* MachinesExtension.setup.pipe(
        Effect.provideService(ExtensionHost, {
          ...host,
          on: (kind, handler) =>
            host.on(kind, (input) =>
              handler(input).pipe(Effect.updateService(ExtensionContext, change)),
            ),
        }),
      )
    }),
  })

/** Stop through the public tool with a durable wake writer whose delivery the test controls. */
const stopWithWakes = (
  home: Effect.Success<typeof restartableHome>,
  owner: SessionKey,
  run: string,
  beforeKick: Effect.Effect<void> = Effect.void,
) => {
  const stub = testToolContext().Session
  // oxlint-disable-next-line effect/noNullish -- the facade's absent-session answer
  const absentSession: Session | undefined = undefined
  const ctx = testToolContext({
    ...owner,
    cwd: home.cwd,
    home: home.home,
    Session: { ...stub, getSession: () => Effect.succeed(absentSession) },
    Wakes: () => ({
      wakeAt: (input) =>
        Effect.gen(function* () {
          if (Predicate.isNotUndefined(input.at)) yield* beforeKick
          yield* home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              yield* sql`INSERT INTO branch_wakes (workspace_id, session_id, branch_id, extension_id, source_id, at, version, attempts, armed_boot, created_at)
            VALUES (${workspaceIdForCwd(home.cwd)}, ${owner.sessionId}, ${owner.branchId}, '@gent/machines', ${input.sourceId}, ${Option.getOrNull(Option.fromUndefinedOr(input.at))}, 1, 0, 0, 0)
            ON CONFLICT (session_id, branch_id, extension_id, source_id) DO UPDATE SET at = COALESCE(excluded.at, branch_wakes.at), version = branch_wakes.version + 1`
            }),
          )
        }).pipe(Effect.orDie),
      cancelWake: () => Effect.succeed(true),
    }),
  })
  return runToolWithCtx(MachineStopTool, { run }, ctx).pipe(
    Effect.provide(
      MachineStore.Live.pipe(
        Layer.provide(BunSqlite.file(`${home.home}/gent.db`)),
        Layer.provide(BunServices.layer),
      ),
    ),
  )
}

describe("a machine waits out its account", () => {
  for (const ordering of ["before", "after"] as const) {
    it.live(
      `a stop committed ${ordering} the wait arm settles without advancing to the quota reset`,
      () =>
        Effect.gen(function* () {
          const home = yield* restartableHome
          const reset = (yield* Clock.currentTimeMillis) + HOUR
          const [owner] = yield* makeHosts(home, 1)
          if (Predicate.isUndefined(owner)) return yield* Effect.die("missing host")
          const run = runIdAt(1)
          yield* plantRuns(home, BUDGET_JSON, [
            { run, host: owner, debt: true, waitsUntil: reset, createdAt: 100, wakeAt: 100 },
          ])
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const intercepted = yield* Ref.make(false)
          const wrapped = machinesWithContext((ctx) => ({
            ...ctx,
            Session: {
              ...ctx.Session,
              wakeAt: (input) =>
                Effect.gen(function* () {
                  const pause = input.at === reset && !(yield* Ref.getAndSet(intercepted, true))
                  if (pause && ordering === "before") {
                    yield* Deferred.succeed(reached, void 0)
                    yield* Deferred.await(release)
                  }
                  yield* ctx.Session.wakeAt(input)
                  if (pause && ordering === "after") {
                    yield* Deferred.succeed(reached, void 0)
                    yield* Deferred.await(release)
                  }
                }),
            },
          }))
          const models = yield* makeModels((round) => Effect.succeed(billed(round.state)))
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              extensionInputs: e2ePreset.extensionInputs.map((extension) => {
                if (extension.manifest.id === wrapped.manifest.id) return wrapped
                return extension
              }),
              providerLayer: machineModels(models),
              storagePath: `${home.home}/gent.db`,
              cwd: home.cwd,
              home: home.home,
            }),
          )
          yield* client.session.getSnapshot(owner)
          yield* Deferred.await(reached)
          // The kick is stored, but not delivered. The virtual clock stays fixed.
          yield* stopWithWakes(home, owner, run)
          expect(yield* home.sql(runRecords(run))).toEqual([
            Option.some(yield* Clock.currentTimeMillis),
          ])
          yield* Deferred.succeed(release, void 0)
          yield* waitFor(
            home.sql(runRow(run)),
            isSettled,
            10_000,
            "the stop settled before the quota reset",
          )
          expect(yield* Ref.get(models.calls)).toEqual([])
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("15 seconds")),
      20_000,
    )
  }

  it.live(
    "retrying an unsettled stop kicks its host again without another stop commit",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const [owner] = yield* makeHosts(home, 1)
        if (Predicate.isUndefined(owner)) return yield* Effect.die("missing host")
        const run = runIdAt(1)
        const reset = (yield* Clock.currentTimeMillis) + HOUR
        yield* plantRuns(home, BUDGET_JSON, [
          { run, host: owner, debt: true, waitsUntil: reset, createdAt: 100, wakeAt: 100 },
        ])
        yield* stopWithWakes(home, owner, run, Effect.interrupt).pipe(Effect.exit)
        const kicks = yield* Ref.make(0)
        yield* stopWithWakes(
          home,
          owner,
          run,
          Ref.update(kicks, (count) => count + 1),
        )
        expect(yield* Ref.get(kicks)).toBe(1)
        expect(
          (yield* home.sql(stepsOf(run))).filter((step) => step._tag === "Stopped"),
        ).toHaveLength(1)
        expect(yield* home.sql(runRecords(run))).toEqual([
          Option.some(yield* Clock.currentTimeMillis),
        ])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("10 seconds")),
    15_000,
  )

  it.live(
    "a stop cut after its commit and before its kick settles at the next boot",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const reset = (yield* Clock.currentTimeMillis) + HOUR
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
            const models = yield* makeModels(
              (round) => Effect.succeed(billed(round.state)),
              quotaOwner(readings),
            )
            const { client } = yield* createRpcClient(
              home.layerFor(machineModels(models), oneAccount),
            )
            const owner = ownerOf(yield* client.session.create({}))
            yield* Ref.set(readings, rejectedUntil(reset))
            const run = yield* startRunOn(client, owner, ONE_VISIT, "one-visit")
            yield* waitFor(
              home.sql(runRecords(run)),
              (records) => Option.contains(records[0] ?? Option.none(), reset),
              10_000,
              "the future wait was armed",
            )
            return { owner, run }
          }),
        )
        const reached = yield* Deferred.make<void>()
        const stop = yield* stopWithWakes(
          home,
          first.owner,
          first.run,
          Deferred.succeed(reached, void 0).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(stop)
        expect(Option.map(yield* home.sql(runRow(first.run)), (row) => row.status)).toEqual(
          Option.some("stopped"),
        )
        expect(yield* home.sql(runRecords(first.run))).toEqual([Option.some(reset)])
        const models = yield* makeModels((round) => Effect.succeed(billed(round.state)))
        yield* createRpcClient(home.layerFor(machineModels(models), oneAccount))
        yield* waitFor(
          home.sql(runRow(first.run)),
          isSettled,
          10_000,
          "the stop settled at boot with no client call",
        )
        expect(yield* Ref.get(models.calls)).toEqual([])
        yield* waitFor(
          home.sql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              return yield* sql`SELECT source_id FROM branch_wakes WHERE source_id IN (${`machine-run:${first.run}`}, ${`machine-stop:${first.run}`})`
            }),
          ),
          (records) => records.length === 0,
          10_000,
          "both records were withdrawn",
        )
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("15 seconds")),
    20_000,
  )

  it.live(
    "a round with no lane waits for the reset, a second refusal moves its time, and no visit is spent",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
        const models = yield* makeModels(
          (round) => Effect.succeed(billed(`${round.state} ${round.visit} done`)),
          quotaOwner(readings),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), { ...oneAccount, extensionInputs: [loopsProbe] }),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const observer = ownerOf(yield* client.session.create({}))
        const now = yield* Clock.currentTimeMillis
        const firstReset = now + HOUR
        yield* Ref.set(readings, rejectedUntil(firstReset))
        const run = yield* startRunOn(client, owner, ONE_VISIT, "one-visit")
        // The refusal is a wait: the pending round names the reset, and so does the run's record.
        yield* waitFor(
          home.sql(pendingWait(run)),
          (until) => Option.contains(until, firstReset),
          10_000,
          "the round waits for the reset",
        )
        yield* waitFor(
          home.sql(runRecords(run)),
          (records) =>
            records.length === 1 && Option.contains(records[0] ?? Option.none(), firstReset),
          10_000,
          "the run's record fires at the reset",
        )
        // A minute short of the reset, nothing ran, and the run held its host open for nothing.
        yield* TestClock.adjust(HOUR - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        expect(yield* openLoops(client, observer)).not.toContain(String(owner.sessionId))
        // A new reading moves the reset an hour on.
        const secondReset = now + 2 * HOUR
        yield* Ref.set(readings, rejectedUntil(secondReset))
        yield* callOn(client, owner, [["machine.list", "list-waiting", {}]])
        // At the first reset the same round is refused again: its time moves, and it enters nothing.
        yield* advanceUntil(home.sql(stepsOf(run)), (steps) => waitsOf(steps).length === 2, {
          label: "the second refusal",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        expect(yield* home.sql(pendingWait(run))).toEqual(Option.some(secondReset))
        expect(yield* Ref.get(models.calls)).toEqual([])
        yield* TestClock.adjust(secondReset - (yield* Clock.currentTimeMillis) - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        // At the second reset the round runs once, and a cap of one visit still moves on.
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length > 0, {
          label: "the round ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(waitsOf(steps)).toEqual([
          { reason: "lane", until: firstReset },
          { reason: "lane", until: secondReset },
        ])
        expect(moves(steps)).toEqual(["work→done"])
        expect(yield* home.sql(visitCounts(run))).toEqual({ work: 1, done: 1 })
        expect(yield* Ref.get(models.calls)).toEqual(["work:1"])
        expect(Option.map(yield* home.sql(runRow(run)), (row) => row.status)).toEqual(
          Option.some("final"),
        )
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )

  it.live(
    "a round in the owner's Sabbath waits for its end as a sabbath wait, then runs with no visit spent",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        // On the equator in UTC the sun sets near 18:00: the Sabbath runs from
        // Friday 1970-01-02 near 18:00 to Saturday near 18:30.
        const restful = {
          configServiceLayer: ConfigService.Test(
            new UserConfig({
              model: TEST_MODEL_ID,
              providers: { anthropic: { authOrder: [work], extraUsage: true } },
              sabbath: { latitude: 0, longitude: 0, timeZone: "UTC" },
            }),
          ),
        }
        yield* TestClock.setTime(Date.parse("1970-01-02T20:00:00Z"))
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models), restful))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, ONE_VISIT, "one-visit")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the round waits for the Sabbath's end",
        )
        const until = waitsOf(steps)[0]?.until ?? 0
        expect(waitsOf(steps)).toEqual([{ reason: "sabbath", until }])
        expect(until).toBeGreaterThan(Date.parse("1970-01-03T18:15:00Z"))
        expect(until).toBeLessThan(Date.parse("1970-01-03T18:50:00Z"))
        // A minute short of the end, nothing ran.
        yield* TestClock.adjust(until - (yield* Clock.currentTimeMillis) - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length > 0, {
          label: "the round ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual(["work→done"])
        expect(yield* home.sql(visitCounts(run))).toEqual({ work: 1, done: 1 })
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a worker that dies at a usage limit waits for its reset, then runs fresh with its retry and visit unspent",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const rounds = yield* Ref.make(0)
        const models = yield* makeModels((round) =>
          Effect.gen(function* () {
            if (acted(round.prompt)) return billed("replied")
            const count = yield* Ref.updateAndGet(rounds, (value) => value + 1)
            // The first worker dies at the limit, the rerun gives no verdict, its retry passes.
            if (count === 1) return usageLimited()
            if (count === 2) return billed("no verdict")
            return replyWith(round, { next: "pass" })
          }),
        )
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, ONE_JUDGE, "one-judge")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the round waits for the limit's reset",
        )
        const until = waitsOf(steps)[0]?.until ?? 0
        expect(waitsOf(steps)).toEqual([{ reason: "quota", until }])
        // The limit resets 60 s after the worker's call; the round kept it.
        expect((yield* home.sql(roundRetries)).map((row) => row.retry_at)).toEqual([until])
        yield* TestClock.adjust(until - (yield* Clock.currentTimeMillis) - 10_000)
        yield* settle
        expect(yield* Ref.get(rounds)).toBe(1)
        yield* advanceUntil(Ref.get(rounds), (count) => count >= 2, {
          label: "the rerun ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const ended = yield* home.sql(stepsOf(run))
        expect(moves(ended)).toEqual(["judge→done"])
        expect(ended.filter((step) => step._tag === "RoundEnded").map((step) => step.dead)).toEqual(
          [true, true, false],
        )
        expect(yield* home.sql(visitCounts(run))).toEqual({ judge: 1, done: 1 })
        // Three workers: the one the limit stopped, its rerun, and the rerun's retry.
        const threads = (yield* home.sql(roundRetries)).map((row) => row.thread)
        expect(new Set(threads).size).toBe(3)
        expect(yield* Ref.get(models.calls)).toEqual(["judge:1", "judge:1", "judge:1"])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )

  it.live(
    "a worker running at sunset stops before its next request, waits for the Sabbath's end, then runs fresh with its visit unspent",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        // On the equator in UTC the sun sets near 18:07 on Friday 1970-01-02.
        yield* TestClock.setTime(Date.parse("1970-01-02T18:00:00Z"))
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* Ref.make(true)
        // The first worker's first step waits while the test moves past
        // sunset, then calls a tool; every later call answers. A new day's
        // date note may follow a tool result, so a reply is read off the
        // thread's tool results, not off the last message.
        const models = yield* makeModels((round) =>
          Effect.gen(function* () {
            if (round.prompt.content.some((message) => message.role === "tool"))
              return billed("replied")
            if (yield* Ref.getAndSet(first, false)) {
              yield* Deferred.succeed(entered, void 0)
              yield* Deferred.await(release)
              // A verdict: a worker that went on to its next step would end the run here.
              return toolCalls([
                { tool: "thread.reply", id: "reply-sunset", input: { value: { next: "pass" } } },
              ])
            }
            return replyWith(round, { next: "pass" })
          }),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), {
            configServiceLayer: ConfigService.Test(
              new UserConfig({
                model: TEST_MODEL_ID,
                providers: { anthropic: { authOrder: [work], extraUsage: true } },
                sabbath: { latitude: 0, longitude: 0, timeZone: "UTC" },
              }),
            ),
          }),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, ONE_JUDGE, "one-judge")
        yield* Deferred.await(entered)
        yield* TestClock.setTime(Date.parse("1970-01-02T18:10:00Z"))
        yield* Deferred.succeed(release, void 0)
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the round waits for the Sabbath's end",
        )
        const until = waitsOf(steps)[0]?.until ?? 0
        expect(waitsOf(steps)).toEqual([{ reason: "sabbath", until }])
        expect(until).toBeGreaterThan(Date.parse("1970-01-03T18:15:00Z"))
        expect(until).toBeLessThan(Date.parse("1970-01-03T18:50:00Z"))
        // The stopped worker sent its one request; nothing ran in the Sabbath.
        expect(yield* Ref.get(models.calls)).toEqual(["judge:1"])
        yield* TestClock.adjust(until - (yield* Clock.currentTimeMillis) - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual(["judge:1"])
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length >= 2, {
          label: "the rerun ran at the Sabbath's end",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual(["judge→done"])
        expect(yield* home.sql(visitCounts(run))).toEqual({ judge: 1, done: 1 })
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a worker turn a restart cut before sunset stops before its request when it resumes in the Sabbath",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        // On the equator in UTC the sun sets near 18:07 on Friday 1970-01-02.
        yield* TestClock.setTime(Date.parse("1970-01-02T18:00:00Z"))
        const config = ConfigService.Test(
          new UserConfig({
            model: TEST_MODEL_ID,
            providers: { anthropic: { authOrder: [work], extraUsage: true } },
            sabbath: { latitude: 0, longitude: 0, timeZone: "UTC" },
          }),
        )
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        // The first root: the worker's turn, on its admitted lane, hangs in
        // its first request until the root stops.
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>()
            const models = yield* makeModels(() =>
              Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never)),
            )
            const { client } = yield* createRpcClient(
              home.layerFor(machineModels({ ...models, calls }), { configServiceLayer: config }),
            )
            const owner = ownerOf(yield* client.session.create({}))
            const started = yield* startRunOn(client, owner, ONE_JUDGE, "one-judge")
            yield* Deferred.await(entered)
            return started
          }),
        )
        yield* TestClock.setTime(Date.parse("1970-01-02T18:10:00Z"))
        // The second root resumes the cut turn in the Sabbath, on no grant.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const models = yield* makeModels((round) =>
              Effect.succeed(replyWith(round, { next: "pass" })),
            )
            yield* createRpcClient(
              home.layerFor(machineModels({ ...models, calls }), { configServiceLayer: config }),
            )
            const steps = yield* waitFor(
              home.sql(stepsOf(run)),
              (found) => waitsOf(found).length === 1,
              20_000,
              "the round waits for the Sabbath's end",
            )
            expect(waitsOf(steps).map((wait) => wait.reason)).toEqual(["sabbath"])
          }),
        )
        // The cut request ran once; the resumed turn sent none in the Sabbath.
        expect(yield* Ref.get(calls)).toEqual(["judge:1"])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("60 seconds")),
    65_000,
  )

  it.live(
    "a worker whose step fills its only account stops before its next request and waits for the window's reset",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const reset = (yield* Clock.currentTimeMillis) + HOUR
        const filled = yield* Ref.make(false)
        // The first worker's tool step fills the window; every later call has room.
        const models = yield* makeModels((round) =>
          Effect.gen(function* () {
            if (acted(round.prompt)) return billed("replied")
            if (!(yield* Ref.getAndSet(filled, true))) {
              yield* reportProviderQuota(rejectedUntil(reset))
              return toolCalls([{ tool: "thread.reply", id: "reply-filled", input: { value: {} } }])
            }
            return replyWith(round, { next: "pass" })
          }),
        )
        // The account has no extra usage: the worker stops at the full window.
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), {
            configServiceLayer: ConfigService.Test(
              new UserConfig({
                model: TEST_MODEL_ID,
                providers: { anthropic: { authOrder: [work] } },
              }),
            ),
          }),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, ONE_JUDGE, "one-judge")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the round waits for the window's reset",
        )
        expect(waitsOf(steps)).toEqual([{ reason: "quota", until: reset }])
        yield* TestClock.adjust(reset - (yield* Clock.currentTimeMillis) - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual(["judge:1"])
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length >= 2, {
          label: "the rerun ran at the reset",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual(["judge→done"])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )

  it.live("a command runs beside four rounds that wait for the account", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
      const worker = (round: RoundCall) =>
        Effect.succeed(billed(`${round.state} ${round.visit} done`))
      const reset = (yield* Clock.currentTimeMillis) + HOUR
      // As many waiting rounds as the server runs commands at once: a command still runs beside them.
      const tags = ["wait-1", "wait-2", "wait-3", "wait-4"]
      const models = yield* makeModels(worker, quotaOwner(readings))
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models), oneAccount))
      const owner = ownerOf(yield* client.session.create({}))
      yield* Ref.set(readings, rejectedUntil(reset))
      const runs = yield* Effect.forEach(tags, (tag) =>
        startRunOn(client, owner, ONE_VISIT, "one-visit", tag),
      )
      yield* Effect.forEach(runs, (run) =>
        waitFor(
          home.sql(pendingWait(run)),
          (until) => Option.contains(until, reset),
          10_000,
          `${run} waits for the reset`,
        ),
      )
      const command = yield* startRunOn(client, owner, ONE_COMMAND, "one-command")
      yield* waitFor(home.sql(runRow(command)), isSettled, 10_000, "the command ran beside them")
      expect(yield* Ref.get(models.calls)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )

  it.live("a run that waits for its account across a restart keeps its time", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
      const worker = (round: RoundCall) =>
        Effect.succeed(billed(`${round.state} ${round.visit} done`))
      const now = yield* Clock.currentTimeMillis
      const reset = now + HOUR
      const run = yield* Effect.scoped(
        Effect.gen(function* () {
          const models = yield* makeModels(worker, quotaOwner(readings))
          const { client } = yield* createRpcClient(
            home.layerFor(machineModels(models), oneAccount),
          )
          const owner = ownerOf(yield* client.session.create({}))
          yield* Ref.set(readings, rejectedUntil(reset))
          const started = yield* startRunOn(client, owner, ONE_VISIT, "one-visit")
          yield* waitFor(
            home.sql(runRecords(started)),
            (records) => Option.contains(records[0] ?? Option.none(), reset),
            10_000,
            "the run's record fires at the reset",
          )
          return started
        }),
      )
      // The next server opens no session: the record alone brings the run back at its time.
      const models = yield* makeModels(worker)
      yield* createRpcClient(home.layerFor(machineModels(models), oneAccount))
      yield* TestClock.adjust(HOUR - 60_000)
      yield* settle
      expect(yield* Ref.get(models.calls)).toEqual([])
      expect(yield* home.sql(pendingWait(run))).toEqual(Option.some(reset))
      yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length > 0, {
        label: "the round ran",
        step: "5 seconds",
        timeoutMs: 10_000,
      })
      yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
      expect(moves(yield* home.sql(stepsOf(run)))).toEqual(["work→done"])
      expect(yield* Ref.get(models.calls)).toEqual(["work:1"])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )
})

// ── C7: the boot budget ─────────────────────────────────────────────────────

/** A worker gated by `gate` that counts its open model calls, and keeps the most at once. */
const gatedWorker =
  (
    gate: Deferred.Deferred<boolean>,
    open: Ref.Ref<number>,
    most: Ref.Ref<number>,
    order: Ref.Ref<ReadonlyArray<string>>,
  ) =>
  (round: RoundCall): Effect.Effect<WorkerStream> =>
    Effect.gen(function* () {
      const now = yield* Ref.updateAndGet(open, (count) => count + 1)
      yield* Ref.update(most, (count) => Math.max(count, now))
      yield* Ref.update(order, (all) => [...all, round.mode])
      yield* Deferred.await(gate)
      yield* Ref.update(open, (count) => count - 1)
      return billed(`${round.state} ${round.visit} done`)
    })

/** The pending `Round` a server leaves once it entered a thread state and sent nothing. */
const PlantedRound = Schema.TaggedStruct("Round", {
  state: Schema.String,
  visit: Schema.Int,
  key: Schema.String,
  attempt: Schema.Int,
})

/** The steps a server writes as a run starts, and as it enters a thread state. */
const PlantedStarted = Schema.TaggedStruct("Started", {
  machine: Schema.String,
  input: Schema.Json,
})
const PlantedDispatched = Schema.TaggedStruct("Dispatched", { action: Schema.Json })
const PlantedSaved = Schema.TaggedStruct("Saved", { state: Schema.String, value: Schema.Json })

interface PlantedRun {
  readonly run: string
  readonly host: SessionKey
  /** A `Round` left open by the last server, with no round sent. */
  readonly debt: boolean
  /** The debt round waits for its account until then, and its record fires then. */
  readonly waitsUntil?: number
  readonly createdAt: number
  readonly wakeAt: number
}

/** Runs left by SQL as a server that stopped leaves them, each with its start-only record. */
const plantRuns = (
  home: Effect.Success<typeof restartableHome>,
  definitionJson: string,
  runs: ReadonlyArray<PlantedRun>,
) =>
  home.sql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const workspace = workspaceIdForCwd(home.cwd)
      for (const planted of runs) {
        const input = { tag: planted.run }
        // A debt run entered `work` and recorded its round's key, and sent nothing.
        let pending = Option.none<string>()
        const steps = [
          { state: "start", json: encodeJson(PlantedStarted.make({ machine: "budget", input })) },
        ]
        if (planted.debt) {
          const round = {
            ...PlantedRound.make({
              state: "work",
              visit: 1,
              key: `machine:${planted.run}:2`,
              attempt: 1,
            }),
            ...omitUndefined({ notBefore: planted.waitsUntil }),
          }
          pending = Option.some(encodeJson(round))
          steps.push({ state: "work", json: encodeJson(PlantedDispatched.make({ action: round })) })
        }
        yield* sql`INSERT INTO machine_runs (
            run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
            cwd, input_json, roles_json, state, status, pending_json, seq, created_at, updated_at
          ) VALUES (
            ${planted.run}, 'budget', ${definitionJson}, ${planted.host.sessionId},
            ${planted.host.branchId}, ${planted.host.sessionId}, ${home.cwd},
            ${encodeJson(input)}, '{}', 'work', 'running',
            ${Option.getOrNull(pending)}, ${steps.length}, ${planted.createdAt}, ${planted.createdAt}
          )`
        for (const [index, step] of steps.entries()) {
          yield* sql`INSERT INTO machine_steps (run, seq, at, state, step_json)
            VALUES (${planted.run}, ${index + 1}, ${planted.createdAt}, ${step.state}, ${step.json})`
        }
        yield* sql`INSERT INTO branch_wakes (
            workspace_id, session_id, branch_id, extension_id, source_id, at, version, attempts,
            armed_boot, created_at
          ) VALUES (
            ${workspace}, ${planted.host.sessionId}, ${planted.host.branchId}, '@gent/machines',
            ${`machine-run:${planted.run}`}, ${Option.getOrNull(Option.fromUndefinedOr(planted.waitsUntil))}, 1, 0, 0, ${planted.wakeAt}
          )`
      }
    }),
  )

const runIdAt = (index: number) => `run-${index.toString(16).padStart(16, "0")}`

describe("a run read while another server commits", () => {
  it.live("folds only the steps its row names, never a later commit's", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const [host] = yield* makeHosts(home, 1)
      if (Predicate.isUndefined(host)) return yield* Effect.die("missing host")
      const run = runIdAt(1)
      yield* plantRuns(home, BUDGET_JSON, [{ run, host, debt: true, createdAt: 0, wakeAt: 0 }])
      // As a commit lands between the read of the row (seq 2) and of its steps.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const later = [
            PlantedSaved.make({ state: "work", value: "later" }),
            PlantedDispatched.make({
              action: PlantedRound.make({ state: "work", visit: 2, key: "later", attempt: 1 }),
            }),
          ]
          for (const [index, step] of later.entries()) {
            yield* sql`INSERT INTO machine_steps (run, seq, at, state, step_json)
              VALUES (${run}, ${index + 3}, 0, 'work', ${encodeJson(step)})`
          }
        }),
      )
      const stored = yield* home.sql(storedRun(run))
      expect(stored.seq).toBe(2)
      expect(stored.visits.counts).toEqual({ work: 1 })
      expect(stored.context).toEqual({ last: {}, all: {} })
    }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
  )
})

/** Hosts for `count` runs, made by a first root that runs no machine. */
const makeHosts = (home: Effect.Success<typeof restartableHome>, count: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      return yield* Effect.forEach(Array.from({ length: count }), () =>
        Effect.map(client.session.create({}), ownerOf),
      )
    }),
  )

const BUDGET_JSON = encodeJson(BUDGET)

const allAsking = (runs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT run FROM machine_runs WHERE status = 'asking'`
    return rows.length >= runs.length
  })

/**
 * Boots a root over planted runs with the worker gated, and waits until
 * `opens` model calls are open. Then `check` reads the order the rounds
 * opened in, the gate opens, and every run reaches its ask. Answers the most
 * calls open at once.
 */
const bootGated = (
  home: Effect.Success<typeof restartableHome>,
  runs: ReadonlyArray<PlantedRun>,
  opens: number,
  check: (order: ReadonlyArray<string>) => void,
) =>
  Effect.gen(function* () {
    yield* plantRuns(home, BUDGET_JSON, runs)
    const gate = yield* Deferred.make<boolean>()
    const open = yield* Ref.make(0)
    const most = yield* Ref.make(0)
    const order = yield* Ref.make<ReadonlyArray<string>>([])
    const models = yield* makeModels(gatedWorker(gate, open, most, order))
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRpcClient(home.layerFor(machineModels(models)))
        yield* waitFor(Ref.get(open), (count) => count >= opens, 20_000, `${opens} rounds opened`)
        expect(yield* Ref.get(open)).toBe(opens)
        check(yield* Ref.get(order))
        yield* Deferred.succeed(gate, true)
        yield* waitFor(
          home.sql(allAsking(runs.map((planted) => planted.run))),
          Boolean,
          40_000,
          "every run reached its ask",
        )
      }),
    )
    return yield* Ref.get(most)
  })

// ── model roles ─────────────────────────────────────────────────────────────

// The newest model of each family the catalog fixture lists.
const OPUS = ModelId.make("anthropic/claude-opus-5-5")
const HAIKU = ModelId.make("anthropic/claude-haiku-4-5")
const SONNET = ModelId.make("anthropic/claude-sonnet-5-5")
const SOL = ModelId.make("openai/gpt-6.1-sol")
const LUNA = ModelId.make("openai/gpt-6-luna")

/** The catalog family of one of the models above. */
const familyOf = (model: ModelId) => {
  const name = model.slice(model.indexOf("/") + 1)
  if (name.startsWith("gpt-")) return `gpt-${name.slice(name.lastIndexOf("-") + 1)}`
  return name.split("-").slice(0, 2).join("-")
}

/** A role entry: a model at high effort, or a model and its effort. */
type RoleEntry = ModelId | { readonly model: ModelId; readonly effort: "low" | "high" }

/** A role entry as a model and its effort. */
const entryOf = (entry: RoleEntry): Exclude<RoleEntry, ModelId> => {
  if (Predicate.isString(entry)) return { model: entry, effort: "high" }
  return entry
}

/** A config role choice: the newest model of the entry's family on its provider. */
const choiceOf = (entry: RoleEntry) => {
  const { model, effort } = entryOf(entry)
  return { provider: model.slice(0, model.indexOf("/")), family: familyOf(model), effort }
}

/**
 * Config roles from model lists: `strongest` in its order, `efficient` by
 * cost per accepted unit, and any other role in its order.
 */
const rolesOf = (lists: Readonly<Record<string, ReadonlyArray<RoleEntry>>>) =>
  Object.fromEntries(
    Object.entries(lists).flatMap(([role, list]) => {
      const models = list.map(choiceOf)
      if (role === "efficient") return [[role, { models, rank: "cheapest" as const }]]
      return [[role, { models }]]
    }),
  )

/** The `work` account, with the owner's roles, over the catalog's models and prices unless `models` names others. */
const tieredAccount = (
  lists: Parameters<typeof rolesOf>[0],
  models: ReadonlyArray<Model> | "catalog" = "catalog",
) => ({
  configServiceLayer: ConfigService.Test(
    new UserConfig({
      model: TEST_MODEL_ID,
      // As `oneAccount`: the owner's turn goes on past the readings it reports.
      providers: { anthropic: { authOrder: [work], extraUsage: true } },
      roles: rolesOf(lists),
    }),
  ),
  models,
})

/** An Anthropic model at `pricing` per million tokens; zero is a subscription view, which lists no price. */
const anthropicModel = (id: ModelId, pricing: { input: number; output: number }) =>
  Model.make({
    id,
    name: id,
    provider: ProviderId.make("anthropic"),
    family: familyOf(id),
    contextLength: 200_000,
    pricing,
  })

/** `model`'s own 5-hour window, refusing its runs until `resetAt`. */
const modelSpentUntil = (model: ModelId, resetAt: number): QuotaReading => ({
  window: "5h",
  model,
  utilization: 1,
  resetAt,
  rejected: true,
})

/** One strongest round, then an ask: `again` runs the role's next round. */
const STRONG_AGAIN = {
  name: "strong-again",
  threads: { worker: { role: "strongest" } },
  start: "work",
  states: {
    work: { kind: "thread", thread: "worker", say: "STATE work {{visit}}", next: "gate" },
    gate: { kind: "ask", ask: "Again?", on: { again: "work", end: "done" } },
    done: { kind: "final" },
  },
}

/** Three efficient rounds, each on a thread of its own. */
const EFFICIENT_THRICE = {
  name: "efficient-thrice",
  threads: { worker: { role: "efficient" } },
  start: "work",
  states: {
    work: {
      kind: "thread",
      thread: "worker",
      say: "STATE work {{visit}}",
      next: "work",
      fresh: true,
      maxVisits: 3,
      exhausted: "done",
    },
    done: { kind: "final" },
  },
}

/** The run's ended rounds: each one's model and whether it was priced. */
const roundsRan = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.flatMap((step) => {
    if (step._tag !== "RoundEnded") return []
    return [{ model: step.model, priced: Predicate.isNotUndefined(step.costUsd) }]
  })

/** A start, an ended round, a move and a finish as the run's log stores them. */
const SeededStarted = Schema.TaggedStruct("Started", {
  machine: Schema.String,
  input: Schema.Json,
  project: Schema.String,
})
const SeededTokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})
const SeededRound = Schema.TaggedStruct("RoundEnded", {
  state: Schema.String,
  round: Schema.String,
  dead: Schema.Boolean,
  model: Schema.String,
  verdict: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  configRole: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  tokens: Schema.optionalKey(SeededTokens),
})
const SeededMove = Schema.TaggedStruct("Moved", {
  from: Schema.String,
  to: Schema.String,
  by: Schema.String,
})
const SeededFinish = Schema.TaggedStruct("Finished", {
  state: Schema.String,
  accepted: Schema.optionalKey(Schema.Boolean),
})
const SeededStep = Schema.Union([SeededStarted, SeededRound, SeededMove, SeededFinish])
const encodeSeededStep = Schema.encodeSync(Schema.fromJsonString(SeededStep))

/** The state a seeded step's row is filed under, as the store files it. */
const seededState = (step: typeof SeededStep.Type): string => {
  if (step._tag === "Moved") return step.to
  if (step._tag === "Started") return "work"
  return step.state
}

/** Steps written into the run's log after its own, as earlier work of its machine left them. */
const seedSteps = (run: string, steps: ReadonlyArray<typeof SeededStep.Type>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const [index, step] of steps.entries()) {
      const seq = 10_000 + index
      yield* sql`INSERT INTO machine_steps (run, seq, at, state, step_json)
        VALUES (${run}, ${seq}, 0, ${seededState(step)}, ${encodeSeededStep(step)})`
    }
  })

/** `run`'s row again as `copy`, with no steps: another run of its machine, of the same owner. */
const copyRun = (run: string, copy: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TEMP TABLE run_copy AS SELECT * FROM machine_runs WHERE run = ${run}`
    yield* sql`UPDATE run_copy SET run = ${copy}`
    yield* sql`INSERT INTO machine_runs SELECT * FROM run_copy`
    yield* sql`DROP TABLE run_copy`
  })

/** One ended run as the efficient rank reads it: its rounds of `work`, by role, and where it worked. */
interface EndedRun {
  readonly rounds: ReadonlyArray<{
    readonly role: string
    readonly configRole?: string
    readonly model: ModelId
    readonly costUsd?: number
    readonly tokens?: typeof SeededTokens.Type
  }>
  /** Default true: the run's final state accepted its work. */
  readonly accepted?: boolean
  /** Default false: the run worked in the source run's project. */
  readonly elsewhere?: boolean
  readonly domain?: string
}

const decodeCwdRows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ cwd: Schema.String })))

/**
 * `runs` as ended runs of `source`'s machine, newest first, every one newer
 * than `source`, whose own steps are dropped so it ranks nothing.
 */
const seedEndedRuns = (source: string, runs: ReadonlyArray<EndedRun>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = decodeCwdRows(yield* sql`SELECT cwd FROM machine_runs WHERE run = ${source}`)
    yield* sql`DELETE FROM machine_steps WHERE run = ${source}`
    for (const [index, run] of runs.entries()) {
      const id = `run-${index.toString(16).padStart(16, "0")}`
      yield* copyRun(source, id)
      yield* sql`UPDATE machine_runs SET status = 'final', updated_at = ${1_000_000_000 - index}
        WHERE run = ${id}`
      let project = row?.cwd ?? ""
      if (run.elsewhere === true) project = "/elsewhere"
      const input = omitUndefined({ domain: run.domain })
      yield* seedSteps(id, [
        SeededStarted.make({ machine: "efficient-once", input, project }),
        ...run.rounds.map((round, at) =>
          SeededRound.make({ state: "work", round: `ended-${at}`, dead: false, ...round }),
        ),
        SeededFinish.make({ state: "done", accepted: run.accepted ?? true }),
      ])
    }
  })

/** One efficient round, then the end. */
const EFFICIENT_ONCE = {
  name: "efficient-once",
  threads: { worker: { role: "efficient" } },
  start: "work",
  states: {
    work: { kind: "thread", thread: "worker", say: "STATE work {{visit}}", next: "done" },
    done: { kind: "final" },
  },
}

/**
 * Runs `efficient-once` to have a run to copy, seeds `runs` as the
 * machine's ended runs, then runs it again: the model its round ran.
 */
const rankedPick = (
  efficient: ReadonlyArray<ModelId>,
  runs: ReadonlyArray<EndedRun>,
  input?: Schema.Json,
) =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const models = yield* makeModels((round) =>
      Effect.succeed(billed(`${round.state} ${round.visit} done`)),
    )
    const { client } = yield* createRpcClient(
      home.layerFor(machineModels(models), tieredAccount({ efficient })),
    )
    const owner = ownerOf(yield* client.session.create({}))
    const source = yield* startRunOn(client, owner, EFFICIENT_ONCE, "efficient-once", "source")
    yield* waitFor(home.sql(runRow(source)), isSettled, 10_000, "the source run's end was told")
    yield* home.sql(seedEndedRuns(source, runs))
    const run = yield* startRunOn(client, owner, EFFICIENT_ONCE, "efficient-once", "ranked", input)
    yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the ranked run's end was told")
    return roundsRan(yield* home.sql(stepsOf(run))).map((round) => round.model)
  })

/** `runs` copies of `run`. */
const times = (count: number, run: EndedRun): ReadonlyArray<EndedRun> =>
  Array.from({ length: count }, () => run)

/** A request of the machines extension, sent as a session of `session`'s thread. */
const machinesRequest = <Input, Output>(
  client: Client,
  session: SessionKey,
  capability: CapabilityRef<Input, Output>,
  input: Input,
) =>
  client.extension
    .request({
      ...session,
      extensionId: capability.extensionId,
      capabilityId: capability.capabilityId,
      input,
    })
    .pipe(Effect.flatMap(decodeRequestReply(capability.output)))

/** The thread each recorded round ran on, in order. */
const roundThreads = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.flatMap((step) => {
    if (step._tag !== "Recorded" || step.action?._tag !== "Round") return []
    return [step.action.thread]
  })

/** The `count`th ask the owner got, read under the test clock. */
const askAt = (client: Client, owner: SessionKey, count: number) =>
  Effect.map(
    waitFor(
      client.session.getSnapshot(owner),
      (current) =>
        current.runtime._tag === "Idle" &&
        ofType(current.messages, MACHINE_ASK_TYPE).length >= count,
      10_000,
      `ask ${count} reached the owner`,
    ),
    (snapshot) =>
      decodeAsk(ofType(snapshot.messages, MACHINE_ASK_TYPE)[count - 1]?.metadata?.details),
  )

/** A model of no maker the catalog names: no canonical id, alone in its family. */
const MYSTERY = ModelId.make("anthropic/claude-mystery-1")

/** Opus and Sol with their makers, the mystery model, and the owner's model. */
const MAKERS = [
  Model.make({ ...anthropicModel(OPUS, { input: 5, output: 25 }), maker: "anthropic" }),
  Model.make({
    id: SOL,
    name: SOL,
    provider: ProviderId.make("openai"),
    family: familyOf(SOL),
    maker: "openai",
    contextLength: 200_000,
    pricing: { input: 2, output: 8 },
  }),
  anthropicModel(MYSTERY, { input: 1, output: 5 }),
  Model.make({ ...anthropicModel(TEST_MODEL_ID, { input: 3, output: 15 }), family: "owner" }),
]

/**
 * A `maker` round, then a round of config role `judge` against it; with
 * `switched`, state `state` switches to that config role on its first visit.
 */
const makerJudge = (name: string, judge = "judge", state?: "make" | "judge", switched?: string) => {
  const switches = (of: string) => {
    if (of !== state || Predicate.isUndefined(switched)) return []
    return [{ role: switched, when: "visit", is: "1" }]
  }
  return {
    name,
    threads: { maker: { role: "maker" }, judge: { role: judge, against: "maker" } },
    start: "make",
    states: {
      make: {
        kind: "thread",
        thread: "maker",
        say: "make",
        next: "judge",
        switches: switches("make"),
      },
      judge: {
        kind: "thread",
        thread: "judge",
        say: "judge",
        next: "done",
        switches: switches("judge"),
      },
      done: { kind: "final" },
    },
  }
}

/** Defines `definition`, then starts it: the start's failure text. */
const refusedStart = (
  client: Client,
  owner: SessionKey,
  definition: { readonly name: string } & Schema.Json,
) =>
  Effect.gen(function* () {
    const [defined] = yield* call(client, owner, [
      ["machine.define", `define-${definition.name}`, { definition }],
    ])
    expect(defined?.failed).toBe(false)
    const [started] = yield* call(client, owner, [
      ["machine.start", `start-${definition.name}`, { machine: definition.name }],
    ])
    expect(started?.failed).toBe(true)
    return encodeJson(started?.result)
  })

const runIds = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT run FROM machine_runs`)

describe("a config role's round", () => {
  it.live("a definition whose roles conflict is refused, each reason named", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const definition = {
        name: "role-conflicts",
        threads: {
          pinned: { model: OPUS, role: "planner" },
          tuned: { effort: "high", role: "planner" },
          lost: { role: "reviewer", against: "nobody" },
          plain: {},
          bare: { role: "reviewer", against: "plain" },
          self: { role: "reviewer", against: "self" },
          loose: { against: "pinned" },
          tiered: { tier: "strongest" },
        },
        start: "work",
        states: {
          work: { kind: "thread", thread: "pinned", say: "go", next: "plainly" },
          plainly: {
            kind: "thread",
            thread: "plain",
            say: "go",
            next: "done",
            switches: [{ role: "planner", when: "nowhere.reply.path", is: "deep" }],
          },
          done: { kind: "final" },
        },
      }
      const [refused] = yield* call(client, owner, [
        ["machine.define", "define-role-conflicts", { definition }],
      ])
      expect(refused?.failed).toBe(true)
      const text = encodeJson(refused?.result)
      expect(text).toContain("pinned: names a model and a role")
      expect(text).toContain("tuned: names an effort and a role")
      expect(text).toContain("lost: is against no thread role nobody")
      expect(text).toContain("bare: is against plain, which names no role")
      expect(text).toContain("self: is against itself")
      expect(text).toContain("loose: names against with no role")
      expect(text).toContain("tiered: names a tier; config roles replaced tiers, so name a role")
      expect(text).toContain("plainly: switches the role of plain, which names no role")
      expect(text).toContain("plainly: a switch's when nowhere.reply.path names no state")
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a start fails when a role is not in the config, or one against another lists one maker",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount({ maker: [HAIKU], judge: [OPUS, SONNET] }),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        expect(yield* refusedStart(client, owner, makerJudge("unnamed", "missing"))).toContain(
          "judge runs the role missing, which config roles does not name",
        )
        expect(yield* refusedStart(client, owner, makerJudge("one-maker"))).toContain(
          "judge is against maker, so its role judge needs listed models of two makers; it has anthropic",
        )
        expect(
          yield* refusedStart(client, owner, makerJudge("switched", "judge", "make", "absent")),
        ).toContain("maker runs the role absent, which config roles does not name")
        expect(yield* home.sql(runIds)).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a start fails when a role resolves one model twice, or is against a role of no known maker",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount(
              { maker: [MYSTERY], known: [OPUS], judge: [OPUS, SOL], twice: [OPUS, OPUS] },
              MAKERS,
            ),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        expect(yield* refusedStart(client, owner, makerJudge("doubled", "twice"))).toContain(
          `judge runs the role twice, which resolves to ${OPUS} twice`,
        )
        expect(yield* refusedStart(client, owner, makerJudge("unknown-maker"))).toContain(
          `judge is against maker, whose role maker runs ${MYSTERY}, of no maker the catalog names`,
        )
        // The maker's own role is known; the switch of its state is not.
        const switched = makerJudge("unknown-switch", "judge", "make", "maker")
        expect(
          yield* refusedStart(client, owner, {
            ...switched,
            threads: { ...switched.threads, maker: { role: "known" } },
          }),
        ).toContain(
          `judge is against maker, whose role maker runs ${MYSTERY}, of no maker the catalog names`,
        )
        expect(yield* home.sql(runIds)).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a role against another runs no choice of no known maker", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels((round) =>
        Effect.succeed(billed(`${round.state} ${round.visit} done`)),
      )
      const { client } = yield* createRpcClient(
        home.layerFor(
          machineModels(models),
          tieredAccount({ maker: [OPUS], judge: [MYSTERY, OPUS, SOL] }, MAKERS),
        ),
      )
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRunOn(client, owner, makerJudge("mystery-judge"), "mystery-judge")
      yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
      // The judge leaves Opus, the maker's, and the model no maker is known for.
      const steps = yield* home.sql(stepsOf(run))
      expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS, SOL])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("20 seconds")),
  )

  it.live(
    "a role against another leaves the maker of that role's last round, run on a rerun's thread",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
        const makes = yield* Ref.make(0)
        const models = yield* makeModels(
          (round) =>
            Effect.gen(function* () {
              if (round.state !== "make") return billed(`${round.state} ${round.visit} done`)
              const count = yield* Ref.updateAndGet(makes, (value) => value + 1)
              // The first maker, on Opus, dies at a usage limit.
              if (count === 1) return usageLimited()
              return billed("made")
            }),
          quotaOwner(readings),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount({ maker: [OPUS, SOL], judge: [SOL, OPUS] }),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const definition = {
          name: "maker-judge",
          threads: { maker: { role: "maker" }, judge: { role: "judge", against: "maker" } },
          start: "make",
          states: {
            make: { kind: "thread", thread: "maker", say: "STATE make {{visit}}", next: "gate" },
            gate: { kind: "ask", ask: "Judge?", on: { go: "judge", end: "done" } },
            judge: { kind: "thread", thread: "judge", say: "STATE judge {{visit}}", next: "done" },
            done: { kind: "final" },
          },
        }
        const run = yield* startRunOn(client, owner, definition, "maker-judge")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the maker waits for the limit's reset",
        )
        const until = waitsOf(steps)[0]?.until ?? 0
        // Opus stays spent past the reset: the rerun runs Sol, on a thread of its own.
        yield* Ref.set(readings, [modelSpentUntil(OPUS, until + HOUR)])
        yield* callOn(client, owner, [["machine.list", "list-spent", {}]])
        yield* advanceUntil(Ref.get(makes), (count) => count >= 2, {
          label: "the maker's rerun ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        const ask = yield* askAt(client, owner, 1)
        // Opus frees; the judge leaves Sol, the maker of the round it judges.
        yield* TestClock.adjust(HOUR + 60_000)
        yield* callOn(client, owner, [
          ["machine.answer", "judge-go", { run, askId: ask.askId, choice: "go" }],
        ])
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const ended = yield* home.sql(stepsOf(run))
        expect(roundsRan(ended).map((round) => round.model)).toEqual([OPUS, SOL, OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "runs the first strongest model with a lane, keeps its thread while that model has one, and moves when it has none",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
        const models = yield* makeModels(
          (round) => Effect.succeed(billed(`${round.state} ${round.visit} done`)),
          quotaOwner(readings),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), tieredAccount({ strongest: [OPUS, SONNET] })),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const now = yield* Clock.currentTimeMillis
        // Opus has no lane for an hour: the first round runs Sonnet.
        yield* Ref.set(readings, [modelSpentUntil(OPUS, now + HOUR)])
        const run = yield* startRunOn(client, owner, STRONG_AGAIN, "strong-again")
        const first = yield* askAt(client, owner, 1)
        // Opus frees; the role's thread runs Sonnet, which still has a lane: it stays there.
        yield* TestClock.adjust(HOUR + 60_000)
        yield* callOn(client, owner, [
          ["machine.answer", "again-1", { run, askId: first.askId, choice: "again" }],
        ])
        const second = yield* askAt(client, owner, 2)
        // Sonnet has no lane now: the role moves to Opus, on a new thread.
        yield* Ref.set(readings, [modelSpentUntil(SONNET, (yield* Clock.currentTimeMillis) + HOUR)])
        yield* callOn(client, owner, [
          ["machine.answer", "again-2", { run, askId: second.askId, choice: "again" }],
        ])
        const third = yield* askAt(client, owner, 3)
        yield* callOn(client, owner, [
          ["machine.answer", "end-3", { run, askId: third.askId, choice: "end" }],
        ])
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(roundsRan(steps)).toEqual([
          { model: SONNET, priced: true },
          { model: SONNET, priced: true },
          { model: OPUS, priced: true },
        ])
        const [t1, t2, t3] = roundThreads(steps)
        expect(t1).toBe(t2)
        expect(t3).not.toBe(t1)
        expect(waitsOf(steps)).toEqual([])
        // Each thread runs at its choice's effort.
        for (const thread of [t1, t3]) {
          if (Predicate.isUndefined(thread)) continue
          const view = yield* client.session.get({ sessionId: SessionId.make(thread) })
          expect(view?.reasoningLevel).toBe("high")
        }
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a state's switch runs another role on the visit it names, and a thread at another effort is not kept",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount({
              steady: [OPUS],
              quick: [{ model: OPUS, effort: "low" }],
              other: [HAIKU],
            }),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const definition = {
          name: "effort-switch",
          threads: { worker: { role: "steady" } },
          start: "work",
          states: {
            work: {
              kind: "thread",
              thread: "worker",
              say: "STATE work {{visit}}",
              next: "work",
              maxVisits: 3,
              exhausted: "done",
              // Both hold on visit 2: the first wins.
              switches: [
                { role: "quick", when: "visit", is: "2" },
                { role: "other", when: "visit", is: "2" },
              ],
            },
            done: { kind: "final" },
          },
        }
        const run = yield* startRunOn(client, owner, definition, "effort-switch")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS, OPUS, OPUS])
        // Opus at high, then at low on a new thread, then at high on a new one again.
        const threads = roundThreads(steps)
        expect(new Set(threads).size).toBe(3)
        const efforts: Array<string> = []
        for (const thread of threads) {
          if (Predicate.isUndefined(thread)) continue
          const view = yield* client.session.get({ sessionId: SessionId.make(thread) })
          efforts.push(view?.reasoningLevel ?? "none")
        }
        expect(efforts).toEqual(["high", "low", "high"])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("20 seconds")),
  )

  it.live(
    "waits for the first of its tier to free when none has a lane, and starts nothing",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
        const models = yield* makeModels(
          (round) => Effect.succeed(billed(`${round.state} ${round.visit} done`)),
          quotaOwner(readings),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount({ strongest: [OPUS, SONNET], efficient: [HAIKU] }),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const now = yield* Clock.currentTimeMillis
        // Both strongest models are spent; the efficient one is free and is never a fallback.
        yield* Ref.set(readings, [
          modelSpentUntil(OPUS, now + 2 * HOUR),
          modelSpentUntil(SONNET, now + HOUR),
        ])
        const run = yield* startRunOn(client, owner, STRONG_AGAIN, "strong-again")
        yield* waitFor(
          home.sql(pendingWait(run)),
          (until) => Option.contains(until, now + HOUR),
          10_000,
          "the round waits for the first model to free",
        )
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        expect(roundThreads(yield* home.sql(stepsOf(run)))).toEqual([])
        // No thread session was made for a model the round cannot run.
        expect((yield* client.session.list()).map((session) => session.id)).toEqual([
          owner.sessionId,
        ])
        // A minute before Sonnet frees, nothing has run; small steps then reach its reset.
        yield* TestClock.adjust(HOUR - 60_000)
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length > 0, {
          label: "the round ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* askAt(client, owner, 1)
        const steps = yield* home.sql(stepsOf(run))
        expect(waitsOf(steps)).toEqual([{ reason: "lane", until: now + HOUR }])
        expect(roundsRan(steps)).toEqual([{ model: SONNET, priced: true }])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a tier round in the owner's Sabbath waits for its end as a sabbath wait, and starts nothing",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        // On the equator in UTC: the Sabbath runs from Friday near 18:00 to Saturday near 18:30.
        const restful = {
          configServiceLayer: ConfigService.Test(
            new UserConfig({
              model: TEST_MODEL_ID,
              providers: { anthropic: { authOrder: [work], extraUsage: true } },
              roles: rolesOf({ strongest: [OPUS, SONNET] }),
              sabbath: { latitude: 0, longitude: 0, timeZone: "UTC" },
            }),
          ),
          models: "catalog" as const,
        }
        yield* TestClock.setTime(Date.parse("1970-01-02T20:00:00Z"))
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models), restful))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, STRONG_AGAIN, "strong-again")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (found) => waitsOf(found).length === 1,
          10_000,
          "the round waits for the Sabbath's end",
        )
        const until = waitsOf(steps)[0]?.until ?? 0
        // Every model of the tier is refused alike: the wait names the Sabbath.
        expect(waitsOf(steps)).toEqual([{ reason: "sabbath", until }])
        expect(until).toBeGreaterThan(Date.parse("1970-01-03T18:15:00Z"))
        expect(until).toBeLessThan(Date.parse("1970-01-03T18:50:00Z"))
        yield* settle
        expect(yield* Ref.get(models.calls)).toEqual([])
        // No thread session was made for a round the Sabbath holds.
        expect((yield* client.session.list()).map((session) => session.id)).toEqual([
          owner.sessionId,
        ])
        yield* TestClock.adjust(until - (yield* Clock.currentTimeMillis) - 60_000)
        yield* advanceUntil(Ref.get(models.calls), (calls) => calls.length > 0, {
          label: "the round ran",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        // The round's end is in the steps once its ask is.
        yield* askAt(client, owner, 1)
        expect(roundsRan(yield* home.sql(stepsOf(run)))).toEqual([{ model: OPUS, priced: true }])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "runs each efficient model's first run on it, then the one whose runs cost least, and keeps what the rank reads",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), tieredAccount({ efficient: [OPUS, HAIKU] })),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const picks: Array<string> = []
        for (const tag of ["first", "second", "third"]) {
          const run = yield* startRunOn(client, owner, EFFICIENT_ONCE, "efficient-once", tag)
          yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
          const steps = yield* home.sql(stepsOf(run))
          picks.push(...roundsRan(steps).map((round) => String(round.model)))
          if (tag !== "first") continue
          const started = steps.find((step) => step._tag === "Started")
          const ended = steps.find((step) => step._tag === "RoundEnded")
          const finished = steps.find((step) => step._tag === "Finished")
          expect(started?.project).toBeString()
          expect(ended?.role).toBe("worker")
          expect(ended?.tokens).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 })
          expect(finished?.accepted).toBe(true)
        }
        // Opus first, as listed; Haiku has no run yet; then Haiku, a fifth of Opus's price.
        expect(picks).toEqual([OPUS, HAIKU, HAIKU])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "reads a zero price over spent tokens as no price, and measures the round by its tokens",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(
            machineModels(models),
            tieredAccount({ efficient: [HAIKU, SONNET] }, [
              anthropicModel(HAIKU, { input: 0, output: 0 }),
              anthropicModel(SONNET, { input: 3, output: 15 }),
              // The owner's model, of no family a role names.
              Model.make({
                ...anthropicModel(TEST_MODEL_ID, { input: 3, output: 15 }),
                family: "owner",
              }),
            ]),
          ),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const first = yield* startRunOn(client, owner, EFFICIENT_ONCE, "efficient-once", "first")
        yield* waitFor(home.sql(runRow(first)), isSettled, 10_000, "the first run's end was told")
        expect(roundsRan(yield* home.sql(stepsOf(first)))).toEqual([
          { model: HAIKU, priced: false },
        ])
        // Haiku's run is measured by its tokens, so Sonnet, with none, runs next.
        const second = yield* startRunOn(client, owner, EFFICIENT_ONCE, "efficient-once", "second")
        yield* waitFor(home.sql(runRow(second)), isSettled, 10_000, "the second run's end was told")
        expect(roundsRan(yield* home.sql(stepsOf(second)))).toEqual([
          { model: SONNET, priced: true },
        ])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "prices an unpriced round's uncached input, cache reads and writes at the reference prices",
    () =>
      Effect.gen(function* () {
        // A million input tokens, all read from the cache: $0.50 at the reference prices.
        const cached = {
          rounds: [
            {
              role: "worker",
              model: HAIKU,
              tokens: { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
            },
          ],
        }
        const dearer = yield* rankedPick(
          [OPUS, HAIKU],
          [cached, { rounds: [{ role: "worker", model: OPUS, costUsd: 1 }] }],
        )
        expect(dearer).toEqual([HAIKU])
        const cheaper = yield* rankedPick(
          [HAIKU, OPUS],
          [cached, { rounds: [{ role: "worker", model: OPUS, costUsd: 0.4 }] }],
        )
        expect(cheaper).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "ranks a role on its own config role's rounds, not a switch's on the same thread role",
    () =>
      Effect.gen(function* () {
        const picks = yield* rankedPick(
          [OPUS, HAIKU],
          [
            { rounds: [{ role: "worker", configRole: "efficient", model: OPUS, costUsd: 1 }] },
            // Haiku ran only in another config role: its dear run says nothing of this one.
            { rounds: [{ role: "worker", configRole: "deep", model: HAIKU, costUsd: 5 }] },
          ],
        )
        expect(picks).toEqual([HAIKU])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "runs first a listed model with no measured run, before every measured one",
    () =>
      Effect.gen(function* () {
        const picks = yield* rankedPick(
          [OPUS, HAIKU, SONNET],
          [
            { rounds: [{ role: "worker", model: OPUS, costUsd: 1 }] },
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 0.5 }] },
          ],
        )
        expect(picks).toEqual([SONNET])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "counts a run its final state does not accept as spend with no unit",
    () =>
      Effect.gen(function* () {
        // Haiku: $2 over one accepted run; Opus: $1.5 over one.
        const picks = yield* rankedPick(
          [HAIKU, OPUS],
          [
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 1 }] },
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 1 }], accepted: false },
            { rounds: [{ role: "worker", model: OPUS, costUsd: 1.5 }] },
          ],
        )
        expect(picks).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "charges a model the whole run it worked in, the other roles' rounds too",
    () =>
      Effect.gen(function* () {
        // Haiku's work is cheap, but its runs took $1 of review; Sonnet's took $0.2.
        const picks = yield* rankedPick(
          [HAIKU, SONNET],
          [
            {
              rounds: [
                { role: "worker", model: HAIKU, costUsd: 0.1 },
                { role: "reviewer", model: OPUS, costUsd: 1 },
              ],
            },
            {
              rounds: [
                { role: "worker", model: SONNET, costUsd: 0.5 },
                { role: "reviewer", model: OPUS, costUsd: 0.2 },
              ],
            },
          ],
        )
        expect(picks).toEqual([SONNET])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "scores a model by its runs of the run's project and domain over its runs elsewhere",
    () =>
      Effect.gen(function* () {
        // Haiku is cheap in other projects' tui work, dear in this one's.
        const picks = yield* rankedPick(
          [HAIKU, OPUS],
          [
            ...times(3, {
              rounds: [{ role: "worker", model: HAIKU, costUsd: 0.1 }],
              elsewhere: true,
              domain: "tui",
            }),
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 2 }], domain: "tui" },
            { rounds: [{ role: "worker", model: OPUS, costUsd: 1 }], domain: "tui" },
          ],
          { domain: "tui" },
        )
        expect(picks).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "scores a model by its runs of the run's domain over its other runs of the project",
    () =>
      Effect.gen(function* () {
        // Haiku is cheap in this project's docs work, dear in its tui work.
        const picks = yield* rankedPick(
          [HAIKU, OPUS],
          [
            ...times(3, {
              rounds: [{ role: "worker", model: HAIKU, costUsd: 0.1 }],
              domain: "docs",
            }),
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 2 }], domain: "tui" },
            { rounds: [{ role: "worker", model: OPUS, costUsd: 1 }], domain: "tui" },
          ],
          { domain: "tui" },
        )
        expect(picks).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "weighs a run half as much as one ten runs newer",
    () =>
      Effect.gen(function* () {
        // Haiku's newest run was rejected at $1; its accepted $0.1 run is twenty runs older.
        const picks = yield* rankedPick(
          [HAIKU, OPUS],
          [
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 1 }], accepted: false },
            { rounds: [{ role: "worker", model: OPUS, costUsd: 2 }] },
            ...times(18, { rounds: [{ role: "reviewer", model: SONNET, costUsd: 1 }] }),
            { rounds: [{ role: "worker", model: HAIKU, costUsd: 0.1 }] },
          ],
        )
        expect(picks).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "runs the runner-up once the cheapest ran the role's last nine runs alone",
    () =>
      Effect.gen(function* () {
        const cheapest = { rounds: [{ role: "worker", model: HAIKU, costUsd: 0.1 }] }
        const older = { rounds: [{ role: "worker", model: OPUS, costUsd: 1 }] }
        const picks = yield* rankedPick([HAIKU, OPUS], [...times(9, cheapest), older])
        expect(picks).toEqual([OPUS])
        const fewer = yield* rankedPick([HAIKU, OPUS], [...times(8, cheapest), older])
        expect(fewer).toEqual([HAIKU])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "counts the runs toward the runner-up's turn in the cheapest model's own scope",
    () =>
      Effect.gen(function* () {
        // This project's nine newest runs ran Haiku alone; other projects' runs, Opus, between them.
        const here = { rounds: [{ role: "worker", model: HAIKU, costUsd: 0.1 }] }
        const elsewhere = {
          rounds: [{ role: "worker", model: OPUS, costUsd: 1 }],
          elsewhere: true,
        }
        const picks = yield* rankedPick(
          [HAIKU, OPUS],
          Array.from({ length: 9 }, () => [here, elsewhere]).flat(),
        )
        expect(picks).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "writes a final state that does not accept the work, and counts no accepted run for it",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), tieredAccount({ efficient: [HAIKU] })),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const dropped = {
          ...EFFICIENT_ONCE,
          states: { ...EFFICIENT_ONCE.states, done: { kind: "final", accepts: false } },
        }
        const run = yield* startRunOn(client, owner, dropped, "efficient-once")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const finished = (yield* home.sql(stepsOf(run))).find((step) => step._tag === "Finished")
        expect(finished?.accepted).toBe(false)
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), { run })
        expect(status.quality.map((row) => [row.model, row.rounds, row.accepted])).toEqual([
          [HAIKU, 1, { runs: 0, rounds: 0 }],
        ])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )
})

// ── a round's patience in its lane queue ────────────────────────────────────

/** Sol's family as the `work` account serves it: another maker's model on Opus's pool. */
const HOSTED_SOL = ModelId.make("anthropic/gpt-6.1-sol")

/** One price for every model: each run counts as one mean run of the pool. */
const PATIENT_PRICE = { input: 27_778, output: 27_778 }

/** Opus of Anthropic and the hosted Sol of OpenAI, on one account, and the owner's model. */
const PATIENT_MODELS = [
  Model.make({ ...anthropicModel(OPUS, PATIENT_PRICE), maker: "anthropic" }),
  Model.make({ ...anthropicModel(HOSTED_SOL, PATIENT_PRICE), maker: "openai" }),
  Model.make({ ...anthropicModel(TEST_MODEL_ID, PATIENT_PRICE), family: "owner" }),
]

/** One round of config role `pair`, its say naming `state`, then the end. */
const pairOnce = (name: string, state: string): Schema.Json => ({
  name,
  threads: { worker: { role: "pair" } },
  start: state,
  states: {
    [state]: { kind: "thread", thread: "worker", say: `STATE ${state} {{visit}}`, next: "done" },
    done: { kind: "final" },
  },
})

/** The week of `work` at `utilization`, resetting 20 hours after `now`. */
const weekAt = (now: number, utilization: number): ReadonlyArray<QuotaReading> => [
  { window: "7d", utilization, resetAt: now + 20 * HOUR, rejected: false },
]

interface OneLaneOptions {
  /** The worker of the patient round's `call`th model call, from 1; billed by default. */
  readonly patient?: (call: number) => WorkerStream
}

/**
 * The `work` account with one lane, its config role `pair` listing
 * `models` in order, and a `hold` run whose round takes that lane and
 * holds it until `holdEnds` opens. A `patient` round's worker answers once
 * `patientEnds` opens.
 */
const oneLaneHeld = (pair: ReadonlyArray<ModelId>, options: OneLaneOptions = {}) =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
    const holdEnds = yield* Deferred.make<boolean>()
    const patientEnds = yield* Deferred.make<boolean>()
    const patientCalls = yield* Ref.make(0)
    const models = yield* makeModels((round) => {
      const answer = billed(`${round.state} ${round.visit} done`)
      if (round.state === "hold") return Effect.as(Deferred.await(holdEnds), answer)
      return Effect.gen(function* () {
        yield* Deferred.await(patientEnds)
        if (acted(round.prompt)) return answer
        const call = yield* Ref.updateAndGet(patientCalls, (count) => count + 1)
        return options.patient?.(call) ?? answer
      })
    }, quotaOwner(readings))
    const account = tieredAccount({ pair }, PATIENT_MODELS)
    const serverWith = (extensionInputs: typeof e2ePreset.extensionInputs) =>
      createE2ELayer({
        ...e2ePreset,
        ...account,
        extensionInputs,
        providerLayer: machineModels(models),
        storagePath: `${home.home}/gent.db`,
        cwd: home.cwd,
        home: home.home,
      })
    // The first server lives until `restart` closes it.
    const firstServer = yield* Scope.make()
    const { client } = yield* createRpcClient(serverWith(e2ePreset.extensionInputs)).pipe(
      Effect.provideService(Scope.Scope, firstServer),
    )
    /**
     * Stops the first server, runs `whileDown`, and starts a second on the
     * same database, its machines' facade changed (with the hold round's gate
     * in reach): the runs' records arm their drivers on it.
     */
    const restart = (
      change: (
        ctx: ExtensionContextService,
        holdEnds: Deferred.Deferred<boolean>,
      ) => ExtensionContextService,
      whileDown: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        yield* Scope.close(firstServer, Exit.void)
        yield* whileDown
        const changed = machinesUnderFacade((ctx) => change(ctx, holdEnds))
        const second = yield* createRpcClient(
          serverWith(
            e2ePreset.extensionInputs.map((extension) => {
              if (extension.manifest.id === changed.manifest.id) return changed
              return extension
            }),
          ),
        )
        return second.client
      })
    const owner = ownerOf(yield* client.session.create({}))
    // The week moves a point over the owner's two steps: about 1.3 runs to its reset, one lane.
    const now = yield* Clock.currentTimeMillis
    yield* Ref.set(readings, weekAt(now, 0.1))
    yield* callOn(client, owner, [["machine.list", "list-before", {}]])
    yield* Ref.set(readings, weekAt(now, 0.11))
    yield* callOn(client, owner, [["machine.list", "list-after", {}]])
    expect((yield* client.accounts.lanes()).providers[0]?.capacity).toBe(1)
    const hold = yield* startRunOn(client, owner, pairOnce("hold", "hold"), "hold")
    yield* waitFor(
      Ref.get(models.calls),
      (calls) => calls.includes("hold:1"),
      10_000,
      "the hold round took the lane",
    )
    return { home, client, owner, models, holdEnds, patientEnds, hold, restart }
  })

/** The run's `Repicked` steps: the model each left and its maker. */
const repicksOf = (steps: ReadonlyArray<typeof StepView.Type>) =>
  steps.flatMap((step) => {
    if (step._tag !== "Repicked") return []
    return [{ state: step.state, model: step.model, maker: step.maker }]
  })

describe("a round's patience in its lane queue", () => {
  it.live(
    "a round queued past ten minutes moves to another maker's model on a new thread",
    () =>
      Effect.gen(function* () {
        const rig = yield* oneLaneHeld([OPUS, HOSTED_SOL])
        const { home, client, owner, models } = rig
        yield* Deferred.succeed(rig.patientEnds, true)
        // The pool's one lane is the hold round's: both choices queue, on Opus first.
        const run = yield* startRunOn(client, owner, pairOnce("patient", "patient"), "patient")
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => roundThreads(steps).length === 1,
          10_000,
          "the patient round queued on its thread",
        )
        // Nine minutes on, it still waits for Opus.
        yield* TestClock.adjust(Duration.minutes(9))
        yield* settle
        expect(repicksOf(yield* home.sql(stepsOf(run)))).toEqual([])
        expect(yield* Ref.get(models.calls)).toEqual(["hold:1"])
        // Past ten, it leaves Opus's queue and picks again with Anthropic's models left out.
        yield* TestClock.adjust(Duration.seconds(61))
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => roundThreads(steps).length === 2,
          10_000,
          "the round picked again",
        )
        // The hold round ends: its lane goes to the hosted Sol round.
        yield* Deferred.succeed(rig.holdEnds, true)
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(repicksOf(steps)).toEqual([{ state: "patient", model: OPUS, maker: "anthropic" }])
        expect(roundsRan(steps).map((round) => round.model)).toEqual([HOSTED_SOL])
        const [queued, moved] = roundThreads(steps)
        expect(moved).not.toBe(queued)
        expect(yield* Ref.get(models.calls)).toEqual(["hold:1", "patient:1"])
        const held = yield* home.sql(stepsOf(rig.hold))
        expect(roundsRan(held).map((round) => round.model)).toEqual([OPUS])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a round with no model of another maker keeps its place past ten minutes",
    () =>
      Effect.gen(function* () {
        const rig = yield* oneLaneHeld([OPUS])
        const { home, client, owner, models } = rig
        yield* Deferred.succeed(rig.patientEnds, true)
        const run = yield* startRunOn(client, owner, pairOnce("patient", "patient"), "patient")
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => roundThreads(steps).length === 1,
          10_000,
          "the patient round queued on its thread",
        )
        yield* TestClock.adjust(Duration.minutes(11))
        yield* settle
        yield* TestClock.adjust(Duration.minutes(5))
        yield* settle
        expect(repicksOf(yield* home.sql(stepsOf(run)))).toEqual([])
        expect(yield* Ref.get(models.calls)).toEqual(["hold:1"])
        // Its lane comes when the hold round ends: it runs on Opus, on its own thread.
        yield* Deferred.succeed(rig.holdEnds, true)
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS])
        expect(roundThreads(steps)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a round whose grant comes between the queue read and the move keeps its place and runs",
    () =>
      Effect.gen(function* () {
        const raced = yield* Ref.make(false)
        const rig = yield* oneLaneHeld([OPUS, HOSTED_SOL])
        const { home, owner, models } = rig
        yield* Deferred.succeed(rig.patientEnds, true)
        // The patient run is planted while no server runs, its round waiting a
        // minute: the second server's wake hook arms its driver under the
        // facade, and the hold round runs again before the patient round asks.
        // (A restart that cut a queued round lets it ask in no set order.)
        const run = runIdAt(1)
        const sendsAt = (yield* Clock.currentTimeMillis) + 60_000
        yield* rig.restart(
          (ctx, holdEnds) => ({
            ...ctx,
            Accounts: {
              ...ctx.Accounts,
              // The first read past patience says queued, though the hold round
              // ended and the grant reached the round before the machine moves.
              waiting: (message) =>
                Effect.gen(function* () {
                  const queued = yield* ctx.Accounts.waiting(message)
                  if (!queued || (yield* Ref.getAndSet(raced, true))) return queued
                  yield* Deferred.succeed(holdEnds, true)
                  yield* waitFor(
                    ctx.Accounts.waiting(message),
                    (still) => !still,
                    10_000,
                    "the grant reached the round",
                  ).pipe(Effect.orDie)
                  return true
                }),
            },
          }),
          plantRuns(home, encodeJson(pairOnce("patient", "work")), [
            { run, host: owner, debt: true, waitsUntil: sendsAt, createdAt: 0, wakeAt: 0 },
          ]).pipe(Effect.orDie),
        )
        yield* waitFor(
          Ref.get(models.calls),
          (calls) => calls.filter((call) => call === "hold:1").length === 2,
          10_000,
          "the hold round ran again on the second server",
        )
        yield* TestClock.adjust(Duration.seconds(61))
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => roundThreads(steps).length === 1,
          10_000,
          "the patient round queued on its thread",
        )
        yield* TestClock.adjust(Duration.seconds(601))
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
        expect(yield* Ref.get(raced)).toBe(true)
        const steps = yield* home.sql(stepsOf(run))
        expect(repicksOf(steps)).toEqual([])
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS])
        expect(roundThreads(steps)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a step that dies after the queue let the round go finishes the move when it runs again",
    () =>
      Effect.gen(function* () {
        const died = yield* Ref.make(false)
        const rig = yield* oneLaneHeld([OPUS, HOSTED_SOL])
        const { home, owner, models } = rig
        yield* Deferred.succeed(rig.patientEnds, true)
        // The patient run is planted while no server runs, its round waiting a
        // minute: the second server's wake hook arms its driver under the
        // facade, and the hold round runs again before the patient round asks.
        // A restart that cut a queued round lets it ask in no set order: it
        // can take the lane before the hold round's cut turn, and never move.
        const run = runIdAt(1)
        const sendsAt = (yield* Clock.currentTimeMillis) + 60_000
        yield* rig.restart(
          (ctx) => ({
            ...ctx,
            Accounts: {
              ...ctx.Accounts,
              // The first withdrawal takes the round out of its queue, then its step dies.
              withdraw: (message) =>
                Effect.gen(function* () {
                  const withdrawn = yield* ctx.Accounts.withdraw(message)
                  if (yield* Ref.getAndSet(died, true)) return withdrawn
                  return yield* Effect.die("the step died after the withdrawal")
                }),
            },
          }),
          plantRuns(home, encodeJson(pairOnce("patient", "work")), [
            { run, host: owner, debt: true, waitsUntil: sendsAt, createdAt: 0, wakeAt: 0 },
          ]).pipe(Effect.orDie),
        )
        yield* waitFor(
          Ref.get(models.calls),
          (calls) => calls.filter((call) => call === "hold:1").length === 2,
          10_000,
          "the hold round ran again on the second server",
        )
        // The driver reads the clock, then sleeps out the wait or the patience
        // left, and the dead step sleeps its retry delay: steps reach each
        // sleep, where one jump can land before it and leave it past the new time.
        yield* advanceUntil(home.sql(stepsOf(run)), (steps) => roundThreads(steps).length === 1, {
          label: "the patient round queued on its thread",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        yield* advanceUntil(Ref.get(died), (done) => done, {
          label: "the step died",
          step: "5 seconds",
          timeoutMs: 10_000,
        })
        // The step runs again after its retry delay and finishes the move.
        yield* advanceUntil(home.sql(stepsOf(run)), (steps) => roundThreads(steps).length === 2, {
          label: "the round picked again",
          step: "1 second",
          timeoutMs: 10_000,
        })
        yield* Deferred.succeed(rig.holdEnds, true)
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(repicksOf(steps)).toEqual([{ state: "work", model: OPUS, maker: "anthropic" }])
        expect(roundsRan(steps).map((round) => round.model)).toEqual([HOSTED_SOL])
        // The hold round's cut turn ran again after the restart; Opus's queued round never ran.
        expect(yield* Ref.get(models.calls)).toEqual(["hold:1", "hold:1", "work:1"])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )

  for (const { name, fails, wait } of [
    { name: "a usage limit's rerun", fails: usageLimited, wait: Duration.seconds(61) },
    { name: "a dead round's retry", fails: refusedStep, wait: Duration.seconds(0) },
  ]) {
    it.live(
      `${name} keeps the makers patience left`,
      () =>
        Effect.gen(function* () {
          const rig = yield* oneLaneHeld([OPUS, HOSTED_SOL], {
            patient: (call) => {
              if (call === 1) return fails()
              return billed("patient done")
            },
          })
          const { home, client, owner } = rig
          yield* Deferred.succeed(rig.patientEnds, true)
          const run = yield* startRunOn(client, owner, pairOnce("patient", "patient"), "patient")
          yield* waitFor(
            home.sql(stepsOf(run)),
            (steps) => roundThreads(steps).length === 1,
            10_000,
            "the patient round queued on its thread",
          )
          yield* TestClock.adjust(Duration.seconds(601))
          yield* waitFor(
            home.sql(stepsOf(run)),
            (steps) => roundThreads(steps).length === 2,
            10_000,
            "the round picked again",
          )
          // The lane frees: the hosted Sol round runs and fails; Opus has a lane now.
          yield* Deferred.succeed(rig.holdEnds, true)
          yield* waitFor(
            home.sql(stepsOf(run)),
            (steps) => roundsRan(steps).length === 1,
            10_000,
            "the hosted Sol round ended",
          )
          yield* TestClock.adjust(wait)
          yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
          const steps = yield* home.sql(stepsOf(run))
          expect(roundsRan(steps).map((round) => round.model)).toEqual([HOSTED_SOL, HOSTED_SOL])
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
      45_000,
    )
  }

  it.live(
    "a queued round that got its lane is not moved past ten minutes",
    () =>
      Effect.gen(function* () {
        const rig = yield* oneLaneHeld([OPUS, HOSTED_SOL])
        const { home, client, owner, models } = rig
        const run = yield* startRunOn(client, owner, pairOnce("patient", "patient"), "patient")
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => roundThreads(steps).length === 1,
          10_000,
          "the patient round queued on its thread",
        )
        // Five minutes on, the hold round ends: the patient round takes the lane and runs.
        yield* TestClock.adjust(Duration.minutes(5))
        yield* Deferred.succeed(rig.holdEnds, true)
        yield* waitFor(
          Ref.get(models.calls),
          (calls) => calls.includes("patient:1"),
          10_000,
          "the patient round runs",
        )
        // It still runs past ten minutes: it stays on Opus.
        yield* TestClock.adjust(Duration.minutes(10))
        yield* settle
        expect(repicksOf(yield* home.sql(stepsOf(run)))).toEqual([])
        yield* Deferred.succeed(rig.patientEnds, true)
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the patient run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS])
        expect(roundThreads(steps)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )
})

/** One round of a role that names no model and no tier, then the end. */
const UNNAMED_ONCE = {
  name: "unnamed-once",
  threads: { worker: {} },
  start: "work",
  states: {
    work: { kind: "thread", thread: "worker", say: "STATE work {{visit}}", next: "done" },
    done: { kind: "final" },
  },
}

describe("a role that names no model", () => {
  it.live(
    "records the starter's model as its round's when neither the role, its agent nor the config names one",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        // A headless run: `--model` sets the owner session's model, and the config names none.
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), {
            configServiceLayer: ConfigService.Test(new UserConfig({})),
            models: "catalog",
          }),
        )
        const owner = ownerOf(yield* client.session.create({ modelId: HAIKU }))
        const run = yield* startRunOn(client, owner, UNNAMED_ONCE, "unnamed-once")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(roundsRan(yield* home.sql(stepsOf(run)))).toEqual([{ model: HAIKU, priced: true }])
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), { run })
        expect(status.quality.map((row) => [String(row.state), row.model, row.rounds])).toEqual([
          ["work", HAIKU, 1],
        ])
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )
})

describe("a model's quality in a machine's state", () => {
  it.live(
    "counts each model's rounds, cost, verdicts, size stops, the checks and gates after them, and the rounds a finished run took",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels((round) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`)),
        )
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), tieredAccount({ efficient: [OPUS, HAIKU] })),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRunOn(client, owner, EFFICIENT_THRICE, "efficient-thrice")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        // An earlier run of the machine: Sonnet works, Haiku reviews, a check
        // fails them; Sonnet dies once and works again, the check passes, the
        // gate is green and the run finishes.
        const earlier = "run-00000000000000e1"
        yield* home.sql(copyRun(run, earlier))
        yield* home.sql(
          seedSteps(earlier, [
            SeededRound.make({
              state: "work",
              round: "w1",
              dead: false,
              model: SONNET,
              costUsd: 0.2,
            }),
            SeededRound.make({
              state: "review",
              round: "r1",
              dead: false,
              model: HAIKU,
              verdict: "revise",
              costUsd: 0.1,
            }),
            // A verdict is the model's own word, an object's own key among them.
            SeededRound.make({
              state: "review",
              round: "r2",
              dead: false,
              model: HAIKU,
              verdict: "constructor",
            }),
            // That round was too big for its thread: a size stop counts against Haiku's review.
            SeededMove.make({ from: "review", to: "work", by: "oversize" }),
            SeededMove.make({ from: "check", to: "work", by: "fail" }),
            SeededRound.make({ state: "work", round: "w2", dead: true, model: SONNET }),
            SeededRound.make({
              state: "work",
              round: "w3",
              dead: false,
              model: SONNET,
              costUsd: 0.4,
            }),
            SeededMove.make({ from: "check", to: "ship", by: "pass" }),
            SeededMove.make({ from: "ship", to: "done", by: "green" }),
            SeededFinish.make({ state: "done" }),
          ]),
        )
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), { run })
        const rows = status.quality.map(({ costUsd: _cost, ...row }) => ({
          ...row,
          state: String(row.state),
        }))
        const costs = status.quality.map((row) => Math.round(row.costUsd * 1_000) / 1_000)
        const none = { checks: { pass: 0, fail: 0 }, gates: { green: 0, red: 0 }, verdicts: {} }
        expect(rows).toEqual([
          {
            state: "review",
            model: HAIKU,
            rounds: 2,
            dead: 0,
            oversize: 1,
            priced: 1,
            verdicts: { revise: 1, constructor: 1 },
            // The failed check judged its rounds; the passing one, only Sonnet's after it.
            checks: { pass: 0, fail: 1 },
            gates: { green: 1, red: 0 },
            accepted: { runs: 1, rounds: 2 },
          },
          // This run's own rounds: the machine has no ended run, so Opus, as listed, all three.
          {
            state: "work",
            model: OPUS,
            rounds: 3,
            dead: 0,
            oversize: 0,
            priced: 3,
            ...none,
            accepted: { runs: 1, rounds: 3 },
          },
          {
            state: "work",
            model: SONNET,
            rounds: 3,
            dead: 1,
            oversize: 0,
            priced: 2,
            verdicts: {},
            checks: { pass: 1, fail: 1 },
            gates: { green: 1, red: 0 },
            accepted: { runs: 1, rounds: 3 },
          },
        ])
        expect(costs[2]).toBe(0.6)
        // The TUI asks by a round's thread: the rows of that thread's state alone.
        const threads = roundThreads(yield* home.sql(stepsOf(run)))
        const quality = ref(MachinesRpc.Quality)
        const byThread = yield* machinesRequest(client, owner, quality, {
          session: SessionId.make(threads.at(-1) ?? ""),
        })
        expect(byThread.map((row) => [String(row.state), row.model])).toEqual([
          ["work", OPUS],
          ["work", SONNET],
        ])
        // A session handed off from the round's thread asks by its own id.
        const handoff = ownerOf(yield* client.session.create({}))
        yield* home.sql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE sessions SET thread_id = ${threads.at(-1) ?? ""} WHERE id = ${handoff.sessionId}`
          }),
        )
        const byHandoff = yield* machinesRequest(client, owner, quality, {
          session: handoff.sessionId,
        })
        expect(byHandoff.map((row) => row.model)).toEqual([OPUS, SONNET])
        // A thread no round ran on has none.
        expect(
          yield* machinesRequest(client, owner, quality, { session: owner.sessionId }),
        ).toEqual([])
        // Another thread's session cannot read the run's.
        const stranger = ownerOf(yield* client.session.create({}))
        const refused = yield* machinesRequest(client, stranger, quality, {
          session: SessionId.make(threads.at(-1) ?? ""),
        }).pipe(Effect.flip)
        expect(String(refused)).toContain("belongs to another thread")
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
  )
})

/** One command that records its start in `ran.log`, then runs until a `gate` file appears. */
const GATED_COMMAND = {
  name: "gated-command",
  threads: {},
  start: "check",
  states: {
    check: {
      kind: "run",
      run: "echo ran >> ran.log; while [ ! -f gate ]; do sleep 0.05; done",
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
}

/** The lines of `ran.log` in the run's cwd: one per command that started. */
const ranLines = (cwd: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    Effect.flatMap(fs.exists(`${cwd}/ran.log`), (exists) => {
      if (!exists) return Effect.succeed(0)
      return Effect.map(
        fs.readFileString(`${cwd}/ran.log`),
        (text) => text.split("\n").filter((line) => line.length > 0).length,
      )
    }),
  ).pipe(Effect.provide(BunServices.layer))

describe("the machine boot budget", () => {
  it.live(
    "twenty runs on twenty hosts open all their rounds at once: no server-wide step count",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const hosts = yield* makeHosts(home, 20)
        const runs = hosts.map((host, index): PlantedRun => ({
          run: runIdAt(index + 1),
          host,
          debt: false,
          createdAt: 1_000 + index,
          wakeAt: 1_000 + index,
        }))
        // No lane reads a window here, so every round is admitted at once.
        expect(yield* bootGated(home, runs, 20, (order) => expect(order).toHaveLength(20))).toBe(20)
      }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
  )

  it.live(
    "after a restart, cut rounds and waits whose time came run at once, each wait dispatched again before its send",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        // Five waits: more than the four commands the server runs at once.
        const hosts = yield* makeHosts(home, 5)
        const interrupted = yield* Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Queue.unbounded<void>()
            const models = yield* makeModels(() =>
              Effect.succeed(hangAfter(Queue.offer(entered, void 0).pipe(Effect.asVoid))),
            )
            const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
            return yield* Effect.forEach([1, 2, 3, 4], (index) =>
              Effect.gen(function* () {
                const owner = ownerOf(yield* client.session.create({}))
                const run = yield* startRun(client, owner, BUDGET, "budget", {
                  tag: `interrupted-${index}`,
                })
                yield* Queue.take(entered)
                return run
              }),
            )
          }),
        )
        expect(yield* home.sql(roundEnds)).toHaveLength(4)
        expect(
          (yield* home.sql(roundEnds)).every((round) => Predicate.isNull(round.ended_at)),
        ).toBe(true)
        const expired = hosts.map((host, index): PlantedRun => ({
          run: runIdAt(index + 1),
          host,
          debt: true,
          waitsUntil: wallClock.currentTimeMillisUnsafe() - 1,
          createdAt: 100 + index,
          wakeAt: 100 + index,
        }))
        yield* plantRuns(home, BUDGET_JSON, expired)
        const gate = yield* Deferred.make<boolean>()
        const open = yield* Ref.make(0)
        const most = yield* Ref.make(0)
        const order = yield* Ref.make<ReadonlyArray<string>>([])
        const worker = gatedWorker(gate, open, most, order)
        const resumedMarkers = yield* Ref.make<ReadonlyArray<Option.Option<number>>>([])
        const models = yield* makeModels((round) =>
          Effect.gen(function* () {
            if (round.mode.startsWith("run-")) {
              // A resumed wait is dispatched again, with no marker, before its send.
              const marker = yield* home.sql(pendingWait(round.mode)).pipe(Effect.orDie)
              yield* Ref.update(resumedMarkers, (all) => [...all, marker])
            }
            return yield* worker(round)
          }),
        )
        yield* createRpcClient(home.layerFor(machineModels(models)))
        yield* waitFor(Ref.get(open), (count) => count >= 9, 8_000, "every round opened")
        expect((yield* Ref.get(order)).toSorted()).toEqual(
          [
            ...expired.map((run) => run.run),
            "interrupted-1",
            "interrupted-2",
            "interrupted-3",
            "interrupted-4",
          ].toSorted(),
        )
        yield* Deferred.succeed(gate, true)
        yield* waitFor(
          home.sql(allAsking([...interrupted, ...expired.map((run) => run.run)])),
          Boolean,
          20_000,
          "all runs reached their ask",
        )
        expect(yield* Ref.get(most)).toBe(9)
        expect(yield* Ref.get(resumedMarkers)).toEqual(expired.map(() => Option.none()))
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("at most four machine commands run at once; the fifth starts when one ends", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const runs = yield* Effect.forEach([1, 2, 3, 4, 5], (index) =>
        startRunOn(client, owner, GATED_COMMAND, "gated-command", `gated-${index}`),
      )
      yield* waitFor(ranLines(home.cwd), (count) => count >= 4, 10_000, "four commands started")
      yield* settle
      expect(yield* ranLines(home.cwd)).toBe(4)
      // The gate opens: the four end, and the fifth runs and ends too.
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(`${home.cwd}/gate`, "")),
        Effect.provide(BunServices.layer),
      )
      yield* Effect.forEach(runs, (run) =>
        waitFor(home.sql(runRow(run)), isSettled, 15_000, `${run}'s end was told`),
      )
      expect(yield* ranLines(home.cwd)).toBe(5)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a stop on a run that waits for a command permit settles at once", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const models = yield* makeModels(twoAsksWorker)
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const running = yield* Effect.forEach([1, 2, 3, 4], (index) =>
        startRunOn(client, owner, GATED_COMMAND, "gated-command", `gated-${index}`),
      )
      yield* waitFor(ranLines(home.cwd), (count) => count >= 4, 10_000, "four commands started")
      const waiting = yield* startRunOn(client, owner, GATED_COMMAND, "gated-command", "gated-5")
      yield* settle
      const [stopped] = yield* call(client, owner, [
        ["machine.stop", "stop-waiting", { run: waiting }],
      ])
      expect(stopped?.failed).toBe(false)
      // The four still run: the stop did not wait for a permit to free.
      const row = yield* waitFor(home.sql(runRow(waiting)), isSettled, 5_000, "the stop settled")
      expect(Option.map(row, (found) => found.status)).toEqual(Option.some("stopped"))
      expect(yield* ranLines(home.cwd)).toBe(4)
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(`${home.cwd}/gate`, "")),
        Effect.provide(BunServices.layer),
      )
      yield* Effect.forEach(running, (run) =>
        waitFor(home.sql(runRow(run)), isSettled, 15_000, `${run}'s end was told`),
      )
      expect(yield* ranLines(home.cwd)).toBe(4)
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "commands a restart cut ask interrupted and hold no permit: a new command runs while they ask",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const models = yield* makeModels(twoAsksWorker)
        const { cut, owner } = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
            const owner = ownerOf(yield* client.session.create({}))
            const cut = yield* Effect.forEach([1, 2, 3, 4], (index) =>
              startRunOn(client, owner, GATED_COMMAND, "gated-command", `cut-${index}`),
            )
            yield* waitFor(
              ranLines(home.cwd),
              (count) => count >= 4,
              10_000,
              "four commands started",
            )
            return { cut, owner }
          }),
        )
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        yield* waitFor(home.sql(allAsking(cut)), Boolean, 15_000, "the cut commands asked")
        // Nobody answers the four asks; a new command still gets a permit.
        const fresh = yield* startRunOn(client, owner, GATED_COMMAND, "gated-command", "fresh")
        yield* waitFor(ranLines(home.cwd), (count) => count >= 5, 10_000, "the new command started")
        yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.writeFileString(`${home.cwd}/gate`, "")),
          Effect.provide(BunServices.layer),
        )
        yield* waitFor(home.sql(runRow(fresh)), isSettled, 15_000, "the new command's end was told")
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
    65_000,
  )

  it.live("six runs on one host open all six rounds at once: no cap per host, the lanes pace", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const gate = yield* Deferred.make<boolean>()
      const open = yield* Ref.make(0)
      const most = yield* Ref.make(0)
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const models = yield* makeModels(gatedWorker(gate, open, most, order))
      const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
      const owner = ownerOf(yield* client.session.create({}))
      const runs = yield* Effect.forEach([1, 2, 3, 4, 5, 6], (index) =>
        startRun(
          client,
          owner,
          BUDGET,
          "budget",
          { tag: `one-host-${index}` },
          `one-host-${index}`,
        ),
      )
      yield* waitFor(Ref.get(open), (count) => count >= 6, 10_000, "six rounds opened")
      yield* settle
      expect(yield* Ref.get(open)).toBe(6)
      yield* Deferred.succeed(gate, true)
      yield* waitFor(home.sql(allAsking(runs)), Boolean, 30_000, "every run reached its ask")
      expect(yield* Ref.get(most)).toBe(6)
    }).pipe(Effect.scoped, Effect.timeout("50 seconds")),
  )
})

// ── named command permits ───────────────────────────────────────────────────

/** Controlled OS boundary. Real machines, permits, storage and RPC stay inside it. */
const commandBoundary = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exited = yield* Deferred.make<boolean>()
  const entered = yield* Deferred.make<boolean>()
  const events: string[] = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.command !== "bash") {
        return yield* Effect.die("Expected a recorded machine command")
      }
      let label = "bash"
      if (command.args[2] === "gent-command") {
        const receipt = Option.getOrThrow(Option.fromUndefinedOr(command.args[3]))
        yield* fs.writeFileString(receipt, "4242\nfixture-start\n")
        label = "machine"
      }
      events.push(`${label}:start`)
      yield* Deferred.succeed(entered, true)
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(exited, true).pipe(
          Effect.andThen(
            Effect.sync(() => {
              events.push(`${label}:end`)
            }),
          ),
        ),
      )
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        exitCode: Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => Deferred.succeed(exited, true).pipe(Effect.asVoid),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )
  return {
    events,
    entered,
    exited,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  }
})

/** Read the real facade through a user request, then call it directly beside machines. */
const commandPermitHarness = (processes: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const exposed = yield* Deferred.make<ExtensionContextService["Permits"]>()
    const extensionId = ExtensionId.make("machine-permit-probe")
    const probe = defineExtension({
      id: extensionId,
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register(
          "resource",
          defineResource({
            id: "machine-permit-process-boundary",
            scope: "process",
            layer: processes,
          }),
        )
        yield* host.register(
          "request",
          request({
            id: "connect",
            input: Schema.Struct({}),
            output: Schema.Void,
            execute: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(exposed, (yield* ExtensionContext).Permits)
              }),
          }),
        )
      }),
    })
    const models = yield* makeModels(twoAsksWorker)
    const { client } = yield* createRpcClient(
      createE2ELayer({
        ...e2ePreset,
        providerLayer: machineModels(models),
        cwd: home.cwd,
        home: home.home,
        storagePath: `${home.home}/gent.db`,
        extensionInputs: [...e2ePreset.extensionInputs, probe],
      }),
    )
    const owner = ownerOf(yield* client.session.create({}))
    yield* client.extension.request({ ...owner, extensionId, capabilityId: "connect", input: {} })
    return { home, client, owner, permits: yield* Deferred.await(exposed) }
  })

const NAMED_COMMAND = {
  ...ONE_COMMAND,
  states: {
    ...ONE_COMMAND.states,
    check: { ...ONE_COMMAND.states.check, permit: { name: "machine-gate" } },
  },
}

describe("machine command named permits", () => {
  it.live("a machine command and direct holders share one limit for their full lifetimes", () =>
    Effect.gen(function* () {
      const boundary = yield* commandBoundary
      const { home, client, owner, permits } = yield* commandPermitHarness(boundary.layer)
      const release = yield* Deferred.make<boolean>()
      const direct = Effect.acquireUseRelease(
        Effect.sync(() => {
          boundary.events.push("direct:start")
        }),
        () => Deferred.await(release),
        () =>
          Effect.sync(() => {
            boundary.events.push("direct:end")
          }),
      )
      const first = yield* permits.with("machine-gate", 1, direct).pipe(Effect.forkScoped)
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.holders.length === 1)
      const run = yield* startRun(client, owner, NAMED_COMMAND, "one-command")
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.waiters.length === 1)
      expect(yield* Deferred.isDone(boundary.entered)).toBe(false)
      yield* Deferred.succeed(release, true)
      yield* Fiber.join(first)
      yield* Deferred.await(boundary.entered)
      const second = yield* permits
        .with(
          "machine-gate",
          1,
          Effect.sync(() => {
            boundary.events.push("direct:start", "direct:end")
          }),
        )
        .pipe(Effect.forkScoped)
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.waiters.length === 1)
      expect(boundary.events).toEqual(["direct:start", "direct:end", "machine:start"])
      yield* Deferred.succeed(boundary.exited, true)
      yield* Fiber.join(second)
      yield* waitForEnd(client, owner)
      expect(boundary.events).toEqual([
        "direct:start",
        "direct:end",
        "machine:start",
        "machine:end",
        "direct:start",
        "direct:end",
      ])
      let active = 0
      let maximum = 0
      for (const line of boundary.events) {
        if (line.endsWith(":start")) active += 1
        else active -= 1
        maximum = Math.max(maximum, active)
      }
      expect(maximum).toBe(1)
      expect(active).toBe(0)
      expect(yield* client.permits.list()).toEqual([])
      expect(Option.map(yield* home.sql(runRow(run)), (row) => row.status)).toEqual(
        Option.some("final"),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a mismatched command permit becomes a typed machine fault before spawning", () =>
    Effect.gen(function* () {
      const boundary = yield* commandBoundary
      const { client, owner, permits } = yield* commandPermitHarness(boundary.layer)
      const held = yield* permits.with("machine-gate", 1, Effect.never).pipe(Effect.forkScoped)
      yield* waitFor(client.permits.list(), (rows) => rows[0]?.holders.length === 1)
      const run = yield* startRun(
        client,
        owner,
        {
          ...NAMED_COMMAND,
          states: {
            ...NAMED_COMMAND.states,
            check: {
              ...NAMED_COMMAND.states.check,
              permit: { name: "machine-gate", limit: 2 },
            },
          },
        },
        "one-command",
      )
      yield* waitForEnd(client, owner)
      const statusRef = ref(MachinesRpc.Status)
      const status = yield* decodeRequestReply(MachineRunStatus)(
        yield* client.extension.request({
          ...owner,
          extensionId: statusRef.extensionId,
          capabilityId: statusRef.capabilityId,
          input: { run },
        }),
      )
      expect(status.status).toBe("failed")
      expect(status.error).toBe('Permit "machine-gate" has limit 1, requested 2')
      expect(status.steps.map(({ step }) => step._tag)).toContain("Failed")
      expect(status.steps.map(({ step }) => step._tag)).not.toContain("CommandEnded")
      expect(boundary.events).toEqual([])
      expect((yield* client.permits.list())[0]?.holders).toHaveLength(1)
      yield* Fiber.interrupt(held)
    }).pipe(Effect.provide(BunServices.layer), Effect.scoped, Effect.timeout("20 seconds")),
  )
})

it.live("bash and a machine command share one named limit through process cleanup", () =>
  Effect.gen(function* () {
    const boundary = yield* commandBoundary
    const { client, owner } = yield* commandPermitHarness(boundary.layer)
    yield* startRun(client, owner, NAMED_COMMAND, "one-command")
    yield* Deferred.await(boundary.entered)
    const bash = yield* call(client, owner, [
      [
        "bash",
        "shared-bash",
        {
          command: "bash-fixture",
          permit: { name: "machine-gate", limit: 1 },
        },
      ],
    ]).pipe(Effect.forkScoped)
    yield* waitFor(client.permits.list(), (rows) => rows[0]?.waiters.length === 1)
    expect(boundary.events).toEqual(["machine:start"])
    yield* Deferred.succeed(boundary.exited, true)
    const [result] = yield* Fiber.join(bash)
    expect(result?.failed).toBe(false)
    expect(boundary.events).toEqual(["machine:start", "machine:end", "bash:start", "bash:end"])
    expect(yield* client.permits.list()).toEqual([])
    yield* waitForEnd(client, owner)
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped, Effect.timeout("12 seconds")),
)

// ── integrate states ────────────────────────────────────────────────────────

/** ship (integrate main) → done on green, broken on red. */
const SHIP = {
  name: "ship",
  threads: {},
  start: "ship",
  states: {
    ship: { kind: "integrate", ref: "main", on: { green: "done", red: "broken" } },
    done: { kind: "final" },
    broken: { kind: "final" },
  },
}

/** The fake GitHub as a process resource beside the shipped extensions. */
const githubBoundary = (layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  defineExtension({
    id: ExtensionId.make("machine-github-boundary"),
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "resource",
        defineResource({ id: "machine-github-process-boundary", scope: "process", layer }),
      )
    }),
  })

/** The value the state's last visit left. */
const savedValue = (run: string, state: string) =>
  Effect.map(storedRun(run), (found) => found.context.last[state])

/**
 * CI time passes while no server runs: the poll the gate names and the
 * run's record, armed for it, come due now.
 */
const pollDueNow = (run: string, repo: string, ref: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE integration_gates
      SET record_json = json_set(record_json, '$.nextPollAt', 0), version = version + 1
      WHERE repo = ${repo} AND ref = ${ref}`
    yield* sql`UPDATE branch_wakes SET at = 0, version = version + 1
      WHERE source_id = ${`machine-run:${run}`}`
  })

const decodeGateTimes = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ next: Schema.Finite, at: Schema.NullOr(Schema.Finite) })),
)
/** The gate's next poll, and the time the run's record is armed for. */
const gateTimes = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT json_extract(record_json, '$.nextPollAt') AS next,
      (SELECT at FROM branch_wakes WHERE source_id = ${`machine-run:${run}`}) AS at
      FROM integration_gates`
    return decodeGateTimes(rows)[0]
  })

describe("an integrate state", () => {
  for (const verdict of [
    { conclusion: "success", to: "done", outcome: "green" },
    { conclusion: "failure", to: "broken", outcome: "red" },
  ] as const) {
    it.live(
      `pushes the run's head once, waits for CI across a restart, and takes ${verdict.outcome}`,
      () =>
        Effect.gen(function* () {
          const home = yield* restartableHome
          const github = yield* fakeGitHub()
          const boundary = githubBoundary(github.layer)
          const models = yield* makeModels(trackWorker)
          const layer = () => home.layerFor(machineModels(models), { extensionInputs: [boundary] })
          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(layer())
              const owner = ownerOf(yield* client.session.create({}))
              const run = yield* startRun(client, owner, SHIP, "ship")
              yield* waitFor(
                home.sql(runRow(run)),
                (row) =>
                  Option.exists(row, (found) =>
                    (found.pending_json ?? "").includes('"generation":1'),
                  ),
                8_000,
                "the gate admitted the push",
              )
              return { owner, run }
            }),
          )
          expect(github.remote.pushes).toEqual([CANDIDATE])
          // The run polls its own gate: its record is armed for the gate's next poll.
          const times = yield* home.sql(gateTimes(first.run))
          expect(times?.at).toBe(times?.next)
          github.addRun({
            name: "test",
            head_sha: CANDIDATE,
            status: "completed",
            conclusion: verdict.conclusion,
          })
          yield* home.sql(pollDueNow(first.run, REPO, "main"))
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { client } = yield* createRpcClient(layer())
              // No client call: the run's own record activates its host, which polls the gate.
              yield* waitFor(
                home.sql(runRow(first.run)),
                (row) => Option.exists(row, (found) => found.status === "final"),
                15_000,
                "the run took the verdict",
              )
              yield* waitForEnd(client, first.owner)
            }),
          )
          expect(Option.map(yield* home.sql(runRow(first.run)), (row) => row.state)).toEqual(
            Option.some(verdict.to),
          )
          expect(yield* home.sql(savedValue(first.run, "ship"))).toMatchObject({
            outcome: verdict.outcome,
            generation: 1,
            sha: CANDIDATE,
          })
          expect(moves(yield* home.sql(stepsOf(first.run)))).toEqual([`ship→${verdict.to}`])
          // The restart pushed nothing again.
          expect(github.remote.pushes).toEqual([CANDIDATE])
        }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    )
  }

  it.live(
    "a gate it cannot claim makes the run wait with reason integration, holding nothing",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub({ gh: "signed-out" })
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(
          home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
        )
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRun(client, owner, SHIP, "ship")
        const steps = yield* waitFor(
          home.sql(stepsOf(run)),
          (all) => all.some((step) => step._tag === "Waiting"),
          8_000,
          "the run waits for the gate",
        )
        expect(steps.find((step) => step._tag === "Waiting")).toMatchObject({
          reason: "integration",
        })
        const row = Option.getOrThrow(yield* home.sql(runRow(run)))
        expect(row).toMatchObject({ state: "ship", status: "running" })
        expect(row.pending_json ?? "").toContain('"notBefore"')
        expect(github.remote.pushes).toEqual([])
        expect(yield* client.permits.list()).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a start whose remote is missing fails before any run exists", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub({ url: Option.none() })
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      const owner = ownerOf(yield* client.session.create({}))
      const [defined] = yield* call(client, owner, [
        ["machine.define", "define-ship", { definition: SHIP }],
      ])
      expect(defined?.failed).toBe(false)
      const [started] = yield* call(client, owner, [
        ["machine.start", "start-ship", { machine: "ship" }],
      ])
      expect(started?.failed).toBe(true)
      expect(encodeJson(started?.result)).toContain(
        "ship cannot push: No git remote origin: error: No such remote 'origin'",
      )
      const runs = yield* home.sql(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT run FROM machine_runs`),
      )
      expect(runs).toEqual([])
      expect(github.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live("a push the gate refuses takes red with the reason saved", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub({ diverged: new Set([CANDIDATE]) })
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SHIP, "ship")
      yield* waitForEnd(client, owner)
      expect(Option.map(yield* home.sql(runRow(run)), (found) => found.state)).toEqual(
        Option.some("broken"),
      )
      expect(yield* home.sql(savedValue(run, "ship"))).toMatchObject({ outcome: "refused" })
      expect(github.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )
})

const GateRowView = Schema.Struct({
  state: Schema.String,
  host: Schema.OptionFromNullOr(Schema.String),
  poller: Schema.OptionFromNullOr(Schema.String),
})
const decodeGateRows = Schema.decodeUnknownSync(Schema.Array(GateRowView))
/** The gate's state, and the session and poller that host it, if any. */
const gateRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT json_extract(record_json, '$.state._tag') AS state,
    json_extract(record_json, '$.host.sessionId') AS host,
    json_extract(record_json, '$.host.poller') AS poller
    FROM integration_gates`
  return Option.fromUndefinedOr(decodeGateRows(rows)[0])
})

const isClaimed = (row: Option.Option<typeof GateRowView.Type>) =>
  Option.exists(row, (found) => found.state === "Integrating")

/** The shipped extensions with `machines` in place of the shipped machines, beside the fake GitHub. */
const layerWithMachines = (
  home: Effect.Success<typeof restartableHome>,
  models: MachineModels,
  boundary: ReturnType<typeof githubBoundary>,
  machines: ReturnType<typeof machinesWithContext>,
) =>
  createE2ELayer({
    ...e2ePreset,
    extensionInputs: [
      ...e2ePreset.extensionInputs.map((extension) => {
        if (extension.manifest.id === machines.manifest.id) return machines
        return extension
      }),
      boundary,
    ],
    providerLayer: machineModels(models),
    storagePath: `${home.home}/gent.db`,
    cwd: home.cwd,
    home: home.home,
  })

/**
 * A run whose server stopped after the gate wrote its claim and before the
 * push landed: the push is held, the claim is written, the server goes.
 */
const claimThenCrash = (
  home: Effect.Success<typeof restartableHome>,
  github: Effect.Success<ReturnType<typeof fakeGitHub>>,
  models: MachineModels,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>()
      github.remote.pushGate = Option.some(held)
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, SHIP, "ship")
      yield* waitFor(home.sql(gateRow), isClaimed, 8_000, "the gate wrote the claim")
      return { owner, run }
    }),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        github.remote.pushGate = Option.none()
      }),
    ),
  )

describe("an integrate state across a crash", () => {
  it.live("a push a crash cut off before it landed takes red as interrupted, pushing nothing", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const models = yield* makeModels(trackWorker)
      const first = yield* claimThenCrash(home, github, models)
      expect(github.remote.pushes).toEqual([])
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      // The loop open gives the run its driver again.
      yield* client.session.getSnapshot(first.owner)
      yield* waitFor(
        home.sql(runRow(first.run)),
        (row) => Option.exists(row, (found) => found.status === "final"),
        15_000,
        "the run took red",
      )
      expect(Option.map(yield* home.sql(runRow(first.run)), (row) => row.state)).toEqual(
        Option.some("broken"),
      )
      expect(yield* home.sql(savedValue(first.run, "ship"))).toMatchObject({
        outcome: "interrupted",
      })
      expect(moves(yield* home.sql(stepsOf(first.run)))).toEqual(["ship→broken"])
      expect(github.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a stop after a crash between the claim and the run's record releases the gate", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const models = yield* makeModels(trackWorker)
      const first = yield* claimThenCrash(home, github, models)
      // gh is signed out after the restart: the run cannot reach the gate, and waits.
      github.remote.gh = "signed-out"
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      yield* client.session.getSnapshot(first.owner)
      yield* waitFor(
        home.sql(stepsOf(first.run)),
        (steps) => steps.some((step) => step._tag === "Waiting"),
        8_000,
        "the run waits for the gate",
      )
      expect(yield* home.sql(gateRow)).toEqual(
        Option.some({
          state: "Integrating",
          host: Option.some(first.owner.sessionId),
          poller: Option.some("caller"),
        }),
      )
      const [stopped] = yield* call(client, first.owner, [
        ["machine.stop", "stop-ship", { run: first.run }],
      ])
      expect(stopped?.failed).toBe(false)
      // The gate lost its host: the next loop open of any branch adopts it.
      expect(yield* home.sql(gateRow)).toEqual(
        Option.some({ state: "Integrating", host: Option.none(), poller: Option.none() }),
      )
      const other = ownerOf(yield* client.session.create({}))
      yield* client.session.getSnapshot(other)
      yield* waitFor(
        home.sql(gateRow),
        (row) => Option.exists(row, (found) => Option.contains(found.host, other.sessionId)),
        8_000,
        "another branch adopted the gate",
      )
      expect(github.remote.pushes).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a gate write that fails after the push fails the run and releases the gate", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      const owner = ownerOf(yield* client.session.create({}))
      // The gate's second write, the claim to awaiting CI, fails.
      yield* home.sql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TRIGGER fail_awaiting BEFORE UPDATE ON integration_gates
            WHEN json_extract(NEW.record_json, '$.state._tag') = 'AwaitingCi'
            BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`
        }),
      )
      const run = yield* startRun(client, owner, SHIP, "ship")
      yield* waitFor(
        home.sql(runRow(run)),
        (row) => Option.exists(row, (found) => found.status === "failed"),
        15_000,
        "the run failed",
      )
      expect(github.remote.pushes).toEqual([CANDIDATE])
      expect(yield* home.sql(gateRow)).toEqual(
        Option.some({ state: "Integrating", host: Option.none(), poller: Option.none() }),
      )
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )
})

describe("an integrate state while CI runs", () => {
  it.live("a run that waits for CI holds its branch resident no longer and holds no permit", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const boundary = githubBoundary(github.layer)
      const models = yield* makeModels(trackWorker)
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(
            home.layerFor(machineModels(models), { extensionInputs: [boundary] }),
          )
          const owner = ownerOf(yield* client.session.create({}))
          const run = yield* startRun(client, owner, SHIP, "ship")
          yield* waitFor(
            home.sql(runRow(run)),
            (row) =>
              Option.exists(row, (found) => (found.pending_json ?? "").includes('"generation":1')),
            8_000,
            "the gate admitted the push",
          )
          return { owner, run }
        }),
      )
      // The next server's machines count the holds on the branch and the run's waits.
      const holds = yield* Ref.make({ now: 0, most: 0 })
      const arms = yield* Ref.make<ReadonlyArray<number>>([])
      const counting = machinesWithContext((ctx) => ({
        ...ctx,
        Session: {
          ...ctx.Session,
          holdResident: Effect.acquireRelease(
            Ref.update(holds, (count) => ({
              now: count.now + 1,
              most: Math.max(count.most, count.now + 1),
            })),
            () => Ref.update(holds, (count) => ({ ...count, now: count.now - 1 })),
          ).pipe(Effect.andThen(ctx.Session.holdResident)),
          wakeAt: (input) =>
            Effect.gen(function* () {
              if (input.sourceId === `machine-run:${first.run}` && Predicate.isNumber(input.at)) {
                const at = input.at
                yield* Ref.update(arms, (all) => [...all, at])
              }
              yield* ctx.Session.wakeAt(input)
            }),
        },
      }))
      const { client } = yield* createRpcClient(layerWithMachines(home, models, boundary, counting))
      // The loop open gives the run its driver, on the counting facade.
      yield* client.session.getSnapshot(first.owner)
      const next = (yield* home.sql(gateTimes(first.run)))?.next
      yield* waitFor(
        Ref.get(arms),
        (all) => all.some((at) => at === next),
        8_000,
        "the run sleeps until the gate's next poll",
      )
      expect(yield* Ref.get(holds)).toEqual({ now: 0, most: 0 })
      expect(yield* client.permits.list()).toEqual([])
      expect(Option.map(yield* home.sql(runRow(first.run)), (row) => row.status)).toEqual(
        Option.some("running"),
      )
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live("a gate it could not reach is tried again after the retry wait", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub({ gh: "signed-out" })
      const models = yield* makeModels(trackWorker)
      const { client } = yield* createRpcClient(
        home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
      )
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRunOn(client, owner, SHIP, "ship")
      const steps = yield* waitFor(
        home.sql(stepsOf(run)),
        (found) => waitsOf(found).length === 1,
        10_000,
        "the run waits for the gate",
      )
      const until = waitsOf(steps)[0]?.until ?? 0
      expect(until - (yield* Clock.currentTimeMillis)).toBe(Duration.toMillis(Duration.minutes(1)))
      github.remote.gh = "ready"
      yield* TestClock.adjust(until - (yield* Clock.currentTimeMillis) - 10_000)
      yield* settle
      expect(github.remote.pushes).toEqual([])
      yield* advanceUntil(
        Effect.sync(() => github.remote.pushes.length),
        (count) => count > 0,
        { label: "the retry pushed", step: "5 seconds", timeoutMs: 10_000 },
      )
      expect(github.remote.pushes).toEqual([CANDIDATE])
      yield* waitFor(
        home.sql(runRow(run)),
        (row) =>
          Option.exists(row, (found) => (found.pending_json ?? "").includes('"generation":1')),
        10_000,
        "the run recorded the push",
      )
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
  )
})

// ── the shipped orchestrate machine ─────────────────────────────────────────

const UNIT_VERDICTS = new Map([
  ["plan", "ready"],
  ["implement", "ready"],
  ["fix", "ready"],
  ["resume", "ready"],
  ["review", "accepted"],
  ["verify", "pass"],
])

/** What a unit round does in the unit's checkout before it replies: commits, unit dir files. */
type UnitAct = (cwd: string, dir: string) => Effect.Effect<void>

/**
 * Each round replies the verdict `verdicts` names for its `state:visit`, else
 * its state's happy one, with a file of its own, after the act `acts` names
 * for it, once.
 */
const unitWorker =
  (
    verdicts: Readonly<Record<string, string>>,
    extras: Readonly<Record<string, Readonly<Record<string, Schema.Json>>>> = {},
    acts: Readonly<Record<string, UnitAct>> = {},
    cwd = "",
  ) =>
  (round: RoundCall): Effect.Effect<WorkerStream> => {
    const at = `${round.state}:${round.visit}`
    const next = verdicts[at] ?? UNIT_VERDICTS.get(round.state) ?? "unknown"
    const file = `${round.state}-${round.visit}.md`
    const reply = replyWith(round, { ...extras[at], next, file })
    const act = acts[at]
    if (Predicate.isUndefined(act) || acted(round.prompt)) return Effect.succeed(reply)
    return Effect.as(act(cwd, `${cwd}/unit`), reply)
  }

/**
 * The orchestrate machine's config roles: a round's model names its role.
 * The reviewer is against the implementor, so it runs Sol, not Opus.
 */
const unitTiers = () =>
  tieredAccount({
    planner: [OPUS],
    implementor: [HAIKU],
    codemod: [SONNET],
    reviewer: [OPUS, SOL],
    "deep-reviewer": [OPUS, LUNA],
    verifier: [HAIKU],
    "live-verifier": [OPUS],
  })

/** Answers the owner's `count`-th ask with `choice`, and returns that ask. */
const answerAsk = (
  client: Client,
  owner: SessionKey,
  count: number,
  choice: string,
  note?: string,
) =>
  Effect.gen(function* () {
    const ask = yield* askDetails(client, owner, count)
    const [answered] = yield* call(client, owner, [
      [
        "machine.answer",
        `answer-${count}-${choice}`,
        { run: ask.run, askId: ask.askId, choice, ...omitUndefined({ note }) },
      ],
    ])
    expect(answered?.failed).toBe(false)
    return ask
  })

/** A unit run in a real unit dir under the home's cwd; an empty gate is the unit with none named. */
const unitRun = (
  verdicts: Readonly<Record<string, string>>,
  options: {
    readonly gate?: string
    readonly mergeGate?: string
    readonly definition?: MachineDefinitionJson
    /** Reply fields beside the verdict, by `state:visit`. */
    readonly extras?: Readonly<Record<string, Readonly<Record<string, Schema.Json>>>>
    /** What a round does before it replies, by `state:visit`. */
    readonly acts?: Readonly<Record<string, UnitAct>>
  } = {},
) =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const dir = `${home.cwd}/unit`
    yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(dir)).pipe(
      Effect.provide(BunServices.layer),
    )
    const models = yield* makeModels(unitWorker(verdicts, options.extras, options.acts, home.cwd))
    // The merge pushes, so machine.start checks its remote; the unit's gate spawns for real.
    const github = yield* fakeGitHub()
    const processes = Layer.provide(github.layerOverReal, BunServices.layer)
    const { client } = yield* createRpcClient(
      home.layerFor(machineModels(models), {
        ...unitTiers(),
        extensionInputs: [githubBoundary(processes)],
      }),
    )
    const owner = ownerOf(yield* client.session.create({}))
    const { gate = "", mergeGate = "", definition = ORCHESTRATE_MACHINE } = options
    const input = { unit: "u1", goal: "G", dir, gate, mergeGate }
    const run = yield* startRun(client, owner, definition, definition.name, input)
    return { home, models, client, owner, run, dir }
  })

const fileExists = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(file)).pipe(
    Effect.provide(BunServices.layer),
  )

/** A diagnosis with text under both headings the decide ask requires. */
const DIAGNOSIS = [
  "# Diagnosis",
  "",
  "## Premise",
  "",
  "The parser reads one token per line.",
  "",
  "## Counterexample",
  "",
  "A line with two tokens: parser.ts:12 drops the second.",
  "",
].join("\n")

/** Writes the unit dir's diagnosis.md. */
const writeDiagnosis = (dir: string, content: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(`${dir}/diagnosis.md`, content),
  ).pipe(Effect.provide(BunServices.layer))

/** Moves the file's mtime `ahead` seconds past now, its text kept: a touch. */
const touchFile = (file: string, ahead: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const at = (yield* Clock.currentTimeMillis) / 1000 + ahead
    yield* fs.utimes(file, at, at)
  }).pipe(Effect.provide(BunServices.layer))

/** Removes a file or a dir and all it holds. */
const removePath = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(target, { recursive: true })).pipe(
    Effect.provide(BunServices.layer),
  )

/** Answers `ask` with `choice`, and returns the call's result, refused or not. */
const tryAnswer = (
  client: Client,
  owner: SessionKey,
  ask: typeof AskDetails.Type,
  choice: string,
  id: string,
) =>
  Effect.map(
    call(client, owner, [["machine.answer", id, { run: ask.run, askId: ask.askId, choice }]]),
    ([result]) => result,
  )

describe("the shipped orchestrate machine", () => {
  it.live(
    "plans, implements, reviews and verifies a unit, each role on its config role, then decides",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run, dir } = yield* unitRun({})
        const approve = yield* answerAsk(client, owner, 1, "go")
        expect(approve).toMatchObject({ state: "approve", choices: ["go", "replan", "drop"] })
        const decide = yield* answerAsk(client, owner, 2, "drop")
        expect(decide).toMatchObject({
          state: "decide",
          reason: "asked",
          choices: ["merge", "fix", "changes", "replan", "rewrite", "drop", "recheck"],
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→repeats",
          "repeats→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        // The reviewer leaves Opus, the implementor's maker's, for Sol.
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS, HAIKU, SOL, HAIKU])
        expect(yield* Ref.get(models.calls)).toEqual([
          "plan:1",
          "implement:1",
          "review:1",
          "verify:1",
        ])
        // The reviewer and the verifier read the spec and the newest request in the unit dir.
        const texts = new Map(yield* Ref.get(models.texts))
        for (const round of ["review:1", "verify:1"]) {
          expect(texts.get(round)).toContain(`Spec: ${dir}/spec.md`)
          expect(texts.get(round)).toContain("the newest round-N-request.md")
        }
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a deep unit's first review runs the deep reviewer, and an interactive unit's check the live verifier",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun(
          { "review:1": "changes" },
          { extras: { "plan:1": { path: "deep", interactive: true } } },
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→repeats",
          "repeats→review",
          "review→fix",
          "fix→repeats",
          "repeats→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        // The planner is told the exact values a switch reads.
        expect(new Map(yield* Ref.get(models.texts)).get("plan:1")).toContain(
          'path ("deep" or "standard") and interactive (true or false)',
        )
        // Review 1 runs deep-reviewer, against the implementor (Luna, not Opus);
        // review 2 the reviewer (Sol); verify the live verifier (Opus).
        expect(roundsRan(steps).map((round) => round.model)).toEqual([
          OPUS,
          HAIKU,
          LUNA,
          HAIKU,
          SOL,
          OPUS,
        ])
        // Each round keeps the config role it ran, which the cheapest rank reads.
        expect(
          steps.filter((step) => step._tag === "RoundEnded").map((step) => step.configRole),
        ).toEqual([
          "planner",
          "implementor",
          "deep-reviewer",
          "implementor",
          "reviewer",
          "live-verifier",
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a proven review goes to decide with no verifier round",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun({ "review:1": "proven" })
        yield* answerAsk(client, owner, 1, "go")
        const decide = yield* answerAsk(client, owner, 2, "drop")
        expect(decide.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→repeats",
          "repeats→review",
          "review→decide",
          "decide→dropped",
        ])
        expect(yield* Ref.get(models.calls)).toEqual(["plan:1", "implement:1", "review:1"])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "the light machine starts at implement, and a fix goes to decide with no second review",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun(
          { "review:1": "changes" },
          { definition: ORCHESTRATE_LIGHT_MACHINE },
        )
        const decide = yield* answerAsk(client, owner, 1, "drop")
        expect(decide.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "implement→repeats",
          "repeats→review",
          "review→fix",
          "fix→fix-repeats",
          "fix-repeats→decide",
          "decide→dropped",
        ])
        expect(yield* Ref.get(models.calls)).toEqual(["implement:1", "review:1", "fix:1"])
        // The light implementor runs the codemod role; the reviewer leaves its maker.
        expect(roundsRan(steps).map((round) => round.model)).toEqual([SONNET, SOL, SONNET])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "only failed rounds count toward the cap: a blocked round does not, and the third failed round goes to decide",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun({
          "implement:1": "blocked",
          "review:1": "changes",
          "verify:1": "fail",
          "review:3": "changes",
        })
        yield* answerAsk(client, owner, 1, "go")
        const blocked = yield* answerAsk(client, owner, 2, "resume")
        expect(blocked).toMatchObject({ state: "blocked", choices: ["resume", "replan", "drop"] })
        const decide = yield* answerAsk(client, owner, 3, "drop")
        expect(decide.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→blocked",
          "blocked→resume",
          "resume→repeats",
          "repeats→review",
          "review→fix",
          "fix→repeats",
          "repeats→review",
          "review→verify",
          "verify→fix",
          "fix→repeats",
          "repeats→review",
          "review→fix",
          "fix→decide",
          "decide→dropped",
        ])
        expect(yield* Ref.get(models.calls)).toEqual([
          "plan:1",
          "implement:1",
          "resume:1",
          "review:1",
          "fix:1",
          "review:2",
          "verify:1",
          "fix:2",
          "review:3",
        ])
        // One implementor through the unit: the fresh first round's thread is
        // the role's, and resume and fix continue it. Review is fresh each time.
        const [, impl1, resume1, rev1, fix1, rev2, , fix2] = roundThreads(steps)
        expect([resume1, fix1, fix2]).toEqual([impl1, impl1, impl1])
        expect(rev2).not.toBe(rev1)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "at the fix cap, rewrite waits for a diagnosis changed since this decide, with text under both headings",
    () =>
      Effect.gen(function* () {
        const file = (dir: string) => `${dir}/diagnosis.md`
        const { home, client, owner, run, dir } = yield* unitRun(
          { "review:1": "changes", "verify:1": "fail", "review:3": "changes" },
          // A diagnosis from an earlier approach is in the unit dir before the ask.
          {
            acts: {
              "review:3": (_cwd, unitDir) => Effect.orDie(writeDiagnosis(unitDir, DIAGNOSIS)),
            },
          },
        )
        yield* answerAsk(client, owner, 1, "go")
        const decide = yield* askDetails(client, owner, 2)
        expect(decide.state).toBe("decide")
        // The ask names the file, its headings and the choices it guards, in its text and details.
        expect(askText((yield* client.session.getSnapshot(owner)).messages)).toContain(
          `Before changes, replan, rewrite: write ${file(dir)} with text under the headings Premise, Counterexample; the run refuses those choices until it holds them, changed since this ask.`,
        )
        expect(decide.requires).toEqual({
          file: file(dir),
          headings: ["Premise", "Counterexample"],
          choices: ["changes", "replan", "rewrite"],
        })
        const refusal = (id: string) =>
          Effect.map(tryAnswer(client, owner, decide, "rewrite", id), (result) => {
            expect(result?.failed).toBe(true)
            return encodeJson(result?.result)
          })
        const stale = yield* refusal("stale")
        expect(stale).toContain(
          `(unmet): rewrite needs ${file(dir)} with text under Premise, Counterexample, changed since this ask: unchanged since the ask`,
        )
        // A touch gives the stale text a new mtime: still the same text.
        yield* touchFile(file(dir), 120)
        expect(yield* refusal("touched")).toContain("unchanged since the ask")
        yield* removePath(file(dir))
        expect(yield* refusal("none")).toContain("no file")
        yield* writeDiagnosis(dir, DIAGNOSIS.slice(0, DIAGNOSIS.indexOf("## Counterexample")))
        expect(yield* refusal("no-counterexample")).toContain("no heading Counterexample")
        yield* writeDiagnosis(dir, `${DIAGNOSIS.slice(0, DIAGNOSIS.indexOf("A line"))}\n## Notes\n`)
        expect(yield* refusal("empty-counterexample")).toContain("nothing under Counterexample")
        // The stale text copied back is the text the ask saw.
        yield* writeDiagnosis(dir, DIAGNOSIS)
        expect(yield* refusal("copied")).toContain("unchanged since the ask")
        // Each refusal kept the run at the same ask.
        expect(Option.getOrThrow(yield* home.sql(runRow(run)))).toMatchObject({
          state: "decide",
          status: "asking",
        })
        yield* writeDiagnosis(dir, `${DIAGNOSIS}The second approach split lines the same way.\n`)
        yield* answerAsk(client, owner, 2, "rewrite")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run))).slice(-2)).toEqual([
          "fix→decide",
          "decide→rewrite",
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a decide after an accepted review and a passed verify needs no diagnosis",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun({})
        yield* answerAsk(client, owner, 1, "go")
        const decide = yield* answerAsk(client, owner, 2, "rewrite")
        expect(decide.state).toBe("decide")
        expect(askText((yield* client.session.getSnapshot(owner)).messages)).not.toContain(
          "Before changes",
        )
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run))).slice(-2)).toEqual([
          "verify→decide",
          "decide→rewrite",
        ])
        expect(yield* fileExists(`${dir}/diagnosis.md`)).toBe(false)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a stuck review goes to decide, and changes there, after a diagnosis, start a new implementor that later fixes continue",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run, dir } = yield* unitRun({
          "review:1": "stuck",
          "review:2": "changes",
          "verify:1": "stuck",
        })
        yield* answerAsk(client, owner, 1, "go")
        // After stuck, a new direction waits for the diagnosis.
        const stuck = yield* askDetails(client, owner, 2)
        const replan = yield* tryAnswer(client, owner, stuck, "replan", "replan-early")
        expect(encodeJson(replan?.result)).toContain(`(unmet): replan needs ${dir}/diagnosis.md`)
        yield* writeDiagnosis(dir, DIAGNOSIS)
        const first = yield* answerAsk(client, owner, 2, "changes", "split the parser")
        expect(first.state).toBe("decide")
        const second = yield* answerAsk(client, owner, 3, "drop")
        expect(second.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→repeats",
          "repeats→review",
          "review→decide",
          "decide→implement",
          "implement→repeats",
          "repeats→review",
          "review→fix",
          "fix→repeats",
          "repeats→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        const texts = new Map(yield* Ref.get(models.texts))
        expect(texts.get("implement:2")).toContain("split the parser")
        // The new implementor reads the diagnosis, so its approach leaves the failed premise.
        expect(texts.get("implement:2")).toContain(
          "read the spec, state.md, diagnosis.md when the unit dir holds it,",
        )
        const [, impl1, , impl2, , fix1] = roundThreads(steps)
        expect(impl2).not.toBe(impl1)
        expect(fix1).toBe(impl2)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a diagnosis owed at the fix cap is owed at the next decide too, though a check error entered it",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun({
          "review:1": "changes",
          "verify:1": "fail",
          "review:3": "changes",
        })
        yield* answerAsk(client, owner, 1, "go")
        expect((yield* askDetails(client, owner, 2)).requires?.choices).toContain("rewrite")
        expect((yield* home.sql(storedRun(run))).owed).toEqual(new Set(["decide"]))
        // The unit dir is lost, so the recheck cannot run: decide again, by error.
        yield* removePath(dir)
        yield* answerAsk(client, owner, 2, "recheck")
        const again = yield* askDetails(client, owner, 3)
        expect(again.state).toBe("decide")
        const steps = yield* home.sql(stepsOf(run))
        expect(steps.filter((step) => step._tag === "Moved").at(-1)).toMatchObject({
          from: "repeats",
          to: "decide",
          by: "error",
        })
        expect(again.requires?.file).toBe(`${dir}/diagnosis.md`)
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(dir)).pipe(
          Effect.provide(BunServices.layer),
        )
        const refused = yield* tryAnswer(client, owner, again, "rewrite", "rewrite-early")
        expect(refused?.failed).toBe(true)
        expect(encodeJson(refused?.result)).toContain("no file")
        yield* writeDiagnosis(dir, DIAGNOSIS)
        yield* answerAsk(client, owner, 3, "rewrite")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run))).slice(-4)).toEqual([
          "fix→decide",
          "decide→repeats",
          "repeats→decide",
          "decide→rewrite",
        ])
        // The answer that met it paid the debt.
        expect((yield* home.sql(storedRun(run))).owed).toEqual(new Set())
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a decide after a check error with no diagnosis owed admits rewrite with no file",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun(
          {},
          // The unit dir is lost before the first repeat-test check.
          { acts: { "implement:1": (_cwd, unitDir) => Effect.orDie(removePath(unitDir)) } },
        )
        yield* answerAsk(client, owner, 1, "go")
        const decide = yield* answerAsk(client, owner, 2, "rewrite")
        expect(decide.state).toBe("decide")
        expect(decide.requires).toBeUndefined()
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run))).slice(-2)).toEqual([
          "repeats→decide",
          "decide→rewrite",
        ])
        expect(yield* fileExists(`${dir}/diagnosis.md`)).toBe(false)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "the light machine's decide at its fix cap waits for a diagnosis; its decides before the cap do not",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun(
          { "review:1": "changes" },
          { definition: ORCHESTRATE_LIGHT_MACHINE },
        )
        for (const count of [1, 2]) {
          const decide = yield* answerAsk(client, owner, count, "fix", "the check is red")
          expect(decide.requires).toBeUndefined()
        }
        const capped = yield* askDetails(client, owner, 3)
        expect(capped.requires?.choices).toEqual(["changes", "replan", "rewrite"])
        const refused = yield* tryAnswer(client, owner, capped, "rewrite", "rewrite-early")
        expect(refused?.failed).toBe(true)
        expect(encodeJson(refused?.result)).toContain(`rewrite needs ${dir}/diagnosis.md`)
        yield* writeDiagnosis(dir, DIAGNOSIS)
        yield* answerAsk(client, owner, 3, "rewrite")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run))).slice(-2)).toEqual([
          "fix→decide",
          "decide→rewrite",
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "merge runs the unit's gate first: a unit with no gate goes back to the implementor, never to the push",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun({ "resume:1": "blocked" })
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "merge")
        // The gate failed, so the unit went back to the implementor, whose round is blocked.
        expect(yield* askDetails(client, owner, 3)).toMatchObject({
          state: "blocked",
          choices: ["resume", "replan", "drop"],
        })
        yield* answerAsk(client, owner, 3, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→repeats",
          "repeats→review",
          "review→verify",
          "verify→decide",
          "decide→gate",
          "gate→resume",
          "resume→blocked",
          "blocked→dropped",
        ])
        // The empty gate never parsed: the engine's log of the gate holds only bash's refusal.
        const log = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(`${dir}/merge-gate-1.log`),
        ).pipe(Effect.provide(BunServices.layer))
        expect(log).toContain("syntax error")
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "merge runs a named gate into the unit dir and goes on to the push",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun(
          {},
          { gate: "echo gate-ran", mergeGate: "echo slow-ran" },
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "merge")
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => moves(steps).includes("gate→merge"),
          10_000,
          "the gate passed to the push",
        )
        // The merge-only legs run once here, after the round gate.
        const log = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.readFileString(`${dir}/merge-gate-1.log`),
        ).pipe(Effect.provide(BunServices.layer))
        expect(log.trim().split("\n")).toEqual(["gate-ran", "slow-ran"])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  // Each fails the merge gate before anything after the failure runs.
  const redGates = [
    {
      name: "a red round gate",
      gate: "echo gate-ran; false",
      mergeGate: "echo slow-ran",
      log: ["gate-ran"],
    },
    {
      name: "a round gate red under its own set -e",
      gate: "set -e\nfalse\necho wrongly-green",
      mergeGate: "echo slow-ran",
      log: [],
    },
    {
      name: "a red merge-only leg",
      gate: "echo gate-ran",
      mergeGate: "false\necho masked",
      log: ["gate-ran"],
    },
  ]
  for (const red of redGates) {
    it.live(
      `${red.name} fails the merge gate and goes back to the implementor`,
      () =>
        Effect.gen(function* () {
          const { home, client, owner, run, dir } = yield* unitRun(
            { "resume:1": "blocked" },
            { gate: red.gate, mergeGate: red.mergeGate },
          )
          yield* answerAsk(client, owner, 1, "go")
          yield* answerAsk(client, owner, 2, "merge")
          yield* waitFor(
            home.sql(stepsOf(run)),
            (steps) => moves(steps).includes("gate→resume"),
            10_000,
            "the red gate went back to the implementor",
          )
          const log = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.readFileString(`${dir}/merge-gate-1.log`),
          ).pipe(Effect.provide(BunServices.layer))
          expect(log.split("\n").filter((line) => line.length > 0)).toEqual(red.log)
        }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
      45_000,
    )
  }

  it.live(
    "a red merge gate counts against the implementor's round, past the repeat-test check before review",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run } = yield* unitRun(
          { "resume:1": "blocked" },
          { gate: "false" },
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "merge")
        yield* answerAsk(client, owner, 3, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toContain("gate→resume")
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), {
          run: decodeRunId(run),
        })
        const checks = status.quality.map((row) => [String(row.state), row.model, row.checks])
        // The repeat-test check judges no round: the red gate judges every round since the run's start.
        expect(checks).toEqual([
          ["implement", HAIKU, { pass: 0, fail: 1 }],
          ["plan", OPUS, { pass: 0, fail: 1 }],
          ["resume", HAIKU, { pass: 0, fail: 0 }],
          ["review", SOL, { pass: 0, fail: 1 }],
          ["verify", HAIKU, { pass: 0, fail: 1 }],
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a red acceptance check at decide is a fix, a counted round: the third goes back to decide",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun(
          { "review:1": "changes" },
          { definition: ORCHESTRATE_LIGHT_MACHINE },
        )
        for (const count of [1, 2]) {
          const decide = yield* answerAsk(
            client,
            owner,
            count,
            "fix",
            "the acceptance check is red",
          )
          expect(decide.state).toBe("decide")
        }
        const last = yield* answerAsk(client, owner, 3, "drop")
        expect(last.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        // The second fix from decide is the third failed round: the cap sends it back with no call.
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "implement→repeats",
          "repeats→review",
          "review→fix",
          "fix→fix-repeats",
          "fix-repeats→decide",
          "decide→fix",
          "fix→fix-repeats",
          "fix-repeats→decide",
          "decide→fix",
          "fix→decide",
          "decide→dropped",
        ])
        expect(yield* Ref.get(models.calls)).toEqual(["implement:1", "review:1", "fix:1", "fix:2"])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )
})

// ── the repeat-test check ───────────────────────────────────────────────────

/** git in the unit's checkout, with a fixed identity and no hooks; a failure fails the test. */
const unitGit = (cwd: string, args: ReadonlyArray<string>) =>
  runProcess("git", [
    "-C",
    cwd,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.succeed(result.stdout.trim())
      return Effect.die(`git ${args.join(" ")}: ${result.stderr}`)
    }),
    Effect.provide(BunServices.layer),
    Effect.orDie,
  )

/** Writes `files`, by path from `root`. */
const writeFiles = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const [name, content] of Object.entries(files)) {
      yield* fs.writeFileString(`${root}/${name}`, content)
    }
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie)

/** Writes `files` in the checkout and commits them. */
const commitFiles = (cwd: string, files: Readonly<Record<string, string>>, message: string) =>
  Effect.gen(function* () {
    yield* writeFiles(cwd, files)
    yield* unitGit(cwd, ["add", "--", ...Object.keys(files)])
    yield* unitGit(cwd, ["commit", "-q", "-m", message])
  })

const readUnitFile = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.provide(BunServices.layer),
  )

/** The repeat test's name, which its output prints, as a reporter that lists tests does. */
const TEST_NAME = "the parser keeps every line"

/** A check script: `fixed` runs on the full fix, `unfixed` before it. */
const checkScript = (fixed: string, unfixed: string) => ({
  "check.sh": `if grep -q "keeps every line" parser.txt; then\n${fixed}\nelse\n${unfixed}\nfi\n`,
})

/** The test the fix round names for the repeat: green only on the full fix, naming itself in both runs. */
const REPEAT_CHECK = checkScript(`echo "${TEST_NAME}: ok"`, `echo "${TEST_NAME}: failed"; exit 1`)
const FULL_FIX = { "parser.txt": "keeps every line\n" }
const REPEAT_LINE = `Repeat test: r1 M1 check.sh -- bash check.sh :: ${TEST_NAME}`
const SHOWN = `r1 M1 \`${TEST_NAME}\` (bash check.sh)`

/**
 * A unit whose second review finds a repeat of the first review's Major
 * (or, with `secondFindings`, other findings), and whose second fix does
 * `fix2`. Round 1 implements a case fix, round 2 fixes one more case.
 */
const repeatUnit = (fix2: UnitAct, secondFindings?: string) =>
  unitRun(
    { "review:1": "changes", "review:2": "changes" },
    {
      acts: {
        "plan:1": (cwd) =>
          Effect.gen(function* () {
            yield* unitGit(cwd, ["init", "-q", "-b", "main"])
            yield* commitFiles(
              cwd,
              { ".gitignore": "unit/\n", "parser.txt": "drops the last line\n" },
              "base",
            )
          }),
        "implement:1": (_cwd, dir) => writeFiles(dir, { "round-1-request.md": "Round 1\n" }),
        "review:1": (_cwd, dir) =>
          writeFiles(dir, {
            "round-1-findings.md":
              "Verdict: CHANGES REQUIRED\n\n## Major\n\n- M1 parser.txt:1 the parser drops the last line.\n",
          }),
        "fix:1": (cwd, dir) =>
          Effect.gen(function* () {
            yield* commitFiles(cwd, { "parser.txt": "keeps the last line once\n" }, "fix: M1")
            yield* writeFiles(dir, { "round-2-request.md": "Round 2\nM1 fixed\n" })
          }),
        "review:2": (_cwd, dir) =>
          writeFiles(dir, {
            "round-2-findings.md":
              secondFindings ??
              "Verdict: CHANGES REQUIRED\n\n## Major\n\n- M2 parser.txt:1 the parser drops the last line after a blank line, repeat of r1 M1.\n\n## Minor\n\n- n1 a nit.\n",
          }),
        "fix:2": fix2,
      },
    },
  )

/** The moves of a repeat unit through its second fix. */
const REPEAT_UNIT_MOVES = [
  "plan→approve",
  "approve→implement",
  "implement→repeats",
  "repeats→review",
  "review→fix",
  "fix→repeats",
  "repeats→review",
  "review→fix",
  "fix→repeats",
]

/** A second fix that commits `check` with the full fix and names it on the repeat line. */
const fixWith = (check: Readonly<Record<string, string>>) => (cwd: string, dir: string) =>
  Effect.gen(function* () {
    yield* commitFiles(cwd, check, "test: the repeat of M1")
    yield* commitFiles(cwd, FULL_FIX, "fix: every line")
    yield* writeFiles(dir, { "round-3-request.md": `Round 3\n${REPEAT_LINE}\n` })
  })

/** The clean checkouts are gone, from the disk and from git. */
const checkoutsGone = (home: { readonly cwd: string }, dir: string) =>
  Effect.gen(function* () {
    expect(yield* fileExists(`${dir}/repeat-check`)).toBe(false)
    expect((yield* unitGit(home.cwd, ["worktree", "list"])).split("\n")).toHaveLength(1)
  })

/** A second fix whose check fails goes back to fix: the third failed round, so on to decide. */
const failedCheck = (fix2: UnitAct, reason: string) =>
  Effect.gen(function* () {
    const { home, models, client, owner, run, dir } = yield* repeatUnit(fix2)
    yield* answerAsk(client, owner, 1, "go")
    const decide = yield* answerAsk(client, owner, 2, "drop")
    expect(decide.state).toBe("decide")
    yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
    expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
      ...REPEAT_UNIT_MOVES,
      "repeats→fix",
      "fix→decide",
      "decide→dropped",
    ])
    expect(yield* Ref.get(models.calls)).not.toContain("review:3")
    const record = yield* readUnitFile(`${dir}/round-3-repeat-check.md`)
    expect(record).toStartWith("Verdict: FAIL\n")
    expect(record).toContain(reason)
    // The implementor reads the check's record before its next edit.
    expect(new Map(yield* Ref.get(models.texts)).get("fix:2")).toContain("round-*-repeat-check.md")
    yield* checkoutsGone(home, dir)
  })

/** A second fix whose check passes goes on to review: the moves to the end. */
const PASSED_MOVES = [
  ...REPEAT_UNIT_MOVES,
  "repeats→review",
  "review→verify",
  "verify→decide",
  "decide→dropped",
]

describe("the repeat-test check of the orchestrate machine", () => {
  it.live(
    "a repeat whose test fails at the reviewed head and passes at the new head goes on to review",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* repeatUnit((cwd, unitDir) =>
          Effect.gen(function* () {
            yield* fixWith(REPEAT_CHECK)(cwd, unitDir)
            // A bulleted line names the test too.
            yield* writeFiles(unitDir, { "round-3-request.md": `Round 3\n- ${REPEAT_LINE}\n` })
          }),
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual(PASSED_MOVES)
        const record = yield* readUnitFile(`${dir}/round-3-repeat-check.md`)
        expect(record).toStartWith("Verdict: PASS\n")
        // The base is the head review 2 saw: the second check's own Head line.
        const reviewed = yield* readUnitFile(`${dir}/round-2-repeat-check.md`)
        const head = /^Head: (\S+)$/m.exec(reviewed)?.[1] ?? "none"
        expect(record).toContain(`Reviewed head: ${head}`)
        expect(yield* readUnitFile(`${dir}/repeat-check-3-evidence/1-base.log`)).toBe(
          `${TEST_NAME}: failed\n`,
        )
        expect(yield* readUnitFile(`${dir}/repeat-check-3-evidence/1-head.log`)).toBe(
          `${TEST_NAME}: ok\n`,
        )
        yield* checkoutsGone(home, dir)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a failed repeat check judges the implementor's rounds; a passed one leaves them to the merge gate",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run } = yield* unitRun(
          { "review:1": "changes" },
          {
            gate: "true",
            acts: {
              "plan:1": (cwd) =>
                Effect.gen(function* () {
                  yield* unitGit(cwd, ["init", "-q", "-b", "main"])
                  yield* commitFiles(
                    cwd,
                    { ".gitignore": "unit/\n", "parser.txt": "drops the last line\n" },
                    "base",
                  )
                }),
              "implement:1": (_cwd, dir) => writeFiles(dir, { "round-1-request.md": "Round 1\n" }),
              "review:1": (_cwd, dir) =>
                writeFiles(dir, {
                  "round-1-findings.md":
                    "Verdict: CHANGES REQUIRED\n\n## Major\n\n- M2 parser.txt:1 the parser drops the last line after a blank line, repeat of r1 M1.\n",
                }),
              // The first fix names no test for the repeat: the check fails it.
              "fix:1": (_cwd, dir) =>
                writeFiles(dir, { "round-2-request.md": "Round 2\nM2 fixed\n" }),
              "fix:2": fixWith(REPEAT_CHECK),
            },
          },
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "merge")
        yield* waitFor(
          home.sql(stepsOf(run)),
          (steps) => moves(steps).includes("gate→merge"),
          10_000,
          "the gate passed to the push",
        )
        expect(moves(yield* home.sql(stepsOf(run))).slice(2, 10)).toEqual([
          "implement→repeats",
          "repeats→review",
          "review→fix",
          "fix→repeats",
          "repeats→fix",
          "fix→repeats",
          "repeats→review",
          "review→verify",
        ])
        const status = yield* machinesRequest(client, owner, ref(MachinesRpc.Status), {
          run: decodeRunId(run),
        })
        const checks = status.quality.map((row) => [String(row.state), row.model, row.checks])
        // The failed check judged every round before it; the passed checks
        // judged none, so the green gate judged the second fix, the second
        // review and the verify.
        expect(checks).toEqual([
          ["fix", HAIKU, { pass: 1, fail: 1 }],
          ["implement", HAIKU, { pass: 0, fail: 1 }],
          ["plan", OPUS, { pass: 0, fail: 1 }],
          ["review", SOL, { pass: 1, fail: 1 }],
          ["verify", HAIKU, { pass: 1, fail: 0 }],
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a killed run's worktrees under the check's directory are cleared by the next check",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* repeatUnit((cwd, unitDir) =>
          Effect.gen(function* () {
            yield* fixWith(REPEAT_CHECK)(cwd, unitDir)
            // A killed check left its base checkout, and one more, registered.
            for (const name of ["base", "stale"]) {
              yield* unitGit(cwd, [
                "worktree",
                "add",
                "-q",
                "--detach",
                `${unitDir}/repeat-check/${name}`,
              ])
            }
          }),
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual(PASSED_MOVES)
        expect(yield* readUnitFile(`${dir}/round-3-repeat-check.md`)).toStartWith("Verdict: PASS\n")
        yield* checkoutsGone(home, dir)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  // Each second fix names a test the check refuses, for the reason the record gives.
  const refused = [
    {
      name: "a test that passes at the reviewed head",
      check: checkScript(`echo "${TEST_NAME}: ok"`, `echo "${TEST_NAME}: ok"`),
      reason: `${SHOWN} passes at the base`,
    },
    {
      name: "a test the shell could not start at the reviewed head (exit 127)",
      check: checkScript(`echo "${TEST_NAME}: ok"`, "exit 127"),
      reason: `${SHOWN} did not run at the base`,
    },
    {
      name: "a test that fails at the reviewed head with output that does not name it",
      check: checkScript(`echo "${TEST_NAME}: ok"`, 'echo "cannot import the parser"; exit 1'),
      reason:
        "and its output does not name the test: a collection or import failure is no proof the test ran",
    },
    {
      name: "a test that passes at the new head with output that does not name it",
      check: checkScript('echo "0 tests"', `echo "${TEST_NAME}: failed"; exit 1`),
      reason: "and its output does not name the test: no proof the test ran",
    },
  ]
  for (const test of refused) {
    it.live(
      `${test.name} goes back to fix`,
      () =>
        failedCheck(fixWith(test.check), test.reason).pipe(
          Effect.scoped,
          Effect.timeout("40 seconds"),
        ),
      45_000,
    )
  }

  it.live(
    "a test that fails at the new head goes back to fix, its record naming the head",
    () =>
      failedCheck(
        (cwd, dir) =>
          Effect.gen(function* () {
            yield* commitFiles(cwd, REPEAT_CHECK, "test: the repeat of M1")
            yield* writeFiles(dir, { "round-3-request.md": `Round 3\n${REPEAT_LINE}\n` })
          }),
        `${SHOWN} fails at the head`,
      ).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a repeat the request names no test for goes back to fix",
    () =>
      failedCheck(
        (cwd, dir) =>
          Effect.gen(function* () {
            yield* commitFiles(cwd, { ...REPEAT_CHECK, ...FULL_FIX }, "fix: every line")
            yield* writeFiles(dir, { "round-3-request.md": "Round 3\nM2 fixed\n" })
          }),
        "r1 M1 is a repeat in round-2-findings.md, and round-3-request.md names no test for it",
      ).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a reviewed head the check cannot resolve is a check error: decide, which counts nothing, and recheck",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run, dir } = yield* repeatUnit((cwd, unitDir) =>
          Effect.gen(function* () {
            yield* fixWith(REPEAT_CHECK)(cwd, unitDir)
            const record = yield* Effect.orDie(readUnitFile(`${unitDir}/round-2-repeat-check.md`))
            yield* writeFiles(unitDir, {
              "saved-repeat-check.md": record,
              "round-2-repeat-check.md": record.replace(/^Head: .*$/m, `Head: ${"d".repeat(40)}`),
            })
          }),
        )
        yield* answerAsk(client, owner, 1, "go")
        const decide = yield* askDetails(client, owner, 2)
        expect(decide.state).toBe("decide")
        expect(decide.choices).toContain("recheck")
        expect(yield* readUnitFile(`${dir}/round-3-repeat-check.md`)).toStartWith(
          "Verdict: ERROR\n",
        )
        const steps = yield* home.sql(stepsOf(run))
        const moved = steps.filter((step) => step._tag === "Moved").at(-1)
        expect(moved).toMatchObject({ from: "repeats", to: "decide", by: "error" })
        expect(moved?.note).toContain(
          "Check error: the repeats command exited 2, so it gave no verdict.",
        )
        expect(moved?.note).toContain("names no commit of this checkout")
        // The orchestrator repairs the record and reruns the check.
        yield* writeFiles(dir, {
          "round-2-repeat-check.md": yield* readUnitFile(`${dir}/saved-repeat-check.md`),
        })
        yield* answerAsk(client, owner, 2, "recheck")
        yield* answerAsk(client, owner, 3, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          ...REPEAT_UNIT_MOVES,
          "repeats→decide",
          "decide→repeats",
          "repeats→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        expect(yield* readUnitFile(`${dir}/round-3-repeat-check.md`)).toStartWith("Verdict: PASS\n")
        // No implementor round ran for the error: the error counted no failed round.
        expect(yield* Ref.get(models.calls)).not.toContain("fix:3")
        yield* checkoutsGone(home, dir)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  // Second findings with no repeated Blocker or Major: each heading resets the section.
  const skipped = [
    {
      name: "a repeat under Minor",
      findings:
        "Verdict: CHANGES REQUIRED\n\n## Major\n\n- M2 parser.txt:1 a new defect.\n\n## Minor\n\n- n1 a nit, repeat of r1 n1.\n",
    },
    {
      name: "a repeat under Minors after Majors",
      findings:
        "Verdict: CHANGES REQUIRED\n\n## Majors\n\n- M2 parser.txt:1 a new defect.\n\n## Minors\n\n- n1 the same defect, repeat of r1 M1.\n",
    },
    {
      name: "a repeat under Rejected after Major",
      findings:
        "Verdict: CHANGES REQUIRED\n\n## Major\n\n- M2 parser.txt:1 a new defect.\n\n## Rejected\n\n- M1 not a defect after all, repeat of r1 M1.\n",
    },
  ]
  for (const test of skipped) {
    it.live(
      `findings with ${test.name} skip the check`,
      () =>
        Effect.gen(function* () {
          const { home, client, owner, run, dir } = yield* repeatUnit(
            (cwd, unitDir) =>
              Effect.gen(function* () {
                yield* commitFiles(cwd, FULL_FIX, "fix: every line")
                yield* writeFiles(unitDir, { "round-3-request.md": "Round 3\nM2 fixed\n" })
              }),
            test.findings,
          )
          yield* answerAsk(client, owner, 1, "go")
          yield* answerAsk(client, owner, 2, "drop")
          yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
          expect(moves(yield* home.sql(stepsOf(run)))).toEqual(PASSED_MOVES)
          const record = yield* readUnitFile(`${dir}/round-3-repeat-check.md`)
          expect(record).toStartWith("Verdict: SKIP\n")
          expect(yield* fileExists(`${dir}/repeat-check-3-evidence`)).toBe(false)
        }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
      45_000,
    )
  }

  it.live(
    "a repeat under Majors needs its test",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* repeatUnit(
          (cwd, unitDir) =>
            Effect.gen(function* () {
              yield* commitFiles(cwd, FULL_FIX, "fix: every line")
              yield* writeFiles(unitDir, { "round-3-request.md": "Round 3\nM2 fixed\n" })
            }),
          "Verdict: CHANGES REQUIRED\n\n## Minors\n\n- n1 a nit.\n\n## Majors\n\n- M2 the same defect, repeat of r1 M1.\n",
        )
        yield* answerAsk(client, owner, 1, "go")
        yield* answerAsk(client, owner, 2, "drop")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        expect(moves(yield* home.sql(stepsOf(run)))).toContain("repeats→fix")
        expect(yield* readUnitFile(`${dir}/round-3-repeat-check.md`)).toContain(
          "r1 M1 is a repeat in round-2-findings.md, and round-3-request.md names no test for it",
        )
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )
})

// ── pass receipts ───────────────────────────────────────────────────────────

/**
 * A gate that counts its runs in `{{input.count}}`, outside the checkout,
 * and prints `say`; a rerun answer comes back to it. `extra` adds lines to
 * its command; `fields` adds fields to the state, as its `log`.
 */
const receiptGate = (
  name: string,
  say: string,
  extra: ReadonlyArray<string> = [],
  fields: Readonly<Record<string, string>> = {},
) => ({
  name,
  threads: {},
  start: "gate",
  states: {
    gate: {
      kind: "run",
      run: [`echo run >> "{{input.count}}"`, ...extra, `echo "${say}"`].join("\n"),
      ...fields,
      reuse: true,
      on: { pass: "again", fail: "again" },
    },
    again: { kind: "ask", ask: "Again?", on: { rerun: "gate", end: "done" } },
    done: { kind: "final" },
  },
})

/** The lines of the count file: how many times a gate's command ran. */
const runsCounted = (file: string) =>
  Effect.map(
    readUnitFile(file),
    (text) => text.split("\n").filter((line) => line.length > 0).length,
  )

/** The gate's command ends of a run, each reused or not. */
const gateEnds = (home: Effect.Success<typeof restartableHome>, run: string) =>
  Effect.map(home.sql(stepsOf(run)), (steps) =>
    steps.filter((step) => step._tag === "CommandEnded").map((step) => step.reused === true),
  )

describe("a run state's pass receipt", () => {
  it.live(
    "a pass is reused at the same head, command, environment and input tree, and any change runs the command",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
        // machine.define writes the definitions under .gent/machines in the cwd.
        yield* commitFiles(home.cwd, { ".gitignore": ".gent/\n", "a.txt": "one\n" }, "base")
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRun(
          client,
          owner,
          receiptGate("receipts", "gate passed"),
          "receipts",
          {
            count,
          },
        )
        yield* askDetails(client, owner, 1)
        expect(yield* runsCounted(count)).toBe(1)
        // Nothing changed: the kept pass ends the command, which does not run.
        yield* answerAsk(client, owner, 1, "rerun")
        yield* askDetails(client, owner, 2)
        expect(yield* runsCounted(count)).toBe(1)
        const saved = (yield* home.sql(stepsOf(run))).filter(
          (step) => step._tag === "Saved" && step.state === "gate",
        )
        expect(saved[1]?.value).toEqual({
          exitCode: 0,
          timedOut: false,
          output: "gate passed\n",
          reused: true,
        })
        // A new commit with the same tree: a new head.
        yield* unitGit(home.cwd, ["commit", "-q", "--allow-empty", "-m", "empty"])
        yield* answerAsk(client, owner, 2, "rerun")
        yield* askDetails(client, owner, 3)
        expect(yield* runsCounted(count)).toBe(2)
        // A new file git does not ignore: a new input tree at the same head.
        yield* writeFiles(home.cwd, { "b.txt": "new\n" })
        yield* answerAsk(client, owner, 3, "rerun")
        yield* askDetails(client, owner, 4)
        expect(yield* runsCounted(count)).toBe(3)
        // A variable the definition names nowhere: a new environment.
        yield* scopedEnv("CHECK_MODE", "strict")
        yield* answerAsk(client, owner, 4, "rerun")
        yield* askDetails(client, owner, 5)
        expect(yield* runsCounted(count)).toBe(4)
        yield* answerAsk(client, owner, 5, "end")
        expect(yield* gateEnds(home, run)).toEqual([false, true, false, false, false])
        // Another command at the same key runs; the same command in a new run reuses.
        const changed = yield* startRun(
          client,
          owner,
          receiptGate("receipts-changed", "gate passed again"),
          "receipts-changed",
          { count },
        )
        yield* askDetails(client, owner, 6)
        expect(yield* runsCounted(count)).toBe(5)
        yield* answerAsk(client, owner, 6, "end")
        const again = yield* startRun(
          client,
          owner,
          receiptGate("receipts", "gate passed"),
          "receipts",
          { count },
          "receipts-again",
        )
        yield* askDetails(client, owner, 7)
        expect(yield* runsCounted(count)).toBe(5)
        expect(yield* gateEnds(home, changed)).toEqual([false])
        expect(yield* gateEnds(home, again)).toEqual([true])
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
    65_000,
  )

  it.live(
    "a pass whose command changed the checkout keeps no receipt, nor does a red or a cwd outside git",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        // No repository: no key, so each visit runs.
        const loose = yield* startRun(client, owner, receiptGate("loose", "ok"), "loose", { count })
        yield* answerAsk(client, owner, 1, "rerun")
        yield* askDetails(client, owner, 2)
        expect(yield* runsCounted(count)).toBe(2)
        yield* answerAsk(client, owner, 2, "end")
        expect(yield* gateEnds(home, loose)).toEqual([false, false])
        yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
        yield* commitFiles(home.cwd, { ".gitignore": ".gent/\n", "a.txt": "one\n" }, "base")
        // The command writes a file in the checkout as it passes: the tree it
        // started at no longer holds at its end, so it keeps no receipt, even
        // once the tree is back.
        const writer = yield* startRun(
          client,
          owner,
          receiptGate("writer", "ok", ["echo made > made.txt"]),
          "writer",
          { count },
        )
        yield* askDetails(client, owner, 3)
        yield* removePath(`${home.cwd}/made.txt`)
        yield* answerAsk(client, owner, 3, "rerun")
        yield* askDetails(client, owner, 4)
        expect(yield* runsCounted(count)).toBe(4)
        expect(yield* gateEnds(home, writer)).toEqual([false, false])
        yield* answerAsk(client, owner, 4, "end")
        // A red is never kept: a flake would trap the run on it.
        const red = yield* startRun(client, owner, receiptGate("red", "ok", ["exit 1"]), "red", {
          count,
        })
        yield* answerAsk(client, owner, 5, "rerun")
        yield* askDetails(client, owner, 6)
        expect(yield* runsCounted(count)).toBe(6)
        expect(yield* gateEnds(home, red)).toEqual([false, false])
      }).pipe(Effect.scoped, Effect.timeout("60 seconds")),
    65_000,
  )

  it.live(
    "the key holds the command as its visit renders it: a pass ends no other visit",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
        yield* commitFiles(home.cwd, { ".gitignore": ".gent/\n", "a.txt": "one\n" }, "base")
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        // Visit 1 passes; visit 2 renders another command, which fails.
        const run = yield* startRun(
          client,
          owner,
          receiptGate("by-visit", "ok", ["test {{visit}} -eq 1 || exit 1"]),
          "by-visit",
          { count },
        )
        yield* askDetails(client, owner, 1)
        yield* answerAsk(client, owner, 1, "rerun")
        yield* askDetails(client, owner, 2)
        expect(yield* runsCounted(count)).toBe(2)
        expect(yield* gateEnds(home, run)).toEqual([false, false])
        expect(yield* home.sql(savedValue(run, "gate"))).toMatchObject({ exitCode: 1 })
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "the engine writes each visit's log: a reused visit's names the pass it reused and holds its output",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
        yield* commitFiles(home.cwd, { ".gitignore": ".gent/\n", "a.txt": "one\n" }, "base")
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        const run = yield* startRun(
          client,
          owner,
          receiptGate("logged", "gate passed", [], { log: "{{input.logs}}/gate-{{visit}}.log" }),
          "logged",
          { count, logs: home.home },
        )
        yield* askDetails(client, owner, 1)
        yield* answerAsk(client, owner, 1, "rerun")
        yield* askDetails(client, owner, 2)
        expect(yield* gateEnds(home, run)).toEqual([false, true])
        expect(yield* readUnitFile(`${home.home}/gate-1.log`)).toBe("gate passed\n")
        const reused = yield* readUnitFile(`${home.home}/gate-2.log`)
        expect(reused).toContain(
          `gent ran no command on this visit: it reused the pass of run ${run}, visit 1,`,
        )
        expect(reused).toContain("that visit's log holds all of it):\ngate passed\n")
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "the key holds the ignored files: a changed one reruns, and an output the pass wrote still reuses",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
        yield* commitFiles(
          home.cwd,
          { ".gitignore": ".gent/\n*.cache\n*.out\n", "a.txt": "one\n" },
          "base",
        )
        yield* writeFiles(home.cwd, { "input.cache": "one\n" })
        const models = yield* makeModels(trackWorker)
        const { client } = yield* createRpcClient(home.layerFor(machineModels(models)))
        const owner = ownerOf(yield* client.session.create({}))
        // The gate reads an ignored file and writes another.
        const run = yield* startRun(
          client,
          owner,
          receiptGate("ignored", "ok", ["cat input.cache > result.out"]),
          "ignored",
          { count },
        )
        yield* askDetails(client, owner, 1)
        // The output it wrote is part of the key it kept: visit 2 reuses.
        yield* answerAsk(client, owner, 1, "rerun")
        yield* askDetails(client, owner, 2)
        expect(yield* runsCounted(count)).toBe(1)
        // The ignored input changed: visit 3 runs.
        yield* writeFiles(home.cwd, { "input.cache": "two two\n" })
        yield* answerAsk(client, owner, 2, "rerun")
        yield* askDetails(client, owner, 3)
        expect(yield* runsCounted(count)).toBe(2)
        expect(yield* gateEnds(home, run)).toEqual([false, true, false])
        expect(yield* readUnitFile(`${home.cwd}/result.out`)).toBe("two two\n")
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )
})

// ── restack ─────────────────────────────────────────────────────────────────

/**
 * gate (counts its runs) → merge, which pushes to main; a push main moved
 * past restacks and checks again in gate, and a conflict ends in conflicted.
 */
const RESTACK = {
  name: "restack",
  threads: {},
  start: "gate",
  states: {
    gate: {
      kind: "run",
      run: `echo "run {{visit}}" >> "{{input.count}}"`,
      on: { pass: "merge", fail: "broken" },
    },
    merge: {
      kind: "integrate",
      ref: "main",
      on: { green: "done", red: "broken", restack: "gate", conflict: "conflicted" },
    },
    done: { kind: "final" },
    broken: { kind: "final" },
    conflicted: { kind: "final" },
  },
}

/**
 * A bare origin with `shared.txt` on main, the run's checkout on a branch
 * `unit` from it, and a second clone that moves main. The checkout's own
 * config names who commits, so the server's rebase needs no global config.
 */
const restackRepos = (home: Effect.Success<typeof restartableHome>) =>
  Effect.gen(function* () {
    const origin = `${home.home}/origin.git`
    const other = `${home.home}/other`
    yield* unitGit(home.home, ["init", "-q", "--bare", "-b", "main", origin])
    yield* unitGit(home.cwd, ["init", "-q", "-b", "main"])
    for (const [key, value] of [
      ["user.name", "test"],
      ["user.email", "test@example.com"],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", "/dev/null"],
    ] as const) {
      yield* unitGit(home.cwd, ["config", key, value])
    }
    yield* commitFiles(home.cwd, { ".gitignore": ".gent/\n", "shared.txt": "one\n" }, "base")
    yield* unitGit(home.cwd, ["remote", "add", "origin", origin])
    yield* unitGit(home.cwd, ["push", "-q", "origin", "main"])
    yield* unitGit(home.cwd, ["checkout", "-q", "-b", "unit"])
    yield* unitGit(home.home, ["clone", "-q", origin, other])
    return { origin, other, base: yield* unitGit(home.cwd, ["rev-parse", "HEAD"]) }
  })

/** The run's checkout commits `unit`, and the other clone pushes `main` to origin: the moved head. */
const divergeFiles = (
  home: Effect.Success<typeof restartableHome>,
  other: string,
  files: {
    readonly unit: Readonly<Record<string, string>>
    readonly main: Readonly<Record<string, string>>
  },
) =>
  Effect.gen(function* () {
    yield* commitFiles(home.cwd, files.unit, "unit work")
    yield* commitFiles(other, files.main, "main moved")
    yield* unitGit(other, ["push", "-q", "origin", "main"])
    return {
      unit: yield* unitGit(home.cwd, ["rev-parse", "HEAD"]),
      moved: yield* unitGit(other, ["rev-parse", "HEAD"]),
    }
  })

type FakeGitHub = Effect.Success<ReturnType<typeof fakeGitHub>>

/** A server beside the fake GitHub, over real git: the run's restack fetches the real origin. */
const restackLayer = (home: Effect.Success<typeof restartableHome>, github: FakeGitHub) =>
  Effect.map(makeModels(trackWorker), (models) =>
    home.layerFor(machineModels(models), {
      extensionInputs: [githubBoundary(Layer.provide(github.layerOverRealGit, BunServices.layer))],
    }),
  )

const restackClient = (home: Effect.Success<typeof restartableHome>, github: FakeGitHub) =>
  Effect.gen(function* () {
    const { client } = yield* createRpcClient(yield* restackLayer(home, github))
    const owner = ownerOf(yield* client.session.create({}))
    return { client, owner }
  })

/** The integrate's wait for the gate is over: its retry and the run's record come due now. */
const retryDueNow = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE machine_runs SET pending_json = json_remove(pending_json, '$.notBefore')
      WHERE run = ${run}`
    yield* sql`UPDATE branch_wakes SET at = 0, version = version + 1
      WHERE source_id = ${`machine-run:${run}`}`
  })

describe("an integrate state's restack", () => {
  it.live(
    "a push main moved past rebases onto it and runs the gate again, then pushes the rebased head",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        const { other, base } = yield* restackRepos(home)
        const { unit, moved } = yield* divergeFiles(home, other, {
          unit: { "unit.txt": "unit\n" },
          main: { "other.txt": "other\n" },
        })
        const github = yield* fakeGitHub({ head: moved })
        const { client, owner } = yield* restackClient(home, github)
        expect(moved).not.toBe(base)
        const run = yield* startRun(client, owner, RESTACK, "restack", { count })
        yield* waitFor(
          home.sql(runRow(run)),
          (row) =>
            Option.exists(row, (found) => (found.pending_json ?? "").includes('"generation":1')),
          15_000,
          "the gate admitted the rebased push",
        )
        const rebased = yield* unitGit(home.cwd, ["rev-parse", "HEAD"])
        expect(rebased).not.toBe(unit)
        // The rebased head holds main's commit; dies when it does not.
        yield* unitGit(home.cwd, ["merge-base", "--is-ancestor", moved, rebased])
        // One more gate, no round: the gate ran at the old head and at the rebased one.
        expect(yield* runsCounted(count)).toBe(2)
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "gate→merge",
          "merge→gate",
          "gate→merge",
        ])
        expect(yield* home.sql(savedValue(run, "merge"))).toEqual({
          outcome: "restacked",
          from: unit,
          to: rebased,
          onto: moved,
        })
        expect(github.remote.pushes).toEqual([rebased])
        expect(yield* unitGit(other, ["ls-remote", "origin", "refs/heads/main"])).toContain(rebased)
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a rebase that conflicts is aborted and takes conflict, naming the files, with nothing pushed",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        const { other, base } = yield* restackRepos(home)
        const { unit, moved } = yield* divergeFiles(home, other, {
          unit: { "shared.txt": "unit\n" },
          main: { "shared.txt": "main\n" },
        })
        const github = yield* fakeGitHub({ head: moved })
        const { client, owner } = yield* restackClient(home, github)
        expect(moved).not.toBe(base)
        // A conflict edge with no restack could never be taken.
        const { restack: _restack, ...noRestack } = RESTACK.states.merge.on
        const [refused] = yield* call(client, owner, [
          [
            "machine.define",
            "define-conflict-alone",
            {
              definition: {
                ...RESTACK,
                name: "conflict-alone",
                states: { ...RESTACK.states, merge: { ...RESTACK.states.merge, on: noRestack } },
              },
            },
          ],
        ])
        expect(refused?.failed).toBe(true)
        expect(encodeJson(refused?.result)).toContain("merge: on.conflict needs on.restack")
        const run = yield* startRun(client, owner, RESTACK, "restack", { count })
        yield* waitForEnd(client, owner)
        expect(Option.map(yield* home.sql(runRow(run)), (row) => row.state)).toEqual(
          Option.some("conflicted"),
        )
        expect(yield* home.sql(savedValue(run, "merge"))).toMatchObject({
          outcome: "conflict",
          onto: moved,
          files: ["shared.txt"],
        })
        // The abort put the checkout back: its head, its file, and no rebase left open.
        expect(yield* unitGit(home.cwd, ["rev-parse", "HEAD"])).toBe(unit)
        expect(yield* readUnitFile(`${home.cwd}/shared.txt`)).toBe("unit\n")
        const rebaseDir = yield* unitGit(home.cwd, ["rev-parse", "--git-path", "rebase-merge"])
        expect(yield* fileExists(`${home.cwd}/${rebaseDir}`)).toBe(false)
        expect(yield* runsCounted(count)).toBe(1)
        expect(github.remote.pushes).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a head a crash left rebased under a pending push is checked again, not pushed as it stands",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        const { other } = yield* restackRepos(home)
        const { unit, moved } = yield* divergeFiles(home, other, {
          unit: { "unit.txt": "unit\n" },
          main: { "other.txt": "other\n" },
        })
        // gh is signed out: the merge visit holds its push, pinned to the gated head.
        const github = yield* fakeGitHub({ head: moved, gh: "signed-out" })
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, owner } = yield* restackClient(home, github)
            const run = yield* startRun(client, owner, RESTACK, "restack", { count })
            yield* waitFor(
              home.sql(stepsOf(run)),
              (all) => all.some((step) => step._tag === "Waiting"),
              15_000,
              "the push waits for gh",
            )
            return run
          }),
        )
        // As a restack leaves the checkout when the server dies after its rebase, before its move.
        yield* unitGit(home.cwd, ["fetch", "-q", "origin", "main"])
        yield* unitGit(home.cwd, ["rebase", "-q", "FETCH_HEAD"])
        const rebased = yield* unitGit(home.cwd, ["rev-parse", "HEAD"])
        github.remote.gh = "ready"
        yield* home.sql(retryDueNow(run))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* restackLayer(home, github))
            // No client call: the run's own record activates its host.
            yield* waitFor(
              home.sql(runRow(run)),
              (row) =>
                Option.exists(row, (found) =>
                  (found.pending_json ?? "").includes('"generation":1'),
                ),
              15_000,
              "the gate admitted the rebased push",
            )
          }),
        )
        // The pinned head no longer fast-forwards; the head it became is gated first.
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "gate→merge",
          "merge→gate",
          "gate→merge",
        ])
        expect(yield* home.sql(savedValue(run, "merge"))).toEqual({
          outcome: "restacked",
          from: unit,
          to: rebased,
          onto: moved,
        })
        expect(yield* runsCounted(count)).toBe(2)
        expect(github.remote.pushes).toEqual([rebased])
      }).pipe(Effect.scoped, Effect.timeout("50 seconds")),
    55_000,
  )
})

// ── pull requests ───────────────────────────────────────────────────────────

/**
 * merge (integrate main through a PR when `input.via` says `pr`) → done on
 * green, broken on red, declined on a person's no.
 */
const PR_SHIP = {
  name: "pr-ship",
  threads: {},
  start: "merge",
  states: {
    merge: {
      kind: "integrate",
      ref: "main",
      via: "{{input.via}}",
      on: { green: "done", red: "broken", declined: "declined" },
    },
    done: { kind: "final" },
    broken: { kind: "final" },
    declined: { kind: "final" },
  },
}

const prServer = (home: Effect.Success<typeof restartableHome>, github: FakeGitHub) =>
  Effect.map(makeModels(trackWorker), (models) =>
    home.layerFor(machineModels(models), { extensionInputs: [githubBoundary(github.layer)] }),
  )

/** Whether the run's pending integrate recorded PR `pr`. */
const recordsPr = (pr: number) => (row: Option.Option<typeof RunRowView.Type>) =>
  Option.exists(row, (found) => (found.pending_json ?? "").includes(`"pr":${pr}`))

/** A server starts the PR run and stops once the run recorded its open PR. */
const openPrRun = (home: Effect.Success<typeof restartableHome>, github: FakeGitHub) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { client } = yield* createRpcClient(yield* prServer(home, github))
      const owner = ownerOf(yield* client.session.create({}))
      const run = yield* startRun(client, owner, PR_SHIP, "pr-ship", { via: "pr" })
      yield* waitFor(home.sql(runRow(run)), recordsPr(1), 15_000, "the run opened its PR")
      return { owner, run }
    }),
  )

/** A person's time passes while no server runs; the next server reads the PR at once. */
const readPrAfterRestart = (
  home: Effect.Success<typeof restartableHome>,
  github: FakeGitHub,
  run: string,
) =>
  Effect.gen(function* () {
    yield* home.sql(retryDueNow(run))
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRpcClient(yield* prServer(home, github))
        // No client call: the run's own record activates its host, which reads the PR.
        yield* waitFor(
          home.sql(runRow(run)),
          (row) => Option.exists(row, (found) => found.status === "final"),
          15_000,
          "the PR's decision moved the run",
        )
      }),
    )
  })

/**
 * The pending integrate holds no PR, as after a restack: the next visit
 * pushes the run's branch again, leased on the head it recorded last.
 */
const pushAgain = (run: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`UPDATE machine_runs
      SET pending_json = json_remove(pending_json, '$.pr', '$.repo', '$.sha') WHERE run = ${run}`,
  )

/**
 * The record as it stands when the server died after the push landed and
 * gh opened the PR: neither the PR nor the branch's head was recorded.
 */
const crashBeforeRecord = (run: string) =>
  Effect.gen(function* () {
    yield* pushAgain(run)
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM machine_steps WHERE run = ${run}
      AND json_extract(step_json, '$._tag') = 'Recorded'
      AND json_extract(step_json, '$.action.pr') IS NOT NULL`
  })

const APPROVED: Partial<Pr> = {
  reviewDecision: "APPROVED",
  reviews: [{ author: { login: "cevr" }, state: "APPROVED", body: "" }],
  checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
}

/** What a person or GitHub did to the open PR, and the run's end it leads to. */
interface PrCase {
  readonly why: string
  readonly pr: Partial<Pr>
  readonly methods?: { squash: boolean; rebase: boolean; merge: boolean }
  readonly to: string
  readonly saved: Readonly<Record<string, Schema.Json>>
  /** Text the move's note holds. */
  readonly note?: string
  readonly merges: ReadonlyArray<{
    readonly pr: number
    readonly method: string
    readonly sha: string
  }>
}

describe("an integrate state through a pull request", () => {
  it.live(
    "pushes the run's own branch, opens one PR on the ref, and waits for a person with one step",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub()
        const { run } = yield* openPrRun(home, github)
        // main is untouched: the head went to the run's branch alone.
        expect(github.remote.pushes).toEqual([])
        expect([...github.remote.branches]).toEqual([[`gent/${run}`, CANDIDATE]])
        expect(github.remote.prs).toMatchObject([
          { number: 1, head: `gent/${run}`, base: "main", title: SUBJECT, headRefOid: CANDIDATE },
        ])
        const row = Option.getOrThrow(yield* home.sql(runRow(run)))
        expect(row).toMatchObject({ state: "merge", status: "running" })
        const steps = yield* home.sql(stepsOf(run))
        expect(steps.filter((step) => step._tag === "Waiting")).toMatchObject([{ reason: "pr" }])
        expect(moves(steps)).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  for (const decided of [
    {
      why: "approved with green checks merges by squash at the pushed head",
      pr: APPROVED,
      to: "done",
      saved: { outcome: "merged", pr: 1, sha: CANDIDATE, method: "squash" },
      merges: [{ pr: 1, method: "squash", sha: CANDIDATE }],
    },
    {
      why: "approved in a repository without squash merges by rebase",
      pr: APPROVED,
      methods: { squash: false, rebase: true, merge: true },
      to: "done",
      saved: { outcome: "merged", pr: 1, sha: CANDIDATE, method: "rebase" },
      merges: [{ pr: 1, method: "rebase", sha: CANDIDATE }],
    },
    {
      why: "a person merged takes green with no merge of its own",
      pr: { state: "MERGED" },
      to: "done",
      saved: { outcome: "merged", pr: 1, sha: CANDIDATE },
      merges: [],
    },
    {
      why: "changes requested takes declined, quoting the review",
      pr: {
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: { login: "cevr" }, state: "CHANGES_REQUESTED", body: "Rename the flag." },
        ],
      },
      to: "declined",
      saved: { outcome: "declined", pr: 1, reason: "changes" },
      note: '@cevr requested changes: "Rename the flag."',
      merges: [],
    },
    {
      why: "a closed PR takes declined",
      pr: { state: "CLOSED" },
      to: "declined",
      saved: { outcome: "declined", pr: 1, reason: "closed" },
      note: "was closed without a merge",
      merges: [],
    },
    {
      why: "a head the run did not push takes declined",
      pr: { ...APPROVED, headRefOid: OUTSIDE },
      to: "declined",
      saved: { outcome: "declined", pr: 1, reason: "moved" },
      note: `is at ${OUTSIDE}, not the ${CANDIDATE} the run pushed`,
      merges: [],
    },
    {
      why: "merged at a head the run did not push takes declined",
      pr: { state: "MERGED", headRefOid: OUTSIDE },
      to: "declined",
      saved: { outcome: "declined", pr: 1, reason: "moved" },
      note: `was merged at ${OUTSIDE}, not the ${CANDIDATE} the run pushed`,
      merges: [],
    },
    {
      why: "a failed check takes red, naming it",
      pr: { checks: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] },
      to: "broken",
      saved: { outcome: "checks", pr: 1, sha: CANDIDATE, failing: ["test"] },
      merges: [],
    },
    {
      why: "a conflict with no restack edge takes red as conflict",
      pr: { ...APPROVED, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
      to: "broken",
      saved: { outcome: "conflict", onto: "main", files: [] },
      merges: [],
    },
  ] satisfies ReadonlyArray<PrCase>) {
    it.live(
      `a PR ${decided.why}`,
      () =>
        Effect.gen(function* () {
          const home = yield* restartableHome
          const github = yield* fakeGitHub()
          const methods: PrCase["methods"] = decided.methods
          if (Predicate.isNotUndefined(methods)) github.remote.mergeMethods = { ...methods }
          const { run } = yield* openPrRun(home, github)
          Object.assign(github.remote.prs[0] ?? {}, decided.pr)
          yield* readPrAfterRestart(home, github, run)
          expect(Option.map(yield* home.sql(runRow(run)), (row) => row.state)).toEqual(
            Option.some(decided.to),
          )
          expect(yield* home.sql(savedValue(run, "merge"))).toMatchObject(decided.saved)
          expect(github.remote.merges).toEqual([...decided.merges])
          const moved = (yield* home.sql(stepsOf(run))).filter((step) => step._tag === "Moved")
          expect(moved).toMatchObject([{ from: "merge", to: decided.to }])
          const note: PrCase["note"] = decided.note
          if (Predicate.isNotUndefined(note)) expect(moved[0]?.note ?? "").toContain(note)
          // main moved only by GitHub's merge, never by a push.
          expect(github.remote.pushes).toEqual([])
        }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
      45_000,
    )
  }

  it.live("a PR no person approved yet is read again later, with no step and no move", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const { run } = yield* openPrRun(home, github)
      const before = yield* home.sql(stepsOf(run))
      yield* home.sql(retryDueNow(run))
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* createRpcClient(yield* prServer(home, github))
          // The read found no decision: the run's record is armed for the next read.
          yield* waitFor(
            home.sql(runRecords(run)),
            (records) => records.some((at) => Option.exists(at, (time) => time > 0)),
            15_000,
            "the run waits for the next read",
          )
        }),
      )
      expect(yield* home.sql(stepsOf(run))).toEqual(before)
      expect(Option.getOrThrow(yield* home.sql(runRow(run)))).toMatchObject({
        state: "merge",
        status: "running",
      })
      expect(github.remote.merges).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "a crash after the push landed and gh opened the PR finds that PR again, opening no second",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub()
        const { run } = yield* openPrRun(home, github)
        yield* home.sql(crashBeforeRecord(run))
        yield* home.sql(retryDueNow(run))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* prServer(home, github))
            yield* waitFor(home.sql(runRow(run)), recordsPr(1), 15_000, "the run found its PR")
          }),
        )
        expect(github.remote.prs.map((pr) => pr.number)).toEqual([1])
        expect(github.remote.branches.get(`gent/${run}`)).toBe(CANDIDATE)
        expect(github.remote.pushes).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a branch a person deleted is pushed again, with a new PR",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub()
        const { run } = yield* openPrRun(home, github)
        // The lease names the head the run recorded, which the branch no longer has.
        yield* home.sql(pushAgain(run))
        github.remote.branches.delete(`gent/${run}`)
        // GitHub closes the PR of a deleted branch.
        Object.assign(github.remote.prs[0] ?? {}, { state: "CLOSED" })
        yield* home.sql(retryDueNow(run))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* prServer(home, github))
            yield* waitFor(home.sql(runRow(run)), recordsPr(2), 15_000, "the run opened a new PR")
          }),
        )
        expect(github.remote.branches.get(`gent/${run}`)).toBe(CANDIDATE)
        expect(github.remote.prs.map((pr) => [pr.number, pr.state])).toEqual([
          [1, "CLOSED"],
          [2, "OPEN"],
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a commit a person pushed to the run's branch is never pushed over: declined",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub()
        const { run } = yield* openPrRun(home, github)
        yield* home.sql(crashBeforeRecord(run))
        github.remote.branches.set(`gent/${run}`, FIX)
        yield* readPrAfterRestart(home, github, run)
        expect(github.remote.branches.get(`gent/${run}`)).toBe(FIX)
        expect(Option.map(yield* home.sql(runRow(run)), (row) => row.state)).toEqual(
          Option.some("declined"),
        )
        expect(yield* home.sql(savedValue(run, "merge"))).toMatchObject({
          outcome: "declined",
          reason: "moved",
        })
        const moved = (yield* home.sql(stepsOf(run))).filter((step) => step._tag === "Moved")
        expect(moved[0]?.note ?? "").toContain(
          `gent/${run} on origin is at ${FIX}, a commit the run did not push: the run did not push ${CANDIDATE} over it.`,
        )
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )

  it.live(
    "a merge a queue takes waits until the PR reads merged, asking for no second merge",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const github = yield* fakeGitHub({ mergeQueue: true })
        const { run } = yield* openPrRun(home, github)
        Object.assign(github.remote.prs[0] ?? {}, APPROVED)
        const queued = (row: Option.Option<typeof RunRowView.Type>) =>
          Option.exists(row, (found) => (found.pending_json ?? "").includes('"queued":"squash"'))
        yield* home.sql(retryDueNow(run))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* prServer(home, github))
            yield* waitFor(home.sql(runRow(run)), queued, 15_000, "the run recorded the queue")
          }),
        )
        expect(github.remote.merges).toEqual([{ pr: 1, method: "squash", sha: CANDIDATE }])
        // The queue still holds the PR at the next read: the run waits.
        yield* home.sql(retryDueNow(run))
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* prServer(home, github))
            yield* waitFor(
              home.sql(runRecords(run)),
              (records) => records.some((at) => Option.exists(at, (time) => time > 0)),
              15_000,
              "the run waits for the next read",
            )
          }),
        )
        expect(github.remote.merges).toHaveLength(1)
        expect(Option.getOrThrow(yield* home.sql(runRow(run)))).toMatchObject({
          state: "merge",
          status: "running",
        })
        // The queue merged it.
        Object.assign(github.remote.prs[0] ?? {}, { state: "MERGED" })
        yield* readPrAfterRestart(home, github, run)
        expect(yield* home.sql(savedValue(run, "merge"))).toEqual({
          outcome: "merged",
          pr: 1,
          sha: CANDIDATE,
          method: "squash",
        })
        expect(github.remote.merges).toHaveLength(1)
        expect(github.remote.pushes).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("50 seconds")),
    55_000,
  )

  it.live("a via that is not push or pr is refused at define and at start", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const github = yield* fakeGitHub()
      const { client } = yield* createRpcClient(yield* prServer(home, github))
      const owner = ownerOf(yield* client.session.create({}))
      const [refused] = yield* call(client, owner, [
        [
          "machine.define",
          "define-merge-via",
          {
            definition: {
              ...PR_SHIP,
              name: "merge-via",
              states: { ...PR_SHIP.states, merge: { ...PR_SHIP.states.merge, via: "merge" } },
            },
          },
        ],
      ])
      expect(refused?.failed).toBe(true)
      expect(encodeJson(refused?.result)).toContain("merge: via is push or pr, not merge")
      const [defined] = yield* call(client, owner, [
        ["machine.define", "define-pr-ship", { definition: PR_SHIP }],
      ])
      expect(defined?.failed).toBe(false)
      const [started] = yield* call(client, owner, [
        ["machine.start", "start-pr-ship", { machine: "pr-ship", input: { via: "maybe" } }],
      ])
      expect(started?.failed).toBe(true)
      expect(encodeJson(started?.result)).toContain("merge: via renders maybe; it takes push or pr")
      const runs = yield* home.sql(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT run FROM machine_runs`),
      )
      expect(runs).toEqual([])
      expect(github.remote.prs).toEqual([])
    }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
  )

  it.live(
    "a PR that conflicts with a moved ref restacks, checks the new head, and pushes it to the same PR",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const count = `${home.home}/count`
        const { other } = yield* restackRepos(home)
        const { unit, moved } = yield* divergeFiles(home, other, {
          unit: { "unit.txt": "unit\n" },
          main: { "other.txt": "other\n" },
        })
        const github = yield* fakeGitHub({ head: moved })
        const definition = {
          ...RESTACK,
          name: "pr-restack",
          states: {
            ...RESTACK.states,
            merge: { ...RESTACK.states.merge, via: "pr" },
          },
        }
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client, owner } = yield* restackClient(home, github)
            const run = yield* startRun(client, owner, definition, "pr-restack", { count })
            yield* waitFor(home.sql(runRow(run)), recordsPr(1), 15_000, "the run opened its PR")
            return run
          }),
        )
        expect(github.remote.prs).toMatchObject([{ headRefOid: unit }])
        Object.assign(github.remote.prs[0] ?? {}, {
          ...APPROVED,
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        })
        yield* home.sql(retryDueNow(run))
        const rebased = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRpcClient(yield* restackLayer(home, github))
            // No client call: the run's own record activates its host, which reads the PR.
            yield* waitFor(
              home.sql(stepsOf(run)),
              (steps) => moves(steps).length === 3,
              15_000,
              "the run restacked and came back to merge",
            )
            const rebased = yield* unitGit(home.cwd, ["rev-parse", "HEAD"])
            yield* waitFor(
              Effect.sync(() => github.remote.prs[0]?.headRefOid),
              (head) => head === rebased,
              15_000,
              "the rebased head reached the PR",
            )
            return rebased
          }),
        )
        expect(rebased).not.toBe(unit)
        yield* unitGit(home.cwd, ["merge-base", "--is-ancestor", moved, rebased])
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "gate→merge",
          "merge→gate",
          "gate→merge",
        ])
        expect(yield* home.sql(savedValue(run, "merge"))).toEqual({
          outcome: "restacked",
          from: unit,
          to: rebased,
          onto: moved,
        })
        expect(yield* runsCounted(count)).toBe(2)
        // One PR, its branch force-pushed to the rebased head; main took no push.
        expect(github.remote.prs.map((pr) => pr.number)).toEqual([1])
        expect(yield* unitGit(other, ["ls-remote", "origin", `refs/heads/gent/${run}`])).toContain(
          rebased,
        )
        expect(github.remote.pushes).toEqual([])
      }).pipe(Effect.scoped, Effect.timeout("50 seconds")),
    55_000,
  )
})
