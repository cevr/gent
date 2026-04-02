/**
 * Custom Effect Logger — pretty (stderr) + JSON (file) modes.
 *
 * Based on loggingsucks.com principles: structured key-value data,
 * pretty for dev, JSON for prod.
 *
 * Uses Effect.annotateLogs for context (sessionId, branchId, agent, model).
 * Uses Effect.withLogSpan for timing data.
 */

import { Cause, Config, Effect, FileSystem, Layer, Logger, Option, ServiceMap } from "effect"
import type { PlatformError, Scope } from "effect"
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

const extractMessage = (message: unknown): string => {
  if (typeof message === "string") return message
  if (Array.isArray(message)) {
    return message.map((m) => (typeof m === "string" ? m : String(m))).join(" ")
  }
  return String(message)
}

const collectAnnotations = (
  annotations: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(annotations)) {
    result[k] = v
  }
  return result
}

const collectSpans = (
  spans: ReadonlyArray<[label: string, timestamp: number]>,
  now: number,
): Record<string, number> => {
  const result: Record<string, number> = {}
  for (const [label, startTime] of spans) {
    result[label] = now - startTime
  }
  return result
}

// =============================================================================
// Pretty Logger (stderr)
// =============================================================================

const prettyLogger: Logger.Logger<unknown, void> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const annots = collectAnnotations(annotations)
    const entries = Object.entries(annots)
    const color = levelColor(logLevel)
    const label = levelLabel(logLevel)

    // Header line: [HH:mm:ss.SSS] [traceId] LEVEL  message
    const tracePrefix =
      fiber.currentSpan !== undefined
        ? `${DIM}[${fiber.currentSpan.traceId.slice(0, 8)}]${RESET} `
        : ""
    let output = `${DIM}[${formatTime(date)}]${RESET} ${tracePrefix}${color}${label}${RESET}  ${BOLD}${msg}${RESET}`

    // Cause
    if (cause.reasons.length > 0) {
      output += `\n  ${"\x1b[31m"}${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}${RESET}`
    }

    // Tree-formatted annotations
    if (entries.length > 0) {
      for (const [i, [key, value]] of entries.entries()) {
        const isLast = i === entries.length - 1
        const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500"
        const formatted = typeof value === "string" ? value : JSON.stringify(value)
        output += `\n  ${DIM}${prefix}${RESET} ${key}: ${formatted}`
      }
    }

    // Spans as timing
    const now = date.getTime()
    const spanEntries = Object.entries(collectSpans(spans, now))
    if (spanEntries.length > 0 && entries.length === 0) {
      for (const [i, [key, ms]] of spanEntries.entries()) {
        const isLast = i === spanEntries.length - 1
        const prefix = isLast ? "\u2514\u2500" : "\u251C\u2500"
        output += `\n  ${DIM}${prefix}${RESET} ${key}: ${ms}ms`
      }
    }

    process.stderr.write(output + "\n")
  },
)

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

    const entry: Record<string, unknown> = {
      ts: date.toISOString(),
      level: logLevel,
      msg,
      ...annots,
    }

    if (fiber.currentSpan !== undefined) {
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

    return JSON.stringify(entry)
  },
)

const makeJsonFileLogger = (
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

import { resolveLogPaths, ensureLogDir, getLogPaths } from "./log-paths.js"

const clearLogFile = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* ensureLogDir
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.writeFileString(path, ""))
  })

// =============================================================================
// Exported Layers
// =============================================================================

/** JSON (file) logger by default. Set GENT_LOG_FORMAT=pretty|both for stderr output. */
export const GentLogger: Layer.Layer<
  never,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Layer.unwrap(
  Effect.gen(function* () {
    const { log: defaultLogFile } = yield* resolveLogPaths
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
    Effect.catchEager(() => {
      const fallback = getLogPaths().log
      return makeJsonFileLogger(fallback).pipe(
        Effect.map((jsonLogger) => Logger.layer([jsonLogger])),
        Effect.orElseSucceed(() => Logger.layer([prettyLogger])),
      )
    }),
  ),
)

/** JSON-only logger layer (for headless/prod). */
export const GentLoggerJson: Layer.Layer<
  never,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Layer.unwrap(
  Effect.gen(function* () {
    const { log: defaultLogFile } = yield* resolveLogPaths
    const logFileOpt = yield* Config.option(Config.string("GENT_LOG_FILE"))
    const logFile = Option.getOrElse(logFileOpt, () => defaultLogFile)
    const isSubprocess = Option.isSome(yield* Config.option(Config.string("GENT_TRACE_ID")))
    if (!isSubprocess) yield* clearLogFile(logFile)
    const jsonLogger = yield* makeJsonFileLogger(logFile)
    return Logger.layer([jsonLogger])
  }).pipe(
    Effect.catchEager(() => {
      const fallback = getLogPaths().log
      return makeJsonFileLogger(fallback).pipe(
        Effect.map((jsonLogger) => Logger.layer([jsonLogger])),
        Effect.orElseSucceed(() => Logger.layer([prettyLogger])),
      )
    }),
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
    return Layer.effectServices(Effect.succeed(ServiceMap.make(MinimumLogLevel, level)))
  }).pipe(
    Effect.catchEager(() =>
      Effect.succeed(
        Layer.effectServices(Effect.succeed(ServiceMap.make(MinimumLogLevel, "Info" as LogLevel))),
      ),
    ),
  ),
)
