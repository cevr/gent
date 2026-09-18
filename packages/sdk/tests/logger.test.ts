import { describe, expect, it } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Random, Schema } from "effect"
import { buildLogPaths, GentObservability, LOG_DIR } from "../src/logger"

describe("buildLogPaths", () => {
  it.effect("returns a deterministic shape under the central log dir", () =>
    Effect.sync(() => {
      const paths = buildLogPaths("/Users/example/repo")
      expect(paths.dir).toBe(LOG_DIR)
      expect(paths.log.startsWith(`${LOG_DIR}/`)).toBe(true)
      expect(paths.client.endsWith("-client.log")).toBe(true)
    }),
  )

  it.effect("produces distinct prefixes for distinct cwds", () =>
    Effect.sync(() => {
      const a = buildLogPaths("/path/a")
      const b = buildLogPaths("/path/b")
      expect(a.log).not.toBe(b.log)
    }),
  )
})

const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    ts: Schema.String,
    level: Schema.String,
    msg: Schema.String,
    sessionId: Schema.String,
  }),
)
const decodeLogEntry = Schema.decodeUnknownSync(LogEntry)

describe("GentObservability", () => {
  it.scopedLive("writes one JSON line per log entry to the cwd's server log", () =>
    Effect.gen(function* () {
      const cwd = `/logger-test/${yield* Random.nextInt}`
      const logPath = buildLogPaths(cwd).log
      const fs = yield* FileSystem.FileSystem
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(GentObservability(cwd))
          yield* Effect.logInfo("hello-from-test").pipe(
            Effect.annotateLogs({ sessionId: "s-1" }),
            Effect.provideContext(context),
          )
        }),
      )
      const lines = (yield* fs.readFileString(logPath)).trim().split("\n")
      yield* Effect.ignore(fs.remove(logPath))
      expect(lines.length).toBe(1)
      const entry = decodeLogEntry(lines[0])
      expect(entry.msg).toBe("hello-from-test")
      expect(entry.level).toBe("Info")
      expect(entry.sessionId).toBe("s-1")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})
