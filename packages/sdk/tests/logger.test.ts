import { describe, expect, it } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Layer, Random, Schema } from "effect"
import {
  buildLogPaths,
  GentLogLevel,
  GentObservability,
  GentTracerLive,
  LOG_DIR,
} from "../src/logger"
import { resolveLogDir } from "../src/server"

// ── log paths ───────────────────────────────────────────────────────────────

describe("buildLogPaths", () => {
  it.effect("returns a deterministic shape under the central log dir", () =>
    Effect.sync(() => {
      const paths = buildLogPaths("/Users/example/repo", LOG_DIR)
      expect(paths.dir).toBe(LOG_DIR)
      expect(paths.log.startsWith(`${LOG_DIR}/`)).toBe(true)
      expect(paths.client.endsWith("-client.log")).toBe(true)
    }),
  )

  it.effect("produces distinct prefixes for distinct cwds", () =>
    Effect.sync(() => {
      const a = buildLogPaths("/path/a", LOG_DIR)
      const b = buildLogPaths("/path/b", LOG_DIR)
      expect(a.log).not.toBe(b.log)
    }),
  )
})

const logDirFor = (env: Record<string, string>) =>
  resolveLogDir.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

describe("resolveLogDir", () => {
  it.effect("a run with its own data directory keeps its logs there", () =>
    Effect.gen(function* () {
      expect(yield* logDirFor({ GENT_DATA_DIR: "/nonexistent/gent-scratch" })).toBe(
        "/nonexistent/gent-scratch/logs",
      )
    }),
  )

  it.effect("a run without a data directory uses the shared log directory", () =>
    Effect.gen(function* () {
      expect(yield* logDirFor({})).toBe(LOG_DIR)
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
      const logPath = buildLogPaths(cwd, LOG_DIR).log
      const fs = yield* FileSystem.FileSystem
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(GentObservability(cwd, "Debug", LOG_DIR))
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

  it.scopedLive("a second logger for the same cwd keeps the first one's lines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const logDir = yield* fs.makeTempDirectoryScoped()
      const cwd = "/logger-test/two-servers"
      const logOnce = (message: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(GentObservability(cwd, "Debug", logDir))
            yield* Effect.logInfo(message).pipe(
              Effect.annotateLogs({ sessionId: "s-1" }),
              Effect.provideContext(context),
            )
          }),
        )
      // One process, two servers: both write the same log path.
      yield* logOnce("first-server")
      yield* logOnce("second-server")
      const lines = (yield* fs.readFileString(buildLogPaths(cwd, logDir).log)).trim().split("\n")
      expect(lines.map((line) => decodeLogEntry(line).msg)).toEqual([
        "first-server",
        "second-server",
      ])
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )
})

// ── tracer ──────────────────────────────────────────────────────────────────

const tracerWithConfig = (env: Record<string, string>) =>
  Layer.provide(GentTracerLive, ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

describe("tracer configuration", () => {
  it.live("keeps the default Effect tracer when OTLP is not configured", () =>
    Effect.suspend(
      Effect.fn("tracer.no-otel")(function* () {
        const span = yield* Effect.currentSpan
        expect(span.constructor.name).not.toBe("OtelSpan")
      }),
    ).pipe(Effect.provide(tracerWithConfig({}))),
  )

  it.live("installs the OpenTelemetry tracer when OTLP is configured", () =>
    Effect.suspend(
      Effect.fn("tracer.otel")(function* () {
        const span = yield* Effect.currentSpan
        expect(span.constructor.name).toBe("OtelSpan")
      }),
    ).pipe(
      Effect.provide(
        tracerWithConfig({
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
          OTEL_SERVICE_NAME: "gent-test",
        }),
      ),
    ),
  )
})

// ── log level ───────────────────────────────────────────────────────────────

const logLevelWith = (env: Record<string, string>) =>
  Effect.provideService(
    GentLogLevel,
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromEnvRecord(env),
  )

describe("GENT_LOG_LEVEL", () => {
  it.effect("unset keeps the Debug floor", () =>
    Effect.gen(function* () {
      expect(yield* logLevelWith({})).toBe("Debug")
    }),
  )

  it.effect("each level name maps to its own level", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["trace", "Trace"],
        ["debug", "Debug"],
        ["info", "Info"],
        ["warn", "Warn"],
        ["error", "Error"],
        ["fatal", "Fatal"],
      ]
      for (const [name, level] of cases) {
        expect(String(yield* logLevelWith({ GENT_LOG_LEVEL: name }))).toBe(level)
      }
    }),
  )

  it.effect("an unknown name fails with a config error that names the variable", () =>
    Effect.gen(function* () {
      const error = yield* logLevelWith({ GENT_LOG_LEVEL: "verbose" }).pipe(Effect.flip)
      expect(String(error)).toContain("GENT_LOG_LEVEL")
    }),
  )
})
