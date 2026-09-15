import { describe, expect, it } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Logger, Option, Random, Schema } from "effect"
import { MinimumLogLevel } from "effect/References"
import { makeJsonFileLogger } from "@gent/sdk"
import { CLIENT_LOG_PATH } from "../src/utils/client-logger"
import { clientTraceLogger } from "../src/utils/client-trace-logger"

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

describe("client trace logger", () => {
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
