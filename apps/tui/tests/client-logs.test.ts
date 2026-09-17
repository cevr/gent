/**
 * The client log file and the doctor's log section.
 *
 * Every case runs against a directory it creates and owns. `/tmp/gent/logs`
 * belongs to a live gent, so a test that removed it would take a running
 * instance's logs with it, and a test that read it would race whatever else
 * writes there.
 *
 * The SDK owns the file-naming rule, so `inspectLogs` only reports what it is
 * told: the newest file each side wrote, and nothing for a name neither side
 * claims.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Logger, Option, Random, Schema } from "effect"
import { MinimumLogLevel } from "effect/References"
import { classifyLogFile, makeJsonFileLogger } from "@gent/sdk"
import { makeClientTraceLogger } from "../src/utils/client-trace-logger"
import { inspectLogs } from "../src/ops/local-health"

/** The line shape `gent doctor` reads from both the server and the client log. */
const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    ts: Schema.String,
    level: Schema.String,
    msg: Schema.String,
    sessionId: Schema.String,
    traceId: Schema.String,
    spanId: Schema.String,
    spanName: Schema.String,
    spans: Schema.Record(Schema.String, Schema.Finite),
  }),
)
const decodeLogEntry = Schema.decodeUnknownSync(LogEntry)
const decodeJsonLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const emitOneEntry = (marker: string) => (logger: Logger.Logger<unknown, void>) =>
  Effect.logInfo(marker).pipe(
    Effect.annotateLogs({ sessionId: "s-1" }),
    Effect.withLogSpan("turn"),
    Effect.withSpan("receipt-span"),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(MinimumLogLevel, "Info"),
  )

/** Other tests append to the shared client log; pick this test's line by its marker. */
const findLineByMarker = (path: string, marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lines = (yield* fs.readFileString(path)).split("\n")
    const own = lines.find((line) =>
      Option.exists(decodeJsonLine(line), (entry) => entry["msg"] === marker),
    )
    return Option.getOrElse(Option.fromNullishOr(own), () => "")
  })

/** The name `classifyLogFile` reads, from a full path. */
const basename = (path: Option.Option<string>): string =>
  Option.getOrElse(
    Option.map(path, (value) =>
      Option.getOrElse(Option.fromUndefinedOr(value.split("/").at(-1)), () => value),
    ),
    () => "",
  )

/**
 * `inspectLogs` orders by mtime. Fixtures are written in order so each is newer
 * than the last, and removed again on the way out; assertions compare only
 * files this test created, never "newest in the directory".
 */
const writeLog = (dir: string, name: string, ageRank: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = `${dir}/${name}`
    yield* fs.writeFileString(path, "{}\n")
    // Four writes land in one millisecond, and `inspectLogs` orders by
    // millisecond mtime, so the order has to be stamped rather than assumed.
    const seconds = 1_757_000_000 + ageRank
    yield* fs.utimes(path, seconds, seconds)
    return path
  })

describe("client trace logger", () => {
  it.scopedLive("creates the log directory it writes into", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // No module import creates the directory: the scoped logger makes it
      // before opening the file. Naming a directory that does not exist and
      // building the logger is the whole protection.
      const root = yield* fs.makeTempDirectoryScoped()
      const dir = `${root}/logs`
      const path = `${dir}/00000000-20260917000000-client.log`
      expect(yield* fs.exists(dir)).toBe(false)

      yield* Effect.scoped(Effect.asVoid(makeClientTraceLogger(dir, path)))

      expect(yield* fs.exists(dir)).toBe(true)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("writes the SDK JSON line format at the client log path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const marker = `trace-receipt-${yield* Random.nextInt}`
      const dir = yield* fs.makeTempDirectoryScoped()
      const clientPath = `${dir}/00000000-20260917000000-client.log`
      const serverStylePath = `${dir}/00000000-20260917000000-server.log`
      const emit = emitOneEntry(marker)
      yield* Effect.scoped(Effect.flatMap(makeClientTraceLogger(dir, clientPath), emit))
      yield* Effect.scoped(Effect.flatMap(makeJsonFileLogger(serverStylePath), emit))

      const clientLine = yield* findLineByMarker(clientPath, marker)
      const serverLine = yield* findLineByMarker(serverStylePath, marker)

      const clientEntry = decodeLogEntry(clientLine)
      const serverEntry = decodeLogEntry(serverLine)
      const keysOf = (line: string) =>
        Object.keys(Option.getOrElse(decodeJsonLine(line), () => ({}))).sort()
      expect(keysOf(clientLine)).toEqual(keysOf(serverLine))
      expect(clientEntry.msg).toBe(marker)
      expect(clientEntry.level).toBe("Info")
      expect(clientEntry.sessionId).toBe("s-1")
      expect(clientEntry.spanName).toBe("receipt-span")
      expect(Object.keys(clientEntry.spans)).toEqual(["turn"])
      expect(serverEntry.msg).toBe(marker)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})

describe("log file classification", () => {
  it.live("names each side by its suffix and claims nothing else", () =>
    Effect.sync(() => {
      expect(classifyLogFile("abc12345-20260915120000-server.log")).toEqual(Option.some("server"))
      expect(classifyLogFile("abc12345-20260915120000-client.log")).toEqual(Option.some("client"))
      expect(classifyLogFile("notes.txt")).toEqual(Option.none())
      expect(classifyLogFile("server.log")).toEqual(Option.none())
    }),
  )
})

describe("inspect logs", () => {
  it.scopedLive("reports the newest file each side wrote and ignores unrelated names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()

      // Written oldest first; the last write of each kind is the newest.
      const older = yield* writeLog(dir, "00000001-20260915120000-server.log", 1)
      const client = yield* writeLog(dir, "00000002-20260915140000-client.log", 2)
      const newer = yield* writeLog(dir, "00000003-20260915130000-server.log", 3)
      // Newest file of all, and not a log: the classifier must refuse it.
      const ignored = yield* writeLog(dir, "00000004-notes.txt", 4)

      const logs = yield* inspectLogs(dir)

      expect(logs.dir).toBe(dir)
      // A name neither side claims never wins, however new it is.
      expect(logs.latestServer).not.toBe(ignored)
      expect(logs.latestClient).not.toBe(ignored)
      // The directory holds only this test's files, so each side has one answer.
      expect(logs.latestServer).toBe(newer)
      expect(logs.latestClient).toBe(client)
      expect(logs.latestServer).not.toBe(older)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestServer))),
          "server",
        ),
      ).toBe(true)
      expect(
        Option.contains(
          classifyLogFile(basename(Option.fromUndefinedOr(logs.latestClient))),
          "client",
        ),
      ).toBe(true)
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
})
