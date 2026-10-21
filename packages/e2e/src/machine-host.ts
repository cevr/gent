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
 * - `MH_HANG` (`<state>:<visit>`): that round's first model call never ends.
 * - `MH_HOLD_RECORD`: the command's process record never commits, as when
 *   the server dies between the spawn and that commit.
 * - `MH_ANSWER` (a choice): once the run asks, the owner answers it in one
 *   step beside a `bash` call that sleeps, so the owner's turn is still open
 *   when the test kills the process.
 * - `MH_REPEAT_ANSWER`: the owner sends the run's recorded answer again
 *   (call id `again`), as a client whose reply a crash lost would.
 *
 * Every worker round's first model call appends `<state>:<visit>:<attempt>`
 * to `<MH_CWD>/calls.log`, and every command appends to `<MH_CWD>/ran.log`:
 * counts outside the database under test. Each event the test waits on is
 * one stdout line that starts with `MH `.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect"
import type * as Prompt from "effect/ai/Prompt"
import { SqlClient } from "effect/sql"
import { BuiltinExtensions } from "@gent/extensions"
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

/** One command that names its group, records its run, then outlives the server. */
const VERIFY = {
  name: "verify",
  threads: {},
  start: "verify",
  states: {
    verify: {
      kind: "run",
      run: "echo $$ > job.pid; echo ran >> ran.log; sleep 60",
      on: { pass: "done", fail: "done" },
    },
    done: { kind: "final" },
  },
}

/** One ask, then the end. */
const GATE = {
  name: "gate",
  threads: {},
  start: "gate",
  states: {
    gate: { kind: "ask", ask: "Go?", on: { go: "done", drop: "done" } },
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

/** Appends this round's line to `calls.log` and answers its attempt, from 1. */
const countCall = (fs: FileSystem.FileSystem, callsLog: string, key: string) =>
  Effect.gen(function* () {
    const before = yield* fs.readFileString(callsLog).pipe(Effect.orElseSucceed(() => ""))
    const attempt = before.split("\n").filter((line) => line.startsWith(`${key}:`)).length + 1
    yield* fs.writeFileString(callsLog, `${before}${key}:${attempt}\n`)
    return attempt
  }).pipe(Effect.orDie)

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
  readonly hang: Option.Option<string>
}) =>
  LanguageModelLayers.testStream((request) =>
    Effect.gen(function* () {
      const prompt = request.prompt
      if (!systemTextOf(prompt).includes("You are a worker thread")) return ownerStep(prompt)
      const header = /^STATE (\S+) (\d+)$/m.exec(lastUserText(prompt))
      const state = header?.[1] ?? "unknown"
      const visit = Number(header?.[2] ?? "0")
      const key = `${state}:${visit}`
      if (acted(prompt)) return workerStep(prompt, state, visit)
      const attempt = yield* countCall(options.fs, options.callsLog, key)
      yield* event(`round ${key}`)
      if (Option.contains(options.hang, key) && attempt === 1) return Stream.never
      return workerStep(prompt, state, visit)
    }),
  )

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

const program = Effect.gen(function* () {
  const home = yield* Config.String("MH_HOME")
  const cwd = yield* Config.String("MH_CWD")
  const start = yield* Config.option(Config.schema(MachineToStart, "MH_START"))
  const hang = yield* Config.option(Config.String("MH_HANG"))
  const holdRecord = Option.isSome(yield* Config.option(Config.String("MH_HOLD_RECORD")))
  const answer = yield* Config.option(Config.String("MH_ANSWER"))
  const repeatAnswer = Option.isSome(yield* Config.option(Config.String("MH_REPEAT_ANSWER")))
  const storagePath = `${home}/gent.db`
  const fs = yield* FileSystem.FileSystem
  const { client } = yield* createRpcClient(
    createE2ELayer({
      agents: [],
      extensionInputs: BuiltinExtensions.filter(
        (extension) => extension.manifest.id !== "@gent/cell",
      ),
      providerLayer: routedModels({
        fs,
        callsLog: `${cwd}/calls.log`,
        hang,
      }),
      storagePath,
      cwd,
      home,
    }),
  )
  // The host's own reads and the hold, on a second connection to the file the root migrated.
  const database = yield* Layer.build(
    BunSqlite.file(storagePath).pipe(Layer.provide(BunServices.layer)),
  )
  const sql = <A, E>(statement: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideContext(statement, database)
  if (holdRecord) {
    yield* sql(
      Effect.gen(function* () {
        const db = yield* SqlClient.SqlClient
        yield* db.unsafe(`CREATE TRIGGER IF NOT EXISTS crash_test_holds_the_record
            BEFORE INSERT ON machine_steps
            WHEN json_extract(NEW.step_json, '$._tag') = 'Recorded'
            BEGIN SELECT RAISE(ABORT, 'the crash test holds the process record'); END`)
      }),
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
