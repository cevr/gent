/**
 * Custom Effect Logger — one JSON line per entry, appended to a file.
 *
 * Based on loggingsucks.com principles: structured key-value data.
 *
 * Uses Effect.annotateLogs for context (sessionId, branchId, agent, model).
 * Uses Effect.withLogSpan for timing data.
 */

import {
  Predicate,
  Cause,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect"

import type { LogLevel } from "effect/LogLevel"
import type { PlatformError, Scope } from "effect"
import { CurrentLogAnnotations, CurrentLogSpans, MinimumLogLevel } from "effect/References"

// =============================================================================
// Helpers
// =============================================================================

// oxlint-disable-next-line effect/noUnknownParameters -- Effect logger messages are an external logger boundary.
const extractMessage = (message: unknown): string => {
  if (Predicate.isString(message)) return message
  if (Array.isArray(message)) {
    return message
      .map((m) => {
        if (Predicate.isString(m)) return m
        return String(m)
      })
      .join(" ")
  }
  return String(message)
}

const decodeJsonValue = Schema.decodeUnknownOption(Schema.Json)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type LogAnnotations =
  typeof CurrentLogAnnotations extends Context.Service<never, infer Value> ? Value : never

const collectAnnotations = (annotations: LogAnnotations) =>
  Object.fromEntries(
    Object.entries(annotations).map(([key, value]) => [
      key,
      Option.getOrElse(decodeJsonValue(value), () => String(value)),
    ]),
  )

const collectSpans = (spans: ReadonlyArray<[label: string, timestamp: number]>, now: number) =>
  Object.fromEntries(spans.map(([label, startTime]) => [label, now - startTime]))

// =============================================================================
// JSON File Logger
// =============================================================================

const formatJsonLogger: Logger.Logger<unknown, string> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const annots = collectAnnotations(annotations)
    const now = date.getTime()
    const spanEntries = collectSpans(spans, now)

    const entry = Object.assign(
      {
        ts: date.toISOString(),
        level: logLevel,
        msg,
      },
      annots,
    )

    if (!Predicate.isUndefined(fiber.currentSpan)) {
      entry["traceId"] = fiber.currentSpan.traceId
      entry["spanId"] = fiber.currentSpan.spanId
      if (fiber.currentSpan._tag === "Span") {
        entry["spanName"] = fiber.currentSpan.name
      }
    }

    if (Object.keys(spanEntries).length > 0) {
      entry["spans"] = spanEntries
    }

    if (cause.reasons.length > 0) {
      entry["cause"] = Cause.pretty(cause).split("\n")[0] ?? "unknown error"
    }

    return encodeJson(entry)
  },
)

/**
 * Batched JSON file logger: one entry per line, appended to `path`, flushed
 * every 250 ms and once more when the scope closes. The server and the TUI
 * client both write this shape, so `gent doctor` reads one format.
 */
export const makeJsonFileLogger = (
  path: string,
): Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const logFile = yield* fs.open(path, { flag: "a+" })
    const encoder = new TextEncoder()
    return yield* Logger.batched(formatJsonLogger, {
      window: 250,
      flush: (output) => Effect.ignore(logFile.write(encoder.encode(output.join("\n") + "\n"))),
    })
  })

// =============================================================================
// Config
// =============================================================================

import { buildLogPaths, ensureLogDir } from "./log-paths.js"
import { GentTracerLive } from "./tracer.js"

const clearLogFile = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* ensureLogDir
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.writeFileString(path, ""))
  })

// =============================================================================
// Exported Layers
// =============================================================================

/**
 * JSON file logger under the cwd's server log path.
 *
 * Cwd is threaded explicitly from the dependency graph so the server log
 * path matches the launcher's resolved cwd. Falling back to ambient env
 * risked the two ends hashing different identities.
 */
const GentLogger = (cwd: string): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const logFile = buildLogPaths(cwd).log
      yield* clearLogFile(logFile)
      const jsonLogger = yield* makeJsonFileLogger(logFile)
      return Logger.layer([jsonLogger])
    }).pipe(Effect.orElseSucceed(() => Layer.empty)),
  )

/** Minimum log level — filters out Trace/Debug in non-dev. */
const GentLogLevel: Layer.Layer<never> = Layer.unwrap(
  Effect.gen(function* () {
    const envOpt = yield* Config.option(Config.string("GENT_LOG_LEVEL"))
    const env = Option.getOrUndefined(envOpt)
    const level: LogLevel = (() => {
      switch (env) {
        case "trace":
          return "Trace"
        case "info":
          return "Info"
        case "warning":
          return "Warn"
        case "error":
          return "Error"
        default:
          return "Debug"
      }
    })()
    return Layer.effectContext(Effect.succeed(Context.make(MinimumLogLevel, level)))
  }).pipe(
    Effect.catchEager(() =>
      Effect.succeed(Layer.effectContext(Effect.succeed(Context.make(MinimumLogLevel, "Info")))),
    ),
  ),
)

/** File logger under `/tmp/gent/logs`, the `GENT_LOG_LEVEL` floor, and OTLP tracing when configured. */
export const GentObservability = (cwd: string): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.mergeAll(GentLogger(cwd), GentLogLevel, GentTracerLive)
