/**
 * A server stand-in for the machine crash tests: the test root over the
 * SQLite file `<MH_HOME>/gent.db`, the shipped extensions but the cell, and
 * routed fake models. The test ends it with SIGKILL, so no finalizer runs, as
 * when a server crashes, then starts it again over the same files.
 *
 * - `MH_START` (`track`, `verify` or `gate`): define that machine and start it
 *   from a new owner session. Absent, the process starts nothing, and with
 *   no `MH_REPEAT_ANSWER` it makes no client call: a run's own record must
 *   activate its host.
 * - `MH_HANG` (`<state>:<visit>`): that round's first model call in this
 *   process never ends.
 * - `MH_HOLD_RECORD`: the command's process record never commits, as when
 *   the server dies between the spawn and that commit.
 * - `MH_HOLD_COMMAND`: no command is dispatched, so none starts; the driver
 *   retries after its backoff.
 * - `MH_ANSWER` (a choice): once the run asks, the owner answers it in one
 *   step beside a `bash` call that sleeps, so the owner's turn is still open
 *   when the test kills the process.
 * - `MH_REPEAT_ANSWER`: once `<MH_CWD>/repeat.go` exists, the owner sends the
 *   run's recorded answer again (call id `again`), as a client whose reply a
 *   crash lost would.
 * - `MH_PUSH` (a branch): a new owner session calls `integration.push` to
 *   that branch (call id `push`) and does not wait for its result. The test
 *   puts fake `gh` and `git` executables first on `PATH`.
 *
 * A hold is a trigger in the database file; a host drops each hold its
 * environment does not name.
 *
 * Counts outside the database under test, each one appended record per
 * event (`O_APPEND`), in `<MH_CWD>`:
 * - `calls.log`: every worker round's first model call, as
 *   `<state>:<visit> <round> <message>`, the round and its message read from
 *   `thread_rounds` by the round's text.
 * - `wakes.log`: every `wakeDue` fire of the machines and integration
 *   extensions, as `<cause> <sourceId> <answer>`.
 * - `requests.log`: every model request, as the first line of its last user
 *   message.
 * - `ran.log`, `after.log`, and the pid files: what the commands write.
 *
 * Each event the test waits on is one stdout line that starts with `MH `.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Config,
  Console,
  type Context,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import type * as Prompt from "effect/ai/Prompt"
import { SqlClient } from "effect/sql"
import { BuiltinExtensions } from "@gent/extensions"
import { ExtensionHost, type ExtensionHostService } from "@gent/core/extensions/api"
import { BunSqlite } from "@gent/core/host-bun"
import { BranchId, SessionId, ToolCallId } from "@gent/core/protocol"
import {
  createE2ELayer,
  createRpcClient,
  finishPart,
  LanguageModelLayers,
  systemTextOf,
  textDeltaPart,
  toolCallPart,
  waitFor,
} from "@gent/core/test-utils"

// ── machines ────────────────────────────────────────────────────────────────

/** implement → review (changes|accepted) → verify → decide (ask) → done. */
const TRACK = {
  name: "track",
  threads: { impl: {}, rev: {} },
  start: "implement",
  states: {
    implement: {
      kind: "thread",
      thread: "impl",
      say: "STATE implement {{visit}}\nFINDINGS {{review.reply.findings}}",
      next: "review",
    },
    review: {
      kind: "thread",
      thread: "rev",
      say: "STATE review {{visit}}",
      on: { accepted: "verify", changes: "implement" },
    },
    verify: {
      kind: "run",
      run: "echo verify >> ran.log",
      on: { pass: "decide", fail: "implement" },
    },
    decide: { kind: "ask", ask: "Merge?", on: { merge: "done", drop: "done" } },
    done: { kind: "final", say: "track finished" },
  },
}

/**
 * One command that outlives the server: its leader shell waits on a
 * descendant `sleep` in its group, and each names its pid in a file.
 */
const VERIFY = {
  name: "verify",
  threads: {},
  start: "verify",
  states: {
    verify: {
      kind: "run",
      run: "sleep 120 & echo $! > child.pid; echo $$ > job.pid; echo ran >> ran.log; wait",
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
}

/** One ask, then a command the answer leads to, then the end. */
const GATE = {
  name: "gate",
  threads: {},
  start: "gate",
  states: {
    gate: { kind: "ask", ask: "Go?", on: { go: "after", drop: "done" } },
    after: { kind: "run", run: "echo after >> after.log", on: { pass: "done", fail: "done" } },
    done: { kind: "final", say: "gate finished" },
  },
}

const MACHINES = { track: TRACK, verify: VERIFY, gate: GATE } satisfies Record<string, Schema.Json>
const MachineToStart = Schema.Literals(["track", "verify", "gate"])

// ── the routed models ───────────────────────────────────────────────────────

const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const billed = (text: string) =>
  Stream.fromIterable([
    textDeltaPart(text),
    finishPart({ finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } }),
  ])

const toolCalls = (
  calls: ReadonlyArray<{ readonly tool: string; readonly id: string; readonly input: Schema.Json }>,
) =>
  Stream.fromIterable([
    ...calls.map((entry) =>
      toolCallPart(entry.tool, entry.input, { toolCallId: ToolCallId.make(entry.id) }),
    ),
    finishPart({ finishReason: "tool-calls", usage: { inputTokens: 50, outputTokens: 10 } }),
  ])

const userIndex = (prompt: Prompt.Prompt) =>
  prompt.content.findLastIndex((message) => message.role === "user")

const lastUserText = (prompt: Prompt.Prompt): string => {
  const message = prompt.content[userIndex(prompt)]
  if (Predicate.isUndefined(message) || message.role !== "user") return ""
  return message.content
    .flatMap((part) => {
      if (part.type !== "text") return []
      return [part.text]
    })
    .join("\n")
}

/** The model already answered the last user message with a step of its own. */
const acted = (prompt: Prompt.Prompt) => userIndex(prompt) < prompt.content.length - 1

/** The owner makes the calls its `CALL <tool> <id> <json>` lines name, once. */
const ownerStep = (prompt: Prompt.Prompt) => {
  const text = lastUserText(prompt)
  if (!text.startsWith("CALL ")) return billed("noted")
  if (acted(prompt)) return billed("done")
  return toolCalls(
    text.split("\n").map((entry) => {
      const [, name = "", id = "", ...rest] = entry.split(" ")
      return { tool: name, id, input: parseJson(rest.join(" ")) }
    }),
  )
}

/** A line the test waits on. */
const event = (line: string) => Console.log(`MH ${line}`)

/** Appends one record to `file`: one write with `O_APPEND`, so no record overwrites another. */
const appendRecord = (fs: FileSystem.FileSystem, file: string, record: string) =>
  fs.writeFileString(file, `${record}\n`, { flag: "a" }).pipe(Effect.orDie)

type Database = Context.Context<SqlClient.SqlClient>

const RoundRow = Schema.Struct({ round: Schema.String, message_id: Schema.String })
const decodeRoundRows = Schema.decodeUnknownSync(Schema.Array(RoundRow))

/** The round whose message is `text`, and its message's id: the round this call runs. */
const roundOf = (database: Database, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = decodeRoundRows(
      yield* sql`SELECT round, message_id FROM thread_rounds WHERE content = ${text}`,
    )
    const [row] = rows
    if (rows.length !== 1 || Predicate.isUndefined(row)) {
      return yield* Effect.die(new Error(`${rows.length} rounds hold this call's message`))
    }
    return row
  }).pipe(Effect.provideContext(database), Effect.orDie)

/** The track's worker: review 1 asks for changes, a later review accepts. */
const workerStep = (prompt: Prompt.Prompt, state: string, visit: number) => {
  if (state !== "review") return billed(`${state} ${visit} done`)
  if (acted(prompt)) return billed(`replied ${state} ${visit}`)
  let value: Schema.Json = { next: "accepted" }
  if (visit === 1) value = { next: "changes", findings: "F1" }
  return toolCalls([{ tool: "thread.reply", id: `reply-${state}-${visit}`, input: { value } }])
}

const routedModels = (options: {
  readonly fs: FileSystem.FileSystem
  readonly callsLog: string
  readonly requestsLog: string
  readonly database: Database
  readonly hang: Option.Option<string>
  /** The keys whose first call this process already made. */
  readonly made: Ref.Ref<HashSet.HashSet<string>>
}) =>
  LanguageModelLayers.testStream((request) =>
    Effect.gen(function* () {
      const prompt = request.prompt
      const [asked = ""] = lastUserText(prompt).split("\n")
      yield* appendRecord(options.fs, options.requestsLog, asked)
      if (!systemTextOf(prompt).includes("You are a worker thread")) return ownerStep(prompt)
      const text = lastUserText(prompt)
      const header = /^STATE (\S+) (\d+)$/m.exec(text)
      const state = header?.[1] ?? "unknown"
      const visit = Number(header?.[2] ?? "0")
      const key = `${state}:${visit}`
      if (acted(prompt)) return workerStep(prompt, state, visit)
      const round = yield* roundOf(options.database, text)
      yield* appendRecord(options.fs, options.callsLog, `${key} ${round.round} ${round.message_id}`)
      yield* event(`round ${key}`)
      const hangs = Option.contains(options.hang, key)
      const first = !HashSet.has(yield* Ref.getAndUpdate(options.made, HashSet.add(key)), key)
      if (hangs && first) return Stream.never
      return workerStep(prompt, state, visit)
    }),
  )

// ── the wake log ────────────────────────────────────────────────────────────

const WakeFire = Schema.Struct({ sourceId: Schema.String, cause: Schema.String })
const WakeAnswer = Schema.Struct({ _tag: Schema.String })

/**
 * The extension, with each `wakeDue` fire and its answer appended to `log`:
 * the record of what the wake clock fired, outside the database under test.
 */
const withWakeLog = <E extends (typeof BuiltinExtensions)[number]>(
  extension: E,
  log: string,
): E => ({
  ...extension,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    const fs = yield* FileSystem.FileSystem
    const logged: ExtensionHostService = {
      ...host,
      on: (kind, handler) =>
        host.on(kind, (input) =>
          handler(input).pipe(
            Effect.tap((output) => {
              if (kind !== "wakeDue") return Effect.void
              const fire = Schema.decodeUnknownOption(WakeFire)(input)
              const answer = Schema.decodeUnknownOption(WakeAnswer)(output)
              if (Option.isNone(fire) || Option.isNone(answer)) {
                return Effect.die(new Error("a wakeDue fire the log cannot read"))
              }
              const line = `${fire.value.cause} ${fire.value.sourceId} ${answer.value._tag}`
              return appendRecord(fs, log, line)
            }),
          ),
        ),
    }
    yield* extension.setup.pipe(Effect.provideService(ExtensionHost, logged))
  }),
})

/** The extensions whose `wakeDue` fires `wakes.log` records. */
const WAKE_LOGGED: ReadonlySet<string> = new Set(["@gent/machines", "@gent/integration"])

// ── the owner's calls ───────────────────────────────────────────────────────

type Client = Effect.Success<ReturnType<typeof createRpcClient>>["client"]
type Owner = { readonly sessionId: SessionId; readonly branchId: BranchId }

const hasResult = (
  messages: ReadonlyArray<{ readonly parts: ReadonlyArray<Prompt.Part> }>,
  id: string,
) =>
  messages.some((message) =>
    message.parts.some((part) => part.type === "tool-result" && part.id === id),
  )

/** The owner makes one call in one turn; waits until its result is in and the owner is idle. */
const ownerCall = (client: Client, owner: Owner, tool: string, id: string, input: Schema.Json) =>
  Effect.gen(function* () {
    yield* client.message.send({ ...owner, content: `CALL ${tool} ${id} ${encodeJson(input)}` })
    yield* waitFor(
      client.session.getSnapshot(owner),
      (current) => current.runtime._tag === "Idle" && hasResult(current.messages, id),
      15_000,
      `the owner ran ${id}`,
    )
  })

const AskingRun = Schema.Struct({
  run: Schema.String,
  host_session_id: SessionId,
  host_branch_id: BranchId,
  ask_id: Schema.String,
})
const decodeAskingRuns = Schema.decodeUnknownSync(Schema.Array(AskingRun))

/** The run that asks, once its ask reached the owner. */
const askingRun = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT r.run, r.host_session_id, r.host_branch_id,
      json_extract(r.pending_json, '$.askId') AS ask_id
    FROM machine_runs r
    WHERE r.status = 'asking' AND EXISTS (SELECT 1 FROM machine_steps s
      WHERE s.run = r.run AND json_extract(s.step_json, '$._tag') = 'Delivered'
        AND json_extract(s.step_json, '$.askId') = json_extract(r.pending_json, '$.askId'))`
  return Option.fromUndefinedOr(decodeAskingRuns(rows)[0])
})

const AnsweredRun = Schema.Struct({
  run: Schema.String,
  host_session_id: SessionId,
  host_branch_id: BranchId,
  ask_id: Schema.String,
  choice: Schema.String,
})
const decodeAnsweredRuns = Schema.decodeUnknownSync(Schema.Array(AnsweredRun))

/** The run an answer was recorded for, and that answer. */
const answeredRun = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT r.run, r.host_session_id, r.host_branch_id,
      json_extract(s.step_json, '$.askId') AS ask_id,
      json_extract(s.step_json, '$.choice') AS choice
    FROM machine_runs r JOIN machine_steps s ON s.run = r.run
    WHERE json_extract(s.step_json, '$._tag') = 'Answered'`
  return Option.fromUndefinedOr(decodeAnsweredRuns(rows)[0])
})

// ── the host ────────────────────────────────────────────────────────────────

interface Hold {
  readonly env: string
  readonly trigger: string
  readonly when: string
}

/** The holds a host can name, each a trigger on the steps it refuses. */
const HOLDS: ReadonlyArray<Hold> = [
  {
    env: "MH_HOLD_RECORD",
    trigger: "crash_test_holds_the_record",
    when: `json_extract(NEW.step_json, '$._tag') = 'Recorded'`,
  },
  {
    env: "MH_HOLD_COMMAND",
    trigger: "crash_test_holds_the_command",
    when: `json_extract(NEW.step_json, '$._tag') = 'Dispatched'
      AND json_extract(NEW.step_json, '$.action._tag') = 'Command'`,
  },
]

const program = Effect.gen(function* () {
  const home = yield* Config.String("MH_HOME")
  const cwd = yield* Config.String("MH_CWD")
  const start = yield* Config.option(Config.schema(MachineToStart, "MH_START"))
  const hang = yield* Config.option(Config.String("MH_HANG"))
  const answer = yield* Config.option(Config.String("MH_ANSWER"))
  const repeatAnswer = Option.isSome(yield* Config.option(Config.String("MH_REPEAT_ANSWER")))
  const push = yield* Config.option(Config.String("MH_PUSH"))
  const storagePath = `${home}/gent.db`
  const fs = yield* FileSystem.FileSystem
  // The host's own reads and the holds, on a second connection to the root's file.
  const database = yield* Layer.build(
    BunSqlite.file(storagePath).pipe(Layer.provide(BunServices.layer)),
  )
  const sql = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideContext(statement, database)
  const named = (hold: Hold) =>
    Config.option(Config.String(hold.env)).pipe(Effect.map(Option.isSome))
  // A hold an earlier host named goes before this root builds, or its recovery meets it.
  for (const hold of HOLDS) {
    if (yield* named(hold)) continue
    yield* sql(
      Effect.flatMap(SqlClient.SqlClient, (db) =>
        db.unsafe(`DROP TRIGGER IF EXISTS ${hold.trigger}`),
      ),
    )
  }
  const { client } = yield* createRpcClient(
    createE2ELayer({
      agents: [],
      extensionInputs: BuiltinExtensions.filter(
        (extension) => extension.manifest.id !== "@gent/cell",
      ).map((extension) => {
        if (!WAKE_LOGGED.has(extension.manifest.id)) return extension
        return withWakeLog(extension, `${cwd}/wakes.log`)
      }),
      providerLayer: routedModels({
        fs,
        callsLog: `${cwd}/calls.log`,
        requestsLog: `${cwd}/requests.log`,
        database,
        hang,
        made: yield* Ref.make(HashSet.empty<string>()),
      }),
      storagePath,
      cwd,
      home,
    }),
  )
  // A named hold goes in once the root made its table.
  for (const hold of HOLDS) {
    if (!(yield* named(hold))) continue
    yield* sql(
      Effect.flatMap(SqlClient.SqlClient, (db) =>
        db.unsafe(`CREATE TRIGGER IF NOT EXISTS ${hold.trigger}
            BEFORE INSERT ON machine_steps WHEN ${hold.when}
            BEGIN SELECT RAISE(ABORT, 'the crash test holds this step'); END`),
      ),
    )
  }
  yield* event("ready")
  if (Option.isSome(start)) {
    const created = yield* client.session.create({})
    const owner = { sessionId: created.sessionId, branchId: created.branchId }
    const definition = MACHINES[start.value]
    yield* ownerCall(client, owner, "machine.define", "define", { definition })
    yield* ownerCall(client, owner, "machine.start", "start", {
      machine: start.value,
      input: {},
    })
    yield* event("started")
  }
  if (Option.isSome(push)) {
    const created = yield* client.session.create({})
    yield* client.message.send({
      sessionId: created.sessionId,
      branchId: created.branchId,
      content: `CALL integration.push push ${encodeJson({ ref: push.value })}`,
    })
    yield* event("push sent")
  }
  if (Option.isSome(answer)) {
    const run = (yield* waitFor(sql(askingRun), Option.isSome, 30_000, "a run asked")).value
    yield* client.message.send({
      sessionId: run.host_session_id,
      branchId: run.host_branch_id,
      content: [
        `CALL machine.answer answer ${encodeJson({
          run: run.run,
          askId: run.ask_id,
          choice: answer.value,
        })}`,
        `CALL bash hold ${encodeJson({ command: "echo $$ > hold.pid; exec sleep 600" })}`,
      ].join("\n"),
    })
  }
  if (repeatAnswer) {
    const run = (yield* waitFor(sql(answeredRun), Option.isSome, 30_000, "an answer")).value
    yield* waitFor(fs.exists(`${cwd}/repeat.go`), (go) => go, 45_000, "the test let the repeat go")
    yield* client.message.send({
      sessionId: run.host_session_id,
      branchId: run.host_branch_id,
      content: `CALL machine.answer again ${encodeJson({
        run: run.run,
        askId: run.ask_id,
        choice: run.choice,
      })}`,
    })
  }
  return yield* Effect.never
})

// The layer runs the host as it is built; only a signal ends it.
BunRuntime.runMain(
  Effect.scoped(Layer.build(Layer.effectDiscard(program).pipe(Layer.provide(BunServices.layer)))),
)
