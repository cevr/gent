/**
 * Machines across a hard kill. A real host process (`src/machine-host.ts`)
 * runs a machine on routed fake models over a SQLite file; the test ends it
 * with SIGKILL, so no finalizer runs, then starts a second host over the same
 * files with no client call of its own. Counts come from files the fake
 * models and the commands append to (`calls.log`, `ran.log`), outside the
 * database under test.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Ref, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { fileURLToPath } from "node:url"
import { BunSqlite } from "@gent/core/host-bun"
import { makeTempDirectoryScoped, waitFor } from "@gent/core/test-utils"
import { exitWithin, killProcess } from "../src/server-process-fixture"

// ── the host process ────────────────────────────────────────────────────────

const E2E_DIRECTORY = fileURLToPath(new URL("..", import.meta.url))

interface Host {
  readonly proc: Bun.Subprocess<"ignore", "pipe", Bun.BunFile>
  /** The `MH <event>` lines the host printed, in order, without the prefix. */
  readonly events: Ref.Ref<ReadonlyArray<string>>
}

/**
 * Spawns a host over `dir` (its data dir and its cwd). The scope kills it
 * with SIGKILL if the test has not; its stderr goes to `<dir>/<label>.err`.
 */
const spawnHost = (dir: string, label: string, env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() =>
        // oxlint-disable-next-line effect/noGlobals -- the test spawns the real host process with the test's environment
        Bun.spawn(["bun", "src/machine-host.ts"], {
          cwd: E2E_DIRECTORY,
          env: {
            // oxlint-disable-next-line effect/noGlobals -- the test spawns the real host process with the test's environment
            ...Bun.env,
            GENT_DATA_DIR: dir,
            MH_HOME: dir,
            MH_CWD: dir,
            ...env,
          },
          stdin: "ignore",
          stdout: "pipe",
          // oxlint-disable-next-line effect/noGlobals -- the host's log goes to a file the test leaves for a failed run
          stderr: Bun.file(`${dir}/${label}.err`),
        }),
      ),
      (child) => hardKill(child),
    )
    const events = yield* Ref.make<ReadonlyArray<string>>([])
    yield* Stream.fromReadableStream({ evaluate: () => proc.stdout, onError: String }).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("MH ")),
      Stream.runForEach((line) => Ref.update(events, (seen) => [...seen, line.slice(3)])),
      Effect.ignore,
      Effect.forkScoped,
    )
    const host: Host = { proc, events }
    return host
  })

const hostPrinted = (host: Host, event: string, within: number) =>
  waitFor(Ref.get(host.events), (seen) => seen.includes(event), within, `the host printed ${event}`)

/** SIGKILL, then its exit: no finalizer of the host runs. */
const hardKill = (proc: Bun.Subprocess<"ignore", "pipe", Bun.BunFile>) =>
  killProcess(proc, "SIGKILL").pipe(Effect.andThen(exitWithin(proc.exited, "5 seconds")))

/** True while a process with `pid` exists (signal 0). */
const alive = (pid: number) =>
  Effect.try(() => {
    process.kill(pid, 0)
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Ends a process group a failed test left running; a group already gone is fine. */
const killGroup = (pid: number) =>
  Effect.try(() => {
    process.kill(-pid, "SIGKILL")
  }).pipe(Effect.ignore)

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
    "a round cut by SIGKILL runs on under its key, and the run goes on with no user message",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-machine-kill-")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", { MH_START: "track", MH_HANG: "review:2" })
            yield* hostPrinted(first, "round review:2", 20_000)
            yield* hardKill(first.proc)
          }),
        )
        const sql = yield* database(dir)
        yield* spawnHost(dir, "second", {})
        // The second host makes no client call: the run's own record, fired by
        // the wake clock's start pass, wakes it. The cluster's redelivery of
        // the driver's keep-alive would build the host too, but only after its
        // 10 s storage-read retry (measured), so the bound tells them apart.
        const asked = yield* waitFor(
          runRow.pipe(Effect.provideContext(sql)),
          (row) => Option.exists(row, (run) => run.status === "asking"),
          8_000,
          "the run asked",
        )
        const asks = yield* waitFor(
          ownerMessages("machine-ask").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          10_000,
          "the ask reached the owner",
        )
        // Each completed round ran once; the cut one ran once more, under its key.
        expect(yield* lines(`${dir}/calls.log`)).toEqual([
          "implement:1:1",
          "review:1:1",
          "implement:2:1",
          "review:2:1",
          "review:2:2",
        ])
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
        const dir = yield* makeTempDirectoryScoped("gent-machine-kill-")
        const jobPid = yield* Effect.scoped(
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
            const pid = yield* pidIn(`${dir}/job.pid`)
            yield* hardKill(first.proc)
            return pid
          }),
        )
        yield* Effect.addFinalizer(() => killGroup(jobPid))
        // No finalizer ran: the command outlived its server.
        expect(yield* alive(jobPid)).toBe(true)
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
        yield* waitFor(alive(jobPid), (running) => !running, 5_000, "the recorded group stopped")
        expect(yield* lines(`${dir}/ran.log`)).toEqual(["ran"])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )

  it.live(
    "a command killed before its process was recorded is stopped from its receipt",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-machine-kill-")
        const jobPid = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", {
              MH_START: "verify",
              MH_HOLD_RECORD: "1",
            })
            yield* hostPrinted(first, "started", 20_000)
            const pid = yield* pidIn(`${dir}/job.pid`)
            yield* hardKill(first.proc)
            return pid
          }),
        )
        yield* Effect.addFinalizer(() => killGroup(jobPid))
        const sql = yield* database(dir)
        const tags = yield* stepTags.pipe(Effect.provideContext(sql))
        // The hold kept the record out: only the launcher's receipt names the process.
        expect(tags).not.toContain("Recorded")
        expect(yield* alive(jobPid)).toBe(true)
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
        yield* waitFor(alive(jobPid), (running) => !running, 5_000, "the receipt's group stopped")
        expect(yield* lines(`${dir}/ran.log`)).toEqual(["ran"])
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )

  it.live(
    "an answer sent again after SIGKILL is admitted and applies once",
    () =>
      Effect.gen(function* () {
        const dir = yield* makeTempDirectoryScoped("gent-machine-kill-")
        const holdPid = yield* Effect.scoped(
          Effect.gen(function* () {
            const first = yield* spawnHost(dir, "first", { MH_START: "gate", MH_ANSWER: "go" })
            yield* hostPrinted(first, "started", 20_000)
            const sql = yield* database(dir)
            yield* waitFor(
              stepTags.pipe(Effect.provideContext(sql)),
              (tags) => tags.includes("Answered"),
              15_000,
              "the answer committed",
            )
            // The owner's step still runs its sleeping call: its turn is open at the kill.
            const pid = yield* pidIn(`${dir}/hold.pid`)
            yield* hardKill(first.proc)
            return pid
          }),
        )
        yield* Effect.addFinalizer(() => killGroup(holdPid))
        const sql = yield* database(dir)
        yield* spawnHost(dir, "second", { MH_REPEAT_ANSWER: "1" })
        const again = yield* waitFor(
          toolResults("again").pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          30_000,
          "the repeated answer's result",
        )
        expect(again).toMatchObject([{ isFailure: false, result: { status: "admitted" } }])
        yield* waitFor(
          endMessages.pipe(Effect.provideContext(sql)),
          (read) => read.length > 0,
          30_000,
          "the end reached the owner",
        )
        const tags = yield* stepTags.pipe(Effect.provideContext(sql))
        expect(count(tags, "Answered")).toBe(1)
        expect(count(tags, "Moved")).toBe(1)
        expect(count(tags, "Finished")).toBe(1)
        expect(yield* endMessages.pipe(Effect.provideContext(sql))).toHaveLength(1)
        expect(yield* runRow.pipe(Effect.provideContext(sql))).toEqual(
          Option.some({ status: "final", state: "done" }),
        )
      }).pipe(Effect.scoped, Effect.timeout("55 seconds"), Effect.provide(BunServices.layer)),
    60_000,
  )
})
