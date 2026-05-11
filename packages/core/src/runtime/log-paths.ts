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

import { DateTime, Effect, FileSystem, Option } from "effect"

export const LOG_DIR = "/tmp/gent/logs"
const FALLBACK_CWD_IDENTITY = "unknown-cwd"

/** FNV-1a 32-bit hash → 8-char hex */
const hashCwd = (cwd: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const formatStartTs = (timeOrigin: number): string =>
  DateTime.make(timeOrigin).pipe(
    Option.match({
      onNone: () => "unknown",
      onSome: (date) =>
        DateTime.formatIso(date)
          .replace(/[-:T.]/g, "")
          .slice(0, 14),
    }),
  ) // YYYYMMDDHHMMSS

let cachedStartTs: string | undefined
/**
 * Read the process-start timestamp, formatted YYYYMMDDHHMMSS. Lazy and
 * memoized so module import has no platform side effect, and so synchronous
 * callers (TUI logger module init) share the same value as Effect callers.
 */
export const processStartTs = (): string => {
  if (cachedStartTs === undefined) cachedStartTs = formatStartTs(performance.timeOrigin)
  return cachedStartTs
}

export interface LogPaths {
  readonly dir: string
  readonly log: string
  readonly trace: string
  readonly client: string
}

/**
 * Build log paths for a given cwd identity. Pure — no I/O. App entrypoints
 * (e.g. TUI) that need a stable path before Effect startup can call this
 * directly; Effect-aware callers should use {@link resolveLogPaths}.
 */
export const buildLogPaths = (cwd: string = FALLBACK_CWD_IDENTITY): LogPaths => {
  const prefix = `${hashCwd(cwd)}-${processStartTs()}`
  return {
    dir: LOG_DIR,
    log: `${LOG_DIR}/${prefix}-server.log`,
    trace: `${LOG_DIR}/${prefix}-server-trace.log`,
    client: `${LOG_DIR}/${prefix}-client.log`,
  }
}

/** Create the log directory if it doesn't exist. Call once at startup. */
export const ensureLogDir: Effect.Effect<void, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem
    yield* Effect.ignore(fs.makeDirectory(LOG_DIR, { recursive: true }))
  },
)
