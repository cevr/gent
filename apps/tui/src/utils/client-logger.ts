/**
 * Client-side structured logger — unified with Effect's logger.
 *
 * `createClientLog(services)` — creates a logger backed by Effect.runForkWith.
 *   All logs flow through the Effect logger layer and land in the same file.
 *
 * `shutdownLog` — synchronous file write, survives process.exit(). Use for
 *   shutdown paths only (after Effect runtime is torn down).
 */

import { DateTime, Effect, Exit, Option, Schema } from "effect"
import type { Context } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- Synchronous shutdown logging runs after the Effect runtime closes.

import { LOG_DIR, buildLogPaths } from "@gent/core-internal/runtime/log-paths"

// Client log path derives from `process.cwd()` — same source the launcher
// threads into `GentLogger(cwd)` for the server. Both ends hash the same
// cwd, so a single gent instance writes client + server logs under one
// filename prefix.
export const CLIENT_LOG_PATH = buildLogPaths(process.cwd()).client

Effect.runSync(Effect.ignore(Effect.try(() => mkdirSync(LOG_DIR, { recursive: true }))))

// Clock-bypass: `shutdownLog` runs after Effect runtime teardown, so we
// cannot yield `Clock.currentTimeMillis` here. `Date.now()` is the standard
// sync-land alternative.
const isoNow = () => DateTime.formatIso(DateTime.nowUnsafe())
const encodeLogEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Synchronous log — survives process.exit(). Use for shutdown paths only. */
export const shutdownLog = (msg: string, data?: Schema.JsonObject) => {
  const entry = new Map<string, Schema.Json>(
    Object.entries(Option.fromNullishOr(data).pipe(Option.getOrElse(() => ({})))),
  )
  entry.set("ts", isoNow())
  entry.set("level", "info")
  entry.set("source", "client")
  entry.set("msg", msg)
  Effect.runSync(
    Effect.ignore(
      Effect.try(() =>
        appendFileSync(CLIENT_LOG_PATH, encodeLogEntry(Object.fromEntries(entry)) + "\n"),
      ),
    ),
  )
}

export const clearClientLog = () => {
  Effect.runSync(Effect.ignore(Effect.try(() => writeFileSync(CLIENT_LOG_PATH, ""))))
}

export interface ClientLog {
  debug: (msg: string, data?: Schema.JsonObject) => void
  info: (msg: string, data?: Schema.JsonObject) => void
  warn: (msg: string, data?: Schema.JsonObject) => void
  error: (msg: string, data?: Schema.JsonObject) => void
}

/**
 * Create an Effect-backed client logger from captured services.
 * Uses runForkWith — logs are async, fire-and-forget, flow through Effect's logger.
 * Falls back to shutdownLog if the Effect runtime throws (e.g. during teardown).
 */
export const createClientLog = (services: Context.Context<unknown>): ClientLog => {
  const fork = Effect.runForkWith(services)

  const makeLogFn =
    (effectLog: (msg: string) => Effect.Effect<void>) =>
    (msg: string, data?: Schema.JsonObject) => {
      const logData = Option.fromNullishOr(data)
      let logEffect = effectLog(msg)
      if (Option.isSome(logData) && Object.keys(logData.value).length > 0) {
        logEffect = effectLog(msg).pipe(Effect.annotateLogs(logData.value))
      }
      const exit = Effect.runSyncExit(Effect.sync(() => fork(logEffect)))
      if (Exit.isFailure(exit)) shutdownLog(msg, data)
    }

  return {
    debug: makeLogFn(Effect.logDebug),
    info: makeLogFn(Effect.logInfo),
    warn: makeLogFn(Effect.logWarning),
    error: makeLogFn(Effect.logError),
  }
}
