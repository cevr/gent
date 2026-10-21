/**
 * Machines across a hard kill. A real host process (`src/machine-host.ts`)
 * runs a machine on routed fake models over a SQLite file; the test ends it
 * with SIGKILL, so no finalizer runs, then starts a second host over the same
 * files. Counts come from files the fake models, the machines extension's
 * wake hook and the commands append to (`calls.log`, `wakes.log`, `ran.log`,
 * `after.log`, the pid files), outside the database under test.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { runProcess } from "@gent/core/extensions/api"
import { BunSqlite } from "@gent/core/host-bun"
import { makeTempDirectoryScoped, waitFor } from "@gent/core/test-utils"
import { hardKill, hostPrinted, spawnTestHost } from "../src/server-process-fixture"

// ── the host process ────────────────────────────────────────────────────────

/** A machine host over `dir`, its data dir and its cwd. */
const spawnHost = (dir: string, label: string, env: Readonly<Record<string, string>>) =>
  spawnTestHost({
    script: "src/machine-host.ts",
    prefix: "MH",
    dir,
    label,
    env: { MH_HOME: dir, MH_CWD: dir, ...env },
  })

/**
 * True while `pid` runs. `ps` reads the process state: no process, or a
 * zombie (`Z`, ended and not yet reaped), runs nothing.
 */
const running = (pid: number) =>
  runProcess("ps", ["-o", "stat=", "-p", String(pid)]).pipe(
    Effect.map((ps) => {
      const state = ps.stdout.trim()
      return ps.exitCode === 0 && state.length > 0 && !state.startsWith("Z")
    }),
  )

/** The files a fixture's commands name their processes in. */
const PID_FILES = ["job.pid", "child.pid", "hold.pid"]

/**
 * Ends every process a fixture command named in `dir`, its group and itself;
 * one already gone is fine. Registered before the first host spawns, so a
 * test that fails anywhere leaves no command running.
 */
const reapCommands = (dir: string) =>
  Effect.forEach(PID_FILES, (file) =>
    lines(`${dir}/${file}`).pipe(
      Effect.flatMap((read) =>
        Effect.forEach(read.map(Number).filter(Number.isInteger), (pid) =>
          Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(
            Effect.ignore,
            Effect.andThen(Effect.try(() => process.kill(pid, "SIGKILL"))),
            Effect.ignore,
          ),
        ),
      ),
      Effect.ignore,
    ),
  )

/** A fixture directory whose commands the scope reaps before it removes the directory. */
const fixtureDirectory = Effect.gen(function* () {
  const dir = yield* makeTempDirectoryScoped("gent-machine-kill-")
  yield* Effect.addFinalizer(() => reapCommands(dir))
  return dir
})

// ── reading the files ───────────────────────────────────────────────────────

const lines = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(file))) return []
    const text = yield* fs.readFileString(file)
    return text.split("\n").filter((line) => line.length > 0)
  })

const pidIn = (file: string) =>
  waitFor(lines(file), (read) => read.length > 0, 10_000, `${file} named a pid`).pipe(
    Effect.map((read) => Number(read[0])),
  )

/** A command's group as its files name it: the leader shell and the descendant it waits on. */
const commandGroup = (dir: string) =>
  Effect.gen(function* () {
    const leader = yield* pidIn(`${dir}/job.pid`)
    const descendant = yield* pidIn(`${dir}/child.pid`)
    return [leader, descendant]
  })

const nothingRuns = (pids: ReadonlyArray<number>) =>
  Effect.forEach(pids, running).pipe(Effect.map((states) => states.every((state) => !state)))

const allRun = (pids: ReadonlyArray<number>) =>
  Effect.forEach(pids, running).pipe(Effect.map((states) => states.every((state) => state)))

/** One `calls.log` record: the round's state and visit, the round's id, and its message's id. */
const calls = (dir: string) =>
  lines(`${dir}/calls.log`).pipe(
    Effect.map((read) =>
      read.map((line) => {
        const [key = "", round = "", message = ""] = line.split(" ")
        return { key, round, message }
      }),
    ),
  )

/** The test's own connection to the host's database; the first host made the file. */
const database = (dir: string) =>
  Layer.build(BunSqlite.file(`${dir}/gent.db`).pipe(Layer.provide(BunServices.layer)))

const RunRow = Schema.Struct({ status: Schema.String, state: Schema.String })
const decodeRunRows = Schema.decodeUnknownSync(Schema.Array(RunRow))

const runRow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return Option.fromUndefinedOr(
    decodeRunRows(yield* sql`SELECT status, state FROM machine_runs`)[0],
  )
})

const TagRow = Schema.Struct({ tag: Schema.String })
const decodeTagRows = Schema.decodeUnknownSync(Schema.Array(TagRow))

/** The run's log, as its step tags in order. */
const stepTags = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT json_extract(step_json, '$._tag') AS tag
    FROM machine_steps ORDER BY seq`
  return decodeTagRows(rows).map((row) => row.tag)
})

const count = (tags: ReadonlyArray<string>, tag: string) =>
  tags.filter((each) => each === tag).length

const RoundEndRow = Schema.Struct({ round: Schema.String })
const decodeRoundEndRows = Schema.decodeUnknownSync(Schema.Array(RoundEndRow))

/** The round each `RoundEnded` step names, in the run's order. */
const endedRounds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT json_extract(step_json, '$.round') AS round
    FROM machine_steps WHERE json_extract(step_json, '$._tag') = 'RoundEnded' ORDER BY seq`
  return decodeRoundEndRows(rows).map((row) => row.round)
})

const RunIdRow = Schema.Struct({ run: Schema.String })
const decodeRunIdRows = Schema.decodeUnknownSync(Schema.Array(RunIdRow))

const runIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return decodeRunIdRows(yield* sql`SELECT run FROM machine_runs`).map((row) => row.run)
})

const AskDetails = Schema.Struct({
  reason: Schema.String,
  choices: Schema.Array(Schema.String),
  mayStillRun: Schema.optionalKey(Schema.Boolean),
})
const DetailsRow = Schema.Struct({ details: Schema.fromJsonString(AskDetails) })
const decodeDetailsRows = Schema.decodeUnknownSync(Schema.Array(DetailsRow))

/** The details of every message of `type` (`machine-ask`, `machine-end`) the owner got. */
const ownerMessages = (type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT json_extract(metadata, '$.details') AS details
      FROM messages WHERE json_extract(metadata, '$.customType') = ${type}`
    return decodeDetailsRows(rows).map((row) => row.details)
  })

const EndRow = Schema.Struct({ id: Schema.String })
const decodeEndRows = Schema.decodeUnknownSync(Schema.Array(EndRow))

const endMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return decodeEndRows(
    yield* sql`SELECT id FROM messages WHERE json_extract(metadata, '$.customType') = 'machine-end'`,
  )
})

const ToolResult = Schema.Struct({ isFailure: Schema.Boolean, result: Schema.Unknown })
const ResultRow = Schema.Struct({ part: Schema.fromJsonString(ToolResult) })
const decodeResultRows = Schema.decodeUnknownSync(Schema.Array(ResultRow))

/** The stored result parts of the tool call `id`. */
const toolResults = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT c.part_json AS part FROM content_chunks c
      WHERE json_extract(c.part_json, '$.type') = 'tool-result'
        AND json_extract(c.part_json, '$.id') = ${id}`
    return decodeResultRows(rows).map((row) => row.part)
  })

// ── the tests ───────────────────────────────────────────────────────────────

describe("machines across a hard kill", () => {
  it.live(
    "a round cut by SIGKILL runs on under its key, and the start pass wakes the run with no user message",
    () =>
      Effect.gen(function* () {
        const dir = yield* fixtureDirectory
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", { MH_START: "track", MH_HANG: "review:2" })
            yield* hostPrinted(first, "round review:2", 20_000)
            yield* hardKill(first.proc)
          }),
        )
        // The first host armed the run's record for the next start and fired nothing.
        expect(yield* lines(`${dir}/wakes.log`)).toEqual([])
        const sql = yield* database(dir)
        // The second host makes no client call.
        yield* spawnHost(dir, "second", {})
        const asked = yield* waitFor(
          runRow.pipe(Effect.provideContext(sql)),
          (row) => Option.exists(row, (run) => run.status === "asking"),
          30_000,
          "the run asked",
        )
        const asks = yield* waitFor(
          ownerMessages("machine-ask").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          10_000,
          "the ask reached the owner",
        )
        // The wake clock's start pass fired the run's own record, and the
        // hook found the run active and armed its driver (`AtStart`). The
        // cluster also delivers the driver's keep-alive at this start; this
        // line, not the time the run took, names the start pass.
        const [run] = yield* runIds.pipe(Effect.provideContext(sql))
        expect(yield* lines(`${dir}/wakes.log`)).toEqual([`start machine-run:${run} AtStart`])
        // Each completed round ran once; the cut one ran once more as the
        // same round, with the same message.
        const made = yield* calls(dir)
        expect(made.map((call) => call.key)).toEqual([
          "implement:1",
          "review:1",
          "implement:2",
          "review:2",
          "review:2",
        ])
        const [cut, again] = made.slice(3)
        expect(again).toEqual(cut)
        const rounds = made.slice(0, 4).map((call) => call.round)
        expect(new Set(rounds).size).toBe(4)
        expect(yield* endedRounds.pipe(Effect.provideContext(sql))).toEqual(rounds)
        expect(yield* lines(`${dir}/ran.log`)).toEqual(["verify"])
        expect(asked).toEqual(Option.some({ status: "asking", state: "decide" }))
        const tags = yield* stepTags.pipe(Effect.provideContext(sql))
        expect(count(tags, "RoundEnded")).toBe(4)
        expect(count(tags, "CommandEnded")).toBe(1)
        expect(asks.map((ask) => ask.reason)).toEqual(["asked"])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )

  it.live(
    "a command cut by SIGKILL asks interrupted, its group is stopped, and it never runs again",
    () =>
      Effect.gen(function* () {
        const dir = yield* fixtureDirectory
        const group = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", { MH_START: "verify" })
            yield* hostPrinted(first, "started", 20_000)
            const sql = yield* database(dir)
            yield* waitFor(
              stepTags.pipe(Effect.provideContext(sql)),
              (tags) => tags.includes("Recorded"),
              10_000,
              "the command's process was recorded",
            )
            const pids = yield* commandGroup(dir)
            yield* hardKill(first.proc)
            return pids
          }),
        )
        // No finalizer ran: the leader and its descendant outlived their server.
        expect(yield* allRun(group)).toBe(true)
        const sql = yield* database(dir)
        yield* spawnHost(dir, "second", {})
        const asks = yield* waitFor(
          ownerMessages("machine-ask").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          30_000,
          "the interrupted ask reached the owner",
        )
        expect(asks).toEqual([
          { reason: "interrupted", choices: ["pass", "fail", "retry", "stop"] },
        ])
        yield* waitFor(
          nothingRuns(group),
          (stopped) => stopped,
          5_000,
          "the recorded group stopped",
        )
        expect(yield* lines(`${dir}/ran.log`)).toEqual(["ran"])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )

  it.live(
    "a command killed before its process was recorded is stopped from its receipt",
    () =>
      Effect.gen(function* () {
        const dir = yield* fixtureDirectory
        const group = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", {
              MH_START: "verify",
              MH_HOLD_RECORD: "1",
            })
            yield* hostPrinted(first, "started", 20_000)
            const pids = yield* commandGroup(dir)
            yield* hardKill(first.proc)
            return pids
          }),
        )
        const sql = yield* database(dir)
        const tags = yield* stepTags.pipe(Effect.provideContext(sql))
        // The hold kept the record out: only the launcher's receipt names the process.
        expect(tags).not.toContain("Recorded")
        expect(yield* allRun(group)).toBe(true)
        yield* spawnHost(dir, "second", {})
        const asks = yield* waitFor(
          ownerMessages("machine-ask").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          30_000,
          "the interrupted ask reached the owner",
        )
        expect(asks).toEqual([
          { reason: "interrupted", choices: ["pass", "fail", "retry", "stop"] },
        ])
        yield* waitFor(
          nothingRuns(group),
          (stopped) => stopped,
          5_000,
          "the receipt's group stopped",
        )
        expect(yield* lines(`${dir}/ran.log`)).toEqual(["ran"])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )

  it.live(
    "an answer sent again after SIGKILL is admitted, and the work after it runs once",
    () =>
      Effect.gen(function* () {
        const dir = yield* fixtureDirectory
        yield* Effect.scoped(
          Effect.gen(function* () {
            // The hold keeps the answer's command from starting here, so the
            // kill cannot cut it.
            const first = yield* spawnHost(dir, "first", {
              MH_START: "gate",
              MH_ANSWER: "go",
              MH_HOLD_COMMAND: "1",
            })
            yield* hostPrinted(first, "started", 20_000)
            const sql = yield* database(dir)
            yield* waitFor(
              stepTags.pipe(Effect.provideContext(sql)),
              (tags) => tags.includes("Answered"),
              15_000,
              "the answer committed",
            )
            // The owner's step still runs its sleeping call: its turn is open at the kill.
            yield* pidIn(`${dir}/hold.pid`)
            yield* hardKill(first.proc)
          }),
        )
        expect(yield* lines(`${dir}/after.log`)).toEqual([])
        const sql = yield* database(dir)
        yield* spawnHost(dir, "second", { MH_REPEAT_ANSWER: "1" })
        // The answer's command runs once in the second host, and the run ends.
        yield* waitFor(
          stepTags.pipe(Effect.provideContext(sql)),
          (tags) => tags.includes("Notified"),
          30_000,
          "the end reached the owner",
        )
        expect(yield* lines(`${dir}/after.log`)).toEqual(["after"])
        const settled = yield* stepTags.pipe(Effect.provideContext(sql))
        // Now the owner sends the recorded answer again.
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/repeat.go`, "")
        const again = yield* waitFor(
          toolResults("again").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          30_000,
          "the repeated answer's result",
        )
        expect(again).toMatchObject([{ isFailure: false, result: { status: "admitted" } }])
        yield* waitFor(
          runRow.pipe(Effect.provideContext(sql)),
          (row) => Option.exists(row, (run) => run.status === "final"),
          30_000,
          "the run is final",
        )
        // The repeat applied nothing: no step, and no second run of the command.
        expect(yield* lines(`${dir}/after.log`)).toEqual(["after"])
        const tags = yield* stepTags.pipe(Effect.provideContext(sql))
        expect(tags).toEqual(settled)
        expect(count(tags, "Answered")).toBe(1)
        expect(count(tags, "CommandEnded")).toBe(1)
        expect(count(tags, "Finished")).toBe(1)
        expect(yield* endMessages.pipe(Effect.provideContext(sql))).toHaveLength(1)
        expect(yield* runRow.pipe(Effect.provideContext(sql))).toEqual(
          Option.some({ status: "final", state: "done" }),
        )
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )
})
