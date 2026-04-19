/**
 * FileFinder — Effect-typed wrapper around the @ff-labs/fff-bun native finder.
 *
 * Exposes Effect-typed `searchFiles` and `trackSelection` over a per-cwd
 * cached `FileFinder` instance. The DB directory is created via Effect's
 * `FileSystem` (no direct Bun APIs).
 *
 * FFF is the *only* file-search path — there is no Bun.Glob fallback. If
 * `FileFinder.isAvailable()` is false the search Effect fails with
 * `FileFinderUnavailableError` and the popup adapter normalizes to `[]`.
 */

import { Effect, FileSystem, Schema } from "effect"
import { FileFinder, type SearchResult } from "@ff-labs/fff-bun"

// ── Errors ───────────────────────────────────────────────────────────────

export class FileFinderUnavailableError extends Schema.TaggedErrorClass<FileFinderUnavailableError>()(
  "FileFinderUnavailableError",
  {},
) {}

export class FileFinderInitError extends Schema.TaggedErrorClass<FileFinderInitError>()(
  "FileFinderInitError",
  { reason: Schema.String },
) {}

// ── DB dir ───────────────────────────────────────────────────────────────

let _dbDir: string | undefined

const ensureDbDir = (home: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (_dbDir !== undefined) return _dbDir
    const fs = yield* FileSystem.FileSystem
    const dir = `${home}/.gent/fff`
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    _dbDir = dir
    return dir
  })

// ── Singleton cache ──────────────────────────────────────────────────────

interface FinderEntry {
  finder: FileFinder
  ready: boolean
  scanPromise: Promise<void>
}

const finders = new Map<string, FinderEntry>()

const ensureFinder = (
  cwd: string,
  home: string,
): Effect.Effect<
  FinderEntry,
  FileFinderUnavailableError | FileFinderInitError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const existing = finders.get(cwd)
    if (existing !== undefined) return existing

    if (!FileFinder.isAvailable()) {
      return yield* new FileFinderUnavailableError()
    }

    const dbDir = yield* ensureDbDir(home)
    const result = FileFinder.create({
      basePath: cwd,
      frecencyDbPath: `${dbDir}/frecency.mdb`,
      historyDbPath: `${dbDir}/history.mdb`,
      aiMode: true,
    })

    if (!result.ok) {
      return yield* new FileFinderInitError({ reason: String(result.error) })
    }

    const finder = result.value
    // Start scan in background — don't block the search call.
    const scanPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        const scan = finder.waitForScan(15_000)
        if (scan.ok) entry.ready = true
        resolve()
      }, 0)
    })

    const entry: FinderEntry = { finder, ready: false, scanPromise }
    finders.set(cwd, entry)
    return entry
  })

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Search for files matching `query` under `cwd`. Fails with a typed error if
 * FFF is unavailable or initialization failed.
 */
export const searchFiles = (
  cwd: string,
  home: string,
  query: string,
  pageSize: number = 50,
): Effect.Effect<
  SearchResult,
  FileFinderUnavailableError | FileFinderInitError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const entry = yield* ensureFinder(cwd, home)
    if (!entry.ready) yield* Effect.promise(() => entry.scanPromise)
    const result = entry.finder.fileSearch(query, { pageSize })
    if (!result.ok) {
      return yield* new FileFinderInitError({ reason: String(result.error) })
    }
    return result.value
  })

/** Track a selection for frecency learning. No-op if no finder for `cwd`. */
export const trackSelection = (cwd: string, query: string, filePath: string): void => {
  const entry = finders.get(cwd)
  if (entry === undefined) return
  entry.finder.trackQuery(query, filePath)
}
