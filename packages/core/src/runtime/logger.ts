/**
 * Custom Effect Logger — pretty (stderr) + JSON (file) modes.
 *
 * Based on loggingsucks.com principles: structured key-value data,
 * pretty for dev, JSON for prod.
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
import { CurrentLogAnnotations, CurrentLogSpans, MinimumLogLevel } from "effect/References"

// =============================================================================
// Helpers
// =============================================================================

const formatTime = (date: Date): string => {
  const h = date.getHours().toString().padStart(2, "0")
  const m = date.getMinutes().toString().padStart(2, "0")
  const s = date.getSeconds().toString().padStart(2, "0")
  const ms = date.getMilliseconds().toString().padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
}

const levelLabel = (level: LogLevel): string => {
  switch (level) {
    case "Trace":
      return "TRACE"
    case "Debug":
      return "DEBUG"
    case "Info":
      return "INFO "
    case "Warn":
      return "WARN "
    case "Error":
      return "ERROR"
    case "Fatal":
      return "FATAL"
    default:
      return "     "
  }
}

const levelColor = (level: LogLevel): string => {
  switch (level) {
    case "Trace":
      return "\x1b[90m" // gray
    case "Debug":
      return "\x1b[34m" // blue
    case "Info":
      return "\x1b[32m" // green
    case "Warn":
      return "\x1b[33m" // yellow
    case "Error":
      return "\x1b[31m" // red
    case "Fatal":
      return "\x1b[41m\x1b[30m" // red bg, black text
    default:
      return ""
  }
}

const RESET = "\x1b[0m"
const DIM = "\x1b[90m"
const BOLD = "\x1b[1m"

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
// Pretty Logger (stderr)
// =============================================================================

const formatPretty: Logger.Logger<unknown, string> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const annots = collectAnnotations(annotations)
    const entries = Object.entries(annots)
    const color = levelColor(logLevel)
    const label = levelLabel(logLevel)

    let tracePrefix = ""
    if (!Predicate.isUndefined(fiber.currentSpan)) {
      tracePrefix = `${DIM}[${fiber.currentSpan.traceId.slice(0, 8)}]${RESET} `
    }
    let output = `${DIM}[${formatTime(date)}]${RESET} ${tracePrefix}${color}${label}${RESET}  ${BOLD}${msg}${RESET}`

    if (cause.reasons.length > 0) {
      output += `\n  ${"\x1b[31m"}${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}${RESET}`
    }

    if (entries.length > 0) {
      for (const [i, [key, value]] of entries.entries()) {
        const isLast = i === entries.length - 1
        let prefix = "\u251C\u2500"
        if (isLast) prefix = "\u2514\u2500"
        const formatted = encodeJson(value)
        output += `\n  ${DIM}${prefix}${RESET} ${key}: ${formatted}`
      }
    }

    const now = date.getTime()
    const spanEntries = Object.entries(collectSpans(spans, now))
    if (spanEntries.length > 0 && entries.length === 0) {
      for (const [i, [key, ms]] of spanEntries.entries()) {
        const isLast = i === spanEntries.length - 1
        let prefix = "\u251C\u2500"
        if (isLast) prefix = "\u2514\u2500"
        output += `\n  ${DIM}${prefix}${RESET} ${key}: ${ms}ms`
      }
    }

    return output
  },
)

const prettyLogger: Logger.Logger<unknown, void> = Logger.withConsoleError(formatPretty)

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

const makeJsonFileLogger = (path: string) =>
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
 * JSON (file) logger by default. Set GENT_LOG_FORMAT=pretty|both for stderr output.
 *
 * Cwd is threaded explicitly from the dependency graph so the server log
 * path matches the launcher's resolved cwd. Falling back to ambient env
 * risked the two ends hashing different identities.
 */
export const GentLogger = (cwd: string): Layer.Layer<never, never, FileSystem.FileSystem> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const defaultLogFile = buildLogPaths(cwd).log
      const formatOpt = yield* Config.option(Config.string("GENT_LOG_FORMAT"))
      const format = Option.getOrElse(formatOpt, () => "json")
      const logFileOpt = yield* Config.option(Config.string("GENT_LOG_FILE"))
      const logFile = Option.getOrElse(logFileOpt, () => defaultLogFile)
      // Don't truncate when running as subprocess — parent is writing to same file
      const isSubprocess = Option.isSome(yield* Config.option(Config.string("GENT_TRACE_ID")))

      if (format === "pretty") {
        return Logger.layer([prettyLogger])
      }

      if (format === "both") {
        if (!isSubprocess) yield* clearLogFile(logFile)
        const jsonLogger = yield* makeJsonFileLogger(logFile)
        return Logger.layer([prettyLogger, jsonLogger])
      }

      // json (default)
      if (!isSubprocess) yield* clearLogFile(logFile)
      const jsonLogger = yield* makeJsonFileLogger(logFile)
      return Logger.layer([jsonLogger])
    }).pipe(
      Effect.catchEager(() =>
        makeJsonFileLogger(buildLogPaths(cwd).log).pipe(
          Effect.map((jsonLogger) => Logger.layer([jsonLogger])),
          Effect.orElseSucceed(() => Logger.layer([prettyLogger])),
        ),
      ),
    ),
  )

/** Pretty-only logger layer (for testing/debugging). */
export const GentLoggerPretty: Layer.Layer<never> = Logger.layer([prettyLogger])

/** Minimum log level — filters out Trace/Debug in non-dev. */
export const GentLogLevel: Layer.Layer<never> = Layer.unwrap(
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
