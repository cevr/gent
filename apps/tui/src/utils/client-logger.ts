/**
 * Client-side structured logger — unified with Effect's logger.
 *
 * `createClientLog(services)` — creates a logger backed by Effect.runForkWith.
 *   All logs flow through the Effect logger layer and land in the same file.
 *
 * `shutdownLog` — synchronous file write, survives process.exit(). Use for
 *   shutdown paths only (after Effect runtime is torn down).
 */

import { Effect } from "effect"
import type { ServiceMap } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync, writeFileSync } from "node:fs"

export const CLIENT_LOG_PATH = "/tmp/gent-client.log"

const isoNow = () => new Date().toISOString()

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
export const createClientLog = (services: ServiceMap.ServiceMap<unknown>): ClientLog => {
  const fork = Effect.runForkWith(services as ServiceMap.ServiceMap<never>)

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
