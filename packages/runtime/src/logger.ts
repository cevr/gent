/**
 * Custom Effect Logger — pretty (stderr) + JSON (file) modes.
 *
 * Based on loggingsucks.com principles: structured key-value data,
 * pretty for dev, JSON for prod.
 *
 * Uses Effect.annotateLogs for context (sessionId, branchId, agent, model).
 * Uses Effect.withLogSpan for timing data.
 */

import { Cause, HashMap, List, Logger, LogLevel } from "effect"
import type { Layer } from "effect"
import { appendFileSync, writeFileSync } from "node:fs"

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

const levelLabel = (level: LogLevel.LogLevel): string => {
  switch (level._tag) {
    case "Trace":
      return "TRACE"
    case "Debug":
      return "DEBUG"
    case "Info":
      return "INFO "
    case "Warning":
      return "WARN "
    case "Error":
      return "ERROR"
    case "Fatal":
      return "FATAL"
    default:
      return "     "
  }
}

const levelColor = (level: LogLevel.LogLevel): string => {
  switch (level._tag) {
    case "Trace":
      return "\x1b[90m" // gray
    case "Debug":
      return "\x1b[34m" // blue
    case "Info":
      return "\x1b[32m" // green
    case "Warning":
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
  annotations: HashMap.HashMap<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  if (HashMap.size(annotations) > 0) {
    for (const [k, v] of annotations) {
      result[k] = v
    }
  }
  return result
}

const collectSpans = (
  spans: List.List<{ label: string; startTime: number }>,
  now: number,
): Record<string, number> => {
  const result: Record<string, number> = {}
  if (List.isCons(spans)) {
    for (const span of spans) {
      result[span.label] = now - span.startTime
    }
  }
  return result
}

// =============================================================================
// Pretty Logger (stderr)
// =============================================================================

const prettyLogger: Logger.Logger<unknown, void> = Logger.make(
  ({ logLevel, message, annotations, spans, date, cause }) => {
    const msg = extractMessage(message)
    const annots = collectAnnotations(annotations)
    const entries = Object.entries(annots)
    const color = levelColor(logLevel)
    const label = levelLabel(logLevel)

    // Header line: [HH:mm:ss.SSS] LEVEL  message
    let output = `${DIM}[${formatTime(date)}]${RESET} ${color}${label}${RESET}  ${BOLD}${msg}${RESET}`

    // Cause
    if (!Cause.isEmpty(cause)) {
      output += `\n  ${"\x1b[31m"}${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}${RESET}`
    }

    // Tree-formatted annotations
    if (entries.length > 0) {
      for (const [i, [key, value]] of entries.entries()) {
        const isLast = i === entries.length - 1
        const prefix = isLast ? "└─" : "├─"
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
        const prefix = isLast ? "└─" : "├─"
        output += `\n  ${DIM}${prefix}${RESET} ${key}: ${ms}ms`
      }
    }

    process.stderr.write(output + "\n")
  },
)

// =============================================================================
// JSON File Logger
// =============================================================================

const makeJsonFileLogger = (path: string): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message, annotations, spans, date, cause }) => {
    const msg = extractMessage(message)
    const annots = collectAnnotations(annotations)
    const now = date.getTime()
    const spanEntries = collectSpans(spans, now)

    const entry: Record<string, unknown> = {
      ts: date.toISOString(),
      level: logLevel.label,
      msg,
      ...annots,
    }

    if (Object.keys(spanEntries).length > 0) {
      entry["spans"] = spanEntries
    }

    if (!Cause.isEmpty(cause)) {
      entry["cause"] = Cause.pretty(cause).split("\n")[0] ?? "unknown error"
    }

    try {
      appendFileSync(path, JSON.stringify(entry) + "\n")
    } catch {
      // ignore write errors
    }
  })

// =============================================================================
// Config
// =============================================================================

const DEFAULT_LOG_FILE = "/tmp/gent.log"

const getLogFormat = (): "pretty" | "json" | "both" => {
  const env = Bun.env["GENT_LOG_FORMAT"]
  if (env === "pretty" || env === "json" || env === "both") return env
  return "json"
}

const getLogFile = (): string => Bun.env["GENT_LOG_FILE"] ?? DEFAULT_LOG_FILE

// Truncate log file on startup
const clearLogFile = (path: string): void => {
  try {
    writeFileSync(path, "")
  } catch {
    // ignore
  }
}

// =============================================================================
// Exported Layers
// =============================================================================

/** JSON (file) logger by default. Set GENT_LOG_FORMAT=pretty|both for stderr output. */
export const GentLogger: Layer.Layer<never> = (() => {
  const format = getLogFormat()
  const logFile = getLogFile()

  if (format === "pretty") {
    return Logger.replace(Logger.defaultLogger, prettyLogger)
  }

  if (format === "json") {
    clearLogFile(logFile)
    return Logger.replace(Logger.defaultLogger, makeJsonFileLogger(logFile))
  }

  // both
  clearLogFile(logFile)
  const combined = Logger.zip(prettyLogger, makeJsonFileLogger(logFile))
  return Logger.replace(Logger.defaultLogger, combined)
})()

/** JSON-only logger layer (for headless/prod). */
export const GentLoggerJson: Layer.Layer<never> = (() => {
  const logFile = getLogFile()
  clearLogFile(logFile)
  return Logger.replace(Logger.defaultLogger, makeJsonFileLogger(logFile))
})()

/** Pretty-only logger layer (for testing/debugging). */
export const GentLoggerPretty: Layer.Layer<never> = Logger.replace(
  Logger.defaultLogger,
  prettyLogger,
)

/** Minimum log level — filters out Trace/Debug in non-dev. */
export const GentLogLevel: Layer.Layer<never> = (() => {
  const env = Bun.env["GENT_LOG_LEVEL"]
  switch (env) {
    case "trace":
      return Logger.minimumLogLevel(LogLevel.Trace)
    case "debug":
      return Logger.minimumLogLevel(LogLevel.Debug)
    case "warning":
      return Logger.minimumLogLevel(LogLevel.Warning)
    case "error":
      return Logger.minimumLogLevel(LogLevel.Error)
    default:
      return Logger.minimumLogLevel(LogLevel.Info)
  }
})()
