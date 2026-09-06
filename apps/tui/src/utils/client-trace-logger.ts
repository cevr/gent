/**
 * Client-side Effect trace logger — batched JSON writer.
 *
 * Writes to the same file as clientLog (/tmp/gent-client.log) so all TUI
 * logs land in one place. Uses a custom batched logger with a finalizer
 * that flushes remaining lines on scope close.
 */

import { Cause, Effect, FileSystem, Logger, Option, Schema } from "effect"
import type { PlatformError, Scope } from "effect"
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References"
import { CLIENT_LOG_PATH } from "./client-logger"

const encodeTraceEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type SpanDurations = Record<string, number>

const collectSpans = (
  spans: ReadonlyArray<[label: string, timestamp: number]>,
  now: number,
): SpanDurations => {
  const result: Record<string, number> = {}
  for (const [label, startTime] of spans) {
    result[label] = now - startTime
  }
  return result
}

const decodeMessageString = Schema.decodeUnknownOption(Schema.String)
const decodeMessageParts = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
type LoggerMessage = Parameters<typeof decodeMessageString>[0]

const extractMessage = (message: LoggerMessage): string =>
  Option.match(decodeMessageString(message), {
    onNone: () =>
      Option.match(decodeMessageParts(message), {
        onNone: () => String(message),
        onSome: (parts) => parts.map(String).join(" "),
      }),
    onSome: (text) => text,
  })

const formatLogger: Logger.Logger<unknown, string> = Logger.make(
  ({ logLevel, message, fiber, date, cause }) => {
    const msg = extractMessage(message)
    const annotations = fiber.getRef(CurrentLogAnnotations)
    const spans = fiber.getRef(CurrentLogSpans)
    const now = date.getTime()
    const spanEntries = collectSpans(spans, now)

    const entry = new Map(Object.entries(annotations))
    entry.set("ts", date.toISOString())
    entry.set("level", logLevel)
    entry.set("msg", msg)

    Option.fromNullishOr(fiber.currentSpan).pipe(
      Option.map((currentSpan) => {
        entry.set("traceId", currentSpan.traceId)
        entry.set("spanId", currentSpan.spanId)
        if (currentSpan._tag === "Span") {
          entry.set("spanName", currentSpan.name)
        }
      }),
    )

    if (Object.keys(spanEntries).length > 0) {
      entry.set("spans", spanEntries)
    }

    if (cause.reasons.length > 0) {
      entry.set(
        "cause",
        Option.fromNullishOr(Cause.pretty(cause).split("\n")[0]).pipe(
          Option.getOrElse(() => "unknown error"),
        ),
      )
    }

    return encodeTraceEntry(Object.fromEntries(entry))
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
