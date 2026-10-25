import { decodeRequestReply } from "@gent/core/protocol"
import { describe, expect, it } from "effect-bun-test"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Predicate,
  PubSub,
  Queue,
  Ref,
  Sink,
  References,
  Schema,
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
  request,
  tool,
  WakeNext,
} from "@gent/core/extensions/api"
import {
  ConfigService,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  LanguageModelLayers,
  runToolWithCtx,
  TEST_MODEL_ID,
  testToolContext,
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
  MachineRunStatus,
  MachineStopTool,
  MachinesExtension,
  MachinesRpc,
  MachineStore,
  roundEndSignal,
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
import { CANDIDATE, fakeGitHub, REPO } from "./helpers/fake-github"

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

const roundCallOf = (prompt: Prompt.Prompt): RoundCall => {
  const text = lastUserText(prompt)
  const header = /^STATE (\S+) (\d+)$/m.exec(text) ?? /^Unit \S+, (\S+), visit (\d+)\.$/m.exec(text)
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

type WorkerStream = ReturnType<typeof billed> | ReturnType<typeof usageLimited>

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
  askId: Schema.optionalKey(Schema.String),
  round: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Finite),
  role: Schema.optionalKey(Schema.String),
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

  it.live(
    "rounds that wait for the account hold no step permit: a command runs beside four of them",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const readings = yield* Ref.make<ReadonlyArray<QuotaReading>>([])
        const worker = (round: RoundCall) =>
          Effect.succeed(billed(`${round.state} ${round.visit} done`))
        const reset = (yield* Clock.currentTimeMillis) + HOUR
        // As many waiting rounds as the server runs steps at once: a command still runs beside them.
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
 * `open` model calls are open and `waiting` drivers wait for a permit, as
 * the drivers log it. Then `check` reads the order the rounds opened in, the
 * gate opens, and every run reaches its ask. Answers the most calls open at once.
 */
const bootGated = (
  home: Effect.Success<typeof restartableHome>,
  runs: ReadonlyArray<PlantedRun>,
  waiting: number,
  check: (order: ReadonlyArray<string>) => void,
  /** The runs that reach their ask; every run by default. */
  asking: ReadonlyArray<PlantedRun> = runs,
) =>
  Effect.gen(function* () {
    yield* plantRuns(home, BUDGET_JSON, runs)
    const gate = yield* Deferred.make<boolean>()
    const open = yield* Ref.make(0)
    const most = yield* Ref.make(0)
    const order = yield* Ref.make<ReadonlyArray<string>>([])
    const waits: Array<string> = []
    const capture = Logger.make(({ message }) => {
      const text = String(message)
      if (text.includes("machines.step.waiting")) waits.push(text)
    })
    const models = yield* makeModels(gatedWorker(gate, open, most, order))
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRpcClient(home.layerFor(machineModels(models)))
        yield* waitFor(Ref.get(open), (count) => count >= 4, 20_000, "four rounds opened")
        yield* waitFor(
          Effect.sync(() => waits.length),
          (count) => count >= waiting,
          20_000,
          "the rest wait",
        )
        expect(yield* Ref.get(open)).toBe(4)
        check(yield* Ref.get(order))
        yield* Deferred.succeed(gate, true)
        yield* waitFor(
          home.sql(allAsking(asking.map((planted) => planted.run))),
          Boolean,
          40_000,
          "every run reached its ask",
        )
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        // The test preload turns logs off; this test reads the drivers' waits.
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
    )
    return yield* Ref.get(most)
  })

// ── model tiers ─────────────────────────────────────────────────────────────

const OPUS = ModelId.make("anthropic/claude-opus-5")
const HAIKU = ModelId.make("anthropic/claude-haiku-4-5")
const SONNET = TEST_MODEL_ID

/** The `work` account, with the owner's tiers, over the catalog's models and prices unless `models` names others. */
const tieredAccount = (
  tiers: {
    strongest?: ReadonlyArray<ModelId>
    efficient?: ReadonlyArray<ModelId>
  },
  models: ReadonlyArray<Model> | "catalog" = "catalog",
) => ({
  configServiceLayer: ConfigService.Test(
    new UserConfig({
      model: TEST_MODEL_ID,
      // As `oneAccount`: the owner's turn goes on past the readings it reports.
      providers: { anthropic: { authOrder: [work], extraUsage: true } },
      tiers,
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
  threads: { worker: { tier: "strongest" } },
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
  threads: { worker: { tier: "efficient" } },
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
  threads: { worker: { tier: "efficient" } },
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

describe("a tier role's round", () => {
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
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.timeout("40 seconds")),
    45_000,
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
    "counts each model's rounds, cost, verdicts, the checks and gates after them, and the rounds a finished run took",
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
            priced: 3,
            ...none,
            accepted: { runs: 1, rounds: 3 },
          },
          {
            state: "work",
            model: SONNET,
            rounds: 3,
            dead: 1,
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

describe("the machine boot budget", () => {
  it.live(
    "twenty runs left running open at most four model calls at once, and all reach their ask",
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
        // Four rounds open; the sixteen other drivers wait for a permit.
        expect(yield* bootGated(home, runs, 16, (order) => expect(order).toHaveLength(4))).toBe(4)
      }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
  )

  it.live("runs that held a step when the server stopped take the first four permits", () =>
    Effect.gen(function* () {
      const home = yield* restartableHome
      const hosts = yield* makeHosts(home, 8)
      // Two new runs whose records come first, then six that held a round,
      // the oldest runs of all, whose records come last.
      const runs = hosts.map((host, index): PlantedRun => {
        const run = runIdAt(index + 1)
        if (index < 2) {
          return { run, host, debt: false, createdAt: 5_000 + index, wakeAt: 1_000 + index }
        }
        return { run, host, debt: true, createdAt: 100 + index, wakeAt: 9_000 + index }
      })
      // The four oldest debt runs hold the four tickets; the two new runs and
      // the two younger debt runs wait.
      const most = yield* bootGated(home, runs, 4, (order) => {
        expect(order.toSorted()).toEqual(runs.slice(2, 6).map((planted) => planted.run))
      })
      expect(most).toBe(4)
    }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
  )

  it.live(
    "expired waits leave crash tickets to genuine interrupted rounds and resume as permit holders",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const hosts = yield* makeHosts(home, 4)
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
        const waits = yield* Queue.unbounded<string>()
        const capture = Logger.make(({ message, fiber }) => {
          if (String(message).includes("machines.step.waiting"))
            Queue.offerUnsafe(waits, String(fiber.getRef(References.CurrentLogAnnotations)["run"]))
        })
        const worker = gatedWorker(gate, open, most, order)
        const resumedMarkers = yield* Ref.make<ReadonlyArray<Option.Option<number>>>([])
        const models = yield* makeModels((round) =>
          Effect.gen(function* () {
            if (round.mode.startsWith("run-")) {
              // A resumed wait must durably become a permit holder before admission.
              const marker = yield* home.sql(pendingWait(round.mode)).pipe(Effect.orDie)
              yield* Ref.update(resumedMarkers, (all) => [...all, marker])
            }
            return yield* worker(round)
          }),
        )
        yield* createRpcClient(home.layerFor(machineModels(models))).pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        )
        const blocked = yield* Effect.forEach([1, 2, 3, 4], () => Queue.take(waits))
        expect(blocked.toSorted()).toEqual(expired.map((run) => run.run))
        yield* waitFor(Ref.get(open), (count) => count >= 4, 8_000, "interrupted workers resumed")
        expect(yield* Ref.get(open)).toBe(4)
        expect((yield* Ref.get(order)).toSorted()).toEqual([
          "interrupted-1",
          "interrupted-2",
          "interrupted-3",
          "interrupted-4",
        ])
        yield* Deferred.succeed(gate, true)
        yield* waitFor(
          home.sql(allAsking([...interrupted, ...expired.map((run) => run.run)])),
          Boolean,
          20_000,
          "all runs reached their ask",
        )
        expect(yield* Ref.get(most)).toBe(4)
        expect(yield* Ref.get(resumedMarkers)).toEqual([
          Option.none(),
          Option.none(),
          Option.none(),
          Option.none(),
        ])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
  )

  it.live(
    "runs whose round waits for its account take no ticket, so new runs open beside them",
    () =>
      Effect.gen(function* () {
        const home = yield* restartableHome
        const hosts = yield* makeHosts(home, 8)
        const until = (yield* Clock.currentTimeMillis) + HOUR
        // Four runs, the oldest of all, wait an hour for their account; four new runs come after.
        const runs = hosts.map((host, index): PlantedRun => {
          const run = runIdAt(index + 1)
          if (index < 4) {
            return {
              run,
              host,
              debt: true,
              waitsUntil: until,
              createdAt: 100 + index,
              wakeAt: 1_000,
            }
          }
          return { run, host, debt: false, createdAt: 5_000 + index, wakeAt: 1_000 + index }
        })
        const fresh = runs.slice(4)
        const most = yield* bootGated(
          home,
          runs,
          0,
          (order) => expect(order.toSorted()).toEqual(fresh.map((planted) => planted.run)),
          fresh,
        )
        expect(most).toBe(4)
      }).pipe(Effect.scoped, Effect.timeout("90 seconds")),
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

/** Each round replies the verdict `verdicts` names for its `state:visit`, else its state's happy one, with a file of its own. */
const unitWorker =
  (verdicts: Readonly<Record<string, string>>) =>
  (round: RoundCall): Effect.Effect<WorkerStream> => {
    const next =
      verdicts[`${round.state}:${round.visit}`] ?? UNIT_VERDICTS.get(round.state) ?? "unknown"
    return Effect.succeed(replyWith(round, { next, file: `${round.state}-${round.visit}.md` }))
  }

/** The orchestrate machine's tiers, each its own model: a round's model names its tier. */
const unitTiers = () => tieredAccount({ strongest: [OPUS], efficient: [HAIKU] })

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
  } = {},
) =>
  Effect.gen(function* () {
    const home = yield* restartableHome
    const dir = `${home.cwd}/unit`
    yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(dir)).pipe(
      Effect.provide(BunServices.layer),
    )
    const models = yield* makeModels(unitWorker(verdicts))
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

describe("the shipped orchestrate machine", () => {
  it.live(
    "plans, implements, reviews and verifies a unit, each role on its tier, then decides",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run, dir } = yield* unitRun({})
        const approve = yield* answerAsk(client, owner, 1, "go")
        expect(approve).toMatchObject({ state: "approve", choices: ["go", "replan", "drop"] })
        const decide = yield* answerAsk(client, owner, 2, "drop")
        expect(decide).toMatchObject({
          state: "decide",
          reason: "asked",
          choices: ["merge", "changes", "replan", "rewrite", "drop"],
        })
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        // Planning and review on the strongest tier, implementing and verifying on the efficient one.
        expect(roundsRan(steps).map((round) => round.model)).toEqual([OPUS, HAIKU, OPUS, HAIKU])
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
          "implement→review",
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
        expect(moves(yield* home.sql(stepsOf(run)))).toEqual([
          "implement→review",
          "review→fix",
          "fix→decide",
          "decide→dropped",
        ])
        expect(yield* Ref.get(models.calls)).toEqual(["implement:1", "review:1", "fix:1"])
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
          "resume→review",
          "review→fix",
          "fix→review",
          "review→verify",
          "verify→fix",
          "fix→review",
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
    "a stuck review goes to decide, and changes there start a new implementor that later fixes continue",
    () =>
      Effect.gen(function* () {
        const { home, models, client, owner, run } = yield* unitRun({
          "review:1": "stuck",
          "review:2": "changes",
          "verify:1": "stuck",
        })
        yield* answerAsk(client, owner, 1, "go")
        const first = yield* answerAsk(client, owner, 2, "changes", "split the parser")
        expect(first.state).toBe("decide")
        const second = yield* answerAsk(client, owner, 3, "drop")
        expect(second.state).toBe("decide")
        yield* waitFor(home.sql(runRow(run)), isSettled, 10_000, "the run's end was told")
        const steps = yield* home.sql(stepsOf(run))
        expect(moves(steps)).toEqual([
          "plan→approve",
          "approve→implement",
          "implement→review",
          "review→decide",
          "decide→implement",
          "implement→review",
          "review→fix",
          "fix→review",
          "review→verify",
          "verify→decide",
          "decide→dropped",
        ])
        const texts = new Map(yield* Ref.get(models.texts))
        expect(texts.get("implement:2")).toContain("split the parser")
        const [, impl1, , impl2, , fix1] = roundThreads(steps)
        expect(impl2).not.toBe(impl1)
        expect(fix1).toBe(impl2)
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
          "implement→review",
          "review→verify",
          "verify→decide",
          "decide→gate",
          "gate→resume",
          "resume→blocked",
          "blocked→dropped",
        ])
        // The empty gate never parsed, so nothing ran into the gate's log.
        expect(yield* fileExists(`${dir}/merge-gate-1.log`)).toBe(false)
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

  it.live(
    "a red round gate fails the merge gate before its merge-only legs run",
    () =>
      Effect.gen(function* () {
        const { home, client, owner, run, dir } = yield* unitRun(
          { "resume:1": "blocked" },
          { gate: "echo gate-ran; false", mergeGate: "echo slow-ran" },
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
        expect(log.trim().split("\n")).toEqual(["gate-ran"])
      }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
    45_000,
  )
})
