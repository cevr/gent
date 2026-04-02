/**
 * Client-side Effect trace logger — batched JSON writer.
 *
 * Writes to the same file as clientLog (/tmp/gent-client.log) so all TUI
 * logs land in one place. Uses a custom batched logger with a finalizer
 * that flushes remaining lines on scope close.
 */

import { Cause, Effect, FileSystem, Logger } from "effect"
import type { PlatformError, Scope } from "effect"
import type { LogLevel } from "effect/LogLevel"
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References"
import { CLIENT_LOG_PATH } from "./client-logger"

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

const extractMessage = (message: unknown): string => {
  if (typeof message === "string") return message
  if (Array.isArray(message)) return message.map(String).join(" ")
  return String(message)
}

const formatLogger: Logger.Logger<unknown, string> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const annots = collectAnnotations(annotations)
    const now = date.getTime()
    const spanEntries = collectSpans(spans, now)

    const entry: Record<string, unknown> = {
      ts: date.toISOString(),
      level: logLevel as LogLevel,
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

/**
 * Batched JSON file logger with guaranteed flush on scope close.
 * Writes to CLIENT_LOG_PATH (/tmp/gent-client.log).
 */
export const makeClientTraceLogger = (
  windowMs = 250,
): Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const logFile = yield* fs.open(CLIENT_LOG_PATH, { flag: "a+" })
    const encoder = new TextEncoder()

    let buffer: string[] = []

    const flush = Effect.suspend(() => {
      if (buffer.length === 0) return Effect.void
      const batch = buffer
      buffer = []
      return Effect.ignore(logFile.write(encoder.encode(batch.join("\n") + "\n")))
    })

    // Periodic async flush
    yield* flush.pipe(
      Effect.delay(`${windowMs} millis`),
      Effect.forever,
      Effect.interruptible,
      Effect.forkScoped,
    )

    // Final flush on scope close
    yield* Effect.addFinalizer(() => flush)

    return Logger.map(formatLogger, (line) => {
      buffer.push(line)
    })
  })
