/**
 * Client-side structured logger — unified with Effect's logger.
 *
 * `createClientLog(services)` — creates a logger backed by Effect.runForkWith.
 *   All logs flow through the Effect logger layer and land in the same file.
 *
 * `shutdownLog` — synchronous file write, survives process.exit(). Use for
 *   shutdown paths only (after Effect runtime is torn down).
 */

import { Config, DateTime, Effect, Option } from "effect"
import type { Context } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"

import { LOG_DIR, buildLogPaths } from "@gent/core-internal/runtime/log-paths"

// Read cwd via `GENT_CWD` so this module-init read stays aligned with the
// server's `resolveLogPaths`. Falls back to `process.cwd()` only if the env
// var is unset (e.g. early dev runs before the launcher exports it).
const clientCwd = Effect.runSync(
  Effect.gen(function* () {
    const opt = yield* Config.option(Config.string("GENT_CWD"))
    return Option.getOrElse(opt, () => process.cwd())
  }).pipe(Effect.catchEager(() => Effect.sync(() => process.cwd()))),
)
export const CLIENT_LOG_PATH = buildLogPaths(clientCwd).client

try {
  mkdirSync(LOG_DIR, { recursive: true })
} catch {}

// Clock-bypass: `shutdownLog` runs after Effect runtime teardown, so we
// cannot yield `Clock.currentTimeMillis` here. `Date.now()` is the standard
// sync-land alternative.
const isoNow = () =>
  // @effect-diagnostics-next-line globalDate:off -- shutdown path, no Effect runtime to yield Clock from
  DateTime.make(Date.now()).pipe(
    Option.match({
      onNone: () => "unknown",
      onSome: DateTime.formatIso,
    }),
  )

/** Synchronous log — survives process.exit(). Use for shutdown paths only. */
export const shutdownLog = (msg: string, data?: Record<string, unknown>) => {
  const entry: Record<string, unknown> = {
    ts: isoNow(),
    level: "info",
    source: "client",
    msg,
    ...data,
  }
  try {
    appendFileSync(CLIENT_LOG_PATH, JSON.stringify(entry) + "\n")
  } catch {}
}

export const clearClientLog = () => {
  try {
    writeFileSync(CLIENT_LOG_PATH, "")
  } catch {}
}

export interface ClientLog {
  debug: (msg: string, data?: Record<string, unknown>) => void
  info: (msg: string, data?: Record<string, unknown>) => void
  warn: (msg: string, data?: Record<string, unknown>) => void
  error: (msg: string, data?: Record<string, unknown>) => void
}

/**
 * Create an Effect-backed client logger from captured services.
 * Uses runForkWith — logs are async, fire-and-forget, flow through Effect's logger.
 * Falls back to shutdownLog if the Effect runtime throws (e.g. during teardown).
 */
export const createClientLog = (services: Context.Context<unknown>): ClientLog => {
  const fork = Effect.runForkWith(services as Context.Context<never>)

  const makeLogFn =
    (effectLog: (msg: string) => Effect.Effect<void>) =>
    (msg: string, data?: Record<string, unknown>) => {
      try {
        if (data !== undefined && Object.keys(data).length > 0) {
          fork(effectLog(msg).pipe(Effect.annotateLogs(data)))
        } else {
          fork(effectLog(msg))
        }
      } catch {
        shutdownLog(msg, data)
      }
    }

  return {
    debug: makeLogFn(Effect.logDebug),
    info: makeLogFn(Effect.logInfo),
    warn: makeLogFn(Effect.logWarning),
    error: makeLogFn(Effect.logError),
  }
}
