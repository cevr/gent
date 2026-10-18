import { describe, expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  FileSystem,
  Logger,
  Option,
  Predicate,
  Ref,
  References,
  Schema,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { BunServices } from "@effect/platform-bun"
import type * as Prompt from "effect/ai/Prompt"
import { workspaceIdForCwd } from "@gent/core/host"
import { omitUndefined } from "@gent/core/extensions/api"
import {
  createRpcClient,
  createRpcHarness,
  LanguageModelLayers,
  waitFor,
} from "@gent/core/test-utils"
import { MACHINE_ASK_TYPE, MACHINE_END_TYPE } from "../src/machines.js"
import { THREAD_ROUND_END_TYPE } from "../src/threads.js"
import {
  acted,
  billed,
  call,
  type Client,
  encodeJson,
  isWorkerRequest,
  lastUserText,
  restartableHome,
  type SessionKey,
  type SnapshotMessage,
  starterStep,
  toolCalls,
} from "./helpers/routed-session"
import { e2ePreset } from "./helpers/test-preset"

// ── the routed models ───────────────────────────────────────────────────────

/** One worker round, as its rendered `say` names it: `STATE <state> <visit>`, `MODE <mode>`. */
interface RoundCall {
  readonly state: string
  readonly visit: number
  readonly mode: string
  readonly text: string
  readonly prompt: Prompt.Prompt
}

const roundCallOf = (prompt: Prompt.Prompt): RoundCall => {
  const text = lastUserText(prompt)
  const header = /^STATE (\S+) (\d+)$/m.exec(text)
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

type WorkerStream = ReturnType<typeof billed>

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
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  askId: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.Struct({ _tag: Schema.String, state: Schema.String })),
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
      yield* call(client, owner, [
        ["machine.answer", "answer-drop", { run, askId: ask.askId, choice: "drop" }],
      ])
      yield* waitForEnd(client, owner)
      expect(moves(yield* home.sql(stepsOf(run)))).toEqual([...TRACK_MOVES, "decide→done"])
    }).pipe(Effect.scoped, Effect.timeout("40 seconds")),
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

interface PlantedRun {
  readonly run: string
  readonly host: SessionKey
  /** A `Round` left open by the last server, with no round sent. */
  readonly debt: boolean
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
        const input = encodeJson({ tag: planted.run })
        // A debt run entered `work` and recorded its round's key, and sent nothing.
        let pending = Option.none<string>()
        let visits = encodeJson({ counts: {}, grants: {} })
        if (planted.debt) {
          pending = Option.some(
            encodeJson(
              PlantedRound.make({
                state: "work",
                visit: 1,
                key: `machine:${planted.run}:2`,
                attempt: 1,
              }),
            ),
          )
          visits = encodeJson({ counts: { work: 1 }, grants: {} })
        }
        yield* sql`INSERT INTO machine_runs (
            run, machine, definition_json, host_session_id, host_branch_id, owner_thread,
            cwd, input_json, context_json, visits_json, roles_json, state, status, pending_json,
            seq, created_at, updated_at
          ) VALUES (
            ${planted.run}, 'budget', ${definitionJson}, ${planted.host.sessionId},
            ${planted.host.branchId}, ${planted.host.sessionId}, ${home.cwd},
            ${input}, '{"last":{},"all":{}}', ${visits}, '{}', 'work', 'running',
            ${Option.getOrNull(pending)}, 1, ${planted.createdAt}, ${planted.createdAt}
          )`
        yield* sql`INSERT INTO branch_wakes (
            workspace_id, session_id, branch_id, extension_id, source_id, at, version, attempts,
            armed_boot, created_at
          ) VALUES (
            ${workspace}, ${planted.host.sessionId}, ${planted.host.branchId}, '@gent/machines',
            ${`machine-run:${planted.run}`}, NULL, 1, 0, 0, ${planted.wakeAt}
          )`
      }
    }),
  )

const runIdAt = (index: number) => `run-${index.toString(16).padStart(16, "0")}`

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
          home.sql(allAsking(runs.map((planted) => planted.run))),
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
})
