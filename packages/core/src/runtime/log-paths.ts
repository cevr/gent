/**
 * Centralized log path resolution — all logs go to /tmp/gent/logs/
 *
 * Files are named by a short hash of the cwd + process start timestamp so
 * multiple gent instances don't clobber each other and old logs are easy to
 * identify by time.
 *
 * File naming: `<hash>-<ts>-server.log`, `<hash>-<ts>-server-trace.log`,
 *              `<hash>-<ts>-client.log`
 */

import { Config, Effect, FileSystem, Option } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync } from "node:fs"

const LOG_DIR = "/tmp/gent/logs"

/** FNV-1a 32-bit hash → 8-char hex */
const hashCwd = (cwd: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const PROCESS_START_TS = new Date()
  .toISOString()
  .replace(/[-:T.]/g, "")
  .slice(0, 14) // YYYYMMDDHHMMSS

export interface LogPaths {
  readonly dir: string
  readonly log: string
  readonly trace: string
  readonly client: string
}

let cached: LogPaths | undefined

const buildPaths = (cwd: string): LogPaths => {
  const prefix = `${hashCwd(cwd)}-${PROCESS_START_TS}`
  return {
    dir: LOG_DIR,
    log: `${LOG_DIR}/${prefix}-server.log`,
    trace: `${LOG_DIR}/${prefix}-server-trace.log`,
    client: `${LOG_DIR}/${prefix}-client.log`,
  }
}

/**
 * Resolve and cache log paths via Effect Config.
 * Must be called once during startup before any sync access via {@link getLogPaths}.
 */
export const resolveLogPaths: Effect.Effect<LogPaths> = Effect.gen(function* () {
  if (cached !== undefined) return cached

  const cwd = Option.getOrElse(yield* Config.option(Config.string("GENT_CWD")), () =>
    globalThis.process.cwd(),
  )

  cached = buildPaths(cwd)
  return cached
}).pipe(Effect.catchEager(() => Effect.succeed(getLogPaths())))

/**
 * Get cached log paths. Returns the cached value if {@link resolveLogPaths} has run,
 * otherwise falls back to process.cwd()-based paths (for sync shutdown callsites
 * that may run before Effect startup completes). Creates the directory if needed.
 */
export const getLogPaths = (): LogPaths => {
  if (cached !== undefined) return cached
  // Fallback for sync callsites before Effect init — best effort
  cached = buildPaths(globalThis.process.cwd())
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {}
  return cached
}

/** Create the log directory if it doesn't exist. Call once at startup. */
export const ensureLogDir: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem
    const { dir } = yield* resolveLogPaths
    yield* Effect.ignore(fs.makeDirectory(dir, { recursive: true }))
  },
)
