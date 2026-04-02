/**
 * Centralized log path resolution — all logs go to ~/.gent/logs/<dashified-cwd>/
 *
 * Each cwd gets its own log directory so multiple gent instances don't clobber
 * each other's files. Directory creation is handled by {@link ensureLogDir}.
 */

import { Config, Effect, FileSystem, Option } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync } from "node:fs"

const dashifyCwd = (cwd: string): string =>
  cwd
    .replace(/^\//, "")
    .replace(/[/\\]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "")

export interface LogPaths {
  readonly dir: string
  readonly log: string
  readonly trace: string
  readonly client: string
}

let cached: LogPaths | undefined

const buildPaths = (cwd: string, home: string): LogPaths => {
  const dir = `${home}/.gent/logs/${dashifyCwd(cwd)}`
  return {
    dir,
    log: `${dir}/gent.log`,
    trace: `${dir}/gent-trace.log`,
    client: `${dir}/gent-client.log`,
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
  const home = Option.getOrElse(yield* Config.option(Config.string("HOME")), () => "~")

  cached = buildPaths(cwd, home)
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
  cached = buildPaths(globalThis.process.cwd(), globalThis.process.env["HOME"] ?? "~") // eslint-disable-line node/no-process-env -- sync fallback before Effect init
  try {
    mkdirSync(cached.dir, { recursive: true })
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
