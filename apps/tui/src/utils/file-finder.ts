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
 *
 * Scan readiness: each finder kicks off `waitForScan` once on creation,
 * stored as a settled `Promise<ScanResult>`. The native call is wrapped so
 * a throwing call resolves to a typed failure object instead of leaving
 * the promise unresolved (counsel  finding 4). The search effect
 * awaits via `Effect.promise` + a typed error map; Effect interruption
 * cleanly abandons the wait without canceling the underlying scan (which
 * is fine — the finder stays valid for the next search).
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

export class FileFinderScanError extends Schema.TaggedErrorClass<FileFinderScanError>()(
  "FileFinderScanError",
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

type ScanOutcome = { ok: true } | { ok: false; reason: string }

interface FinderEntry {
  readonly finder: FileFinder
  /** Settles when the initial scan completes. Always resolves (never
   *  rejects) so callers don't need to wrap in try/catch — failure modes
   *  are encoded in the resolved value. */
  readonly scanReady: Promise<ScanOutcome>
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

    // Kick off the native scan as a settled Promise. Wrapping the
    // throwable native call in try/catch guarantees the Promise always
    // resolves (with a typed outcome), so search calls awaiting
    // `scanReady` can never hang on a throw.
    const scanReady: Promise<ScanOutcome> = new Promise((resolve) => {
      // setTimeout(0) so finder.create returns synchronously to the
      // search call below before the blocking scan begins.
      setTimeout(() => {
        try {
          const scan = finder.waitForScan(15_000)
          resolve(scan.ok ? { ok: true } : { ok: false, reason: "waitForScan returned !ok" })
        } catch (e) {
          resolve({ ok: false, reason: String(e) })
        }
      }, 0)
    })

    const entry: FinderEntry = { finder, scanReady }
    finders.set(cwd, entry)
    return entry
  })

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Search for files matching `query` under `cwd`. Fails with a typed error if
 * FFF is unavailable, init failed, or the initial scan failed.
 */
export const searchFiles = (
  cwd: string,
  home: string,
  query: string,
  pageSize: number = 50,
): Effect.Effect<
  SearchResult,
  FileFinderUnavailableError | FileFinderInitError | FileFinderScanError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const entry = yield* ensureFinder(cwd, home)
    const outcome = yield* Effect.promise(() => entry.scanReady)
    if (!outcome.ok) {
      return yield* new FileFinderScanError({ reason: outcome.reason })
    }
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
