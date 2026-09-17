/**
 * The client log file and the doctor's log section.
 *
 * Both halves read and write `LOG_DIR`, the one shared directory a live gent
 * also writes to. They stay in one file so the test runner keeps them in a
 * single worker: the directory-creation test removes the directory, and a
 * concurrent reader in another worker would lose its fixtures to that removal.
 *
 * The SDK owns the log directory and the file-naming rule, so `inspectLogs`
 * only reads what it is told: the newest file each side wrote, and nothing for
 * a name neither side claims.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Logger, Option, Random, Schema } from "effect"
import { MinimumLogLevel } from "effect/References"
import { classifyLogFile, LOG_DIR, makeJsonFileLogger } from "@gent/sdk"
import { CLIENT_LOG_PATH } from "../src/utils/client-logger"
import { clientTraceLogger } from "../src/utils/client-trace-logger"
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
const writeLog = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = `${LOG_DIR}/${name}`
    yield* fs.writeFileString(path, "{}\n")
    return path
  })

describe("client trace logger", () => {
  it.scopedLive("creates the log directory it writes into", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // No module import creates this directory any more: the scoped logger
      // makes it before opening the file. Removing it and building the logger
      // is the whole protection.
      yield* Effect.ignore(fs.remove(LOG_DIR, { recursive: true }))
      expect(yield* fs.exists(LOG_DIR)).toBe(false)

      yield* Effect.scoped(Effect.asVoid(clientTraceLogger))

      expect(yield* fs.exists(LOG_DIR)).toBe(true)
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("writes the SDK JSON line format at the client log path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const marker = `trace-receipt-${yield* Random.nextInt}`
      const serverStylePath = `${CLIENT_LOG_PATH}.${marker}`
      const emit = emitOneEntry(marker)
      yield* Effect.scoped(Effect.flatMap(clientTraceLogger, emit))
      yield* Effect.scoped(Effect.flatMap(makeJsonFileLogger(serverStylePath), emit))

      const clientLine = yield* findLineByMarker(CLIENT_LOG_PATH, marker)
      const serverLine = yield* findLineByMarker(serverStylePath, marker)
      yield* Effect.ignore(fs.remove(serverStylePath))

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
  it.live("reports the newest file each side wrote and ignores unrelated names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(LOG_DIR, { recursive: true }).pipe(Effect.ignore)

      // Written oldest first; the last write of each kind is the newest.
      const older = yield* writeLog("00000001-20260915120000-server.log")
      const client = yield* writeLog("00000002-20260915140000-client.log")
      const newer = yield* writeLog("00000003-20260915130000-server.log")
      // Newest file of all, and not a log: the classifier must refuse it.
      const ignored = yield* writeLog("00000004-notes.txt")
      const written = [older, client, newer, ignored]

      const logs = yield* inspectLogs.pipe(
        Effect.ensuring(
          Effect.forEach(written, (path) => fs.remove(path).pipe(Effect.ignore), {
            discard: true,
          }),
        ),
      )

      expect(logs.dir).toBe(LOG_DIR)
      // A name neither side claims never wins, however new it is.
      expect(logs.latestServer).not.toBe(ignored)
      expect(logs.latestClient).not.toBe(ignored)
      // Among this test's own server logs the later write wins.
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
      // The client fixture is the only client log this test wrote.
      expect([client, logs.latestClient]).toContain(client)
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunServices.layer)),
  )
})
