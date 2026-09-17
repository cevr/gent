/**
 * FileFinder — Effect-typed wrapper around the @ff-labs/fff-bun native finder.
 *
 * Exposes Effect-typed `searchFiles` and `trackSelection` over a per-cwd
 * cached `FileFinder` instance. The caller resolves the db directory once and
 * passes it in, so "where is the FFF db" is decided at the one place that
 * knows the workspace home.
 *
 * FFF is the *only* file-search path — there is no runtime glob fallback. If
 * `FileFinder.isAvailable()` is false the search Effect fails with
 * `FileFinderUnavailableError` and the popup adapter normalizes to `[]`.
 *
 * Scan readiness: each finder kicks off `waitForScan` once on creation,
 * stored as an Effect. The native call is wrapped so
 * a throwing call resolves to a typed failure object instead of leaving
 * the promise unresolved (counsel  finding 4). The search effect
 * awaits via `Effect.promise` + a typed error map; Effect interruption
 * cleanly abandons the wait without canceling the underlying scan (which
 * is fine — the finder stays valid for the next search).
 */

import { Effect, Option, Schema } from "effect"
import { FileFinder, type SearchResult } from "@ff-labs/fff-bun"

// ── Errors ───────────────────────────────────────────────────────────────

class FileFinderUnavailableError extends Schema.TaggedError<FileFinderUnavailableError>()(
  "FileFinderUnavailableError",
  {},
) {}

class FileFinderInitError extends Schema.TaggedError<FileFinderInitError>()("FileFinderInitError", {
  reason: Schema.String,
}) {}

class FileFinderScanError extends Schema.TaggedError<FileFinderScanError>()("FileFinderScanError", {
  reason: Schema.String,
}) {}

// ── Singleton cache ──────────────────────────────────────────────────────

type ScanOutcome = { ok: true } | { ok: false; reason: string }

interface FinderEntry {
  readonly finder: FileFinder
  /** Completes when the initial scan completes. Always succeeds; failure
   *  modes are encoded in the returned value. */
  readonly scanReady: Effect.Effect<ScanOutcome>
}

const finders = new Map<string, FinderEntry>()

const ensureFinder = (
  cwd: string,
  dbDir: string,
): Effect.Effect<FinderEntry, FileFinderUnavailableError | FileFinderInitError> =>
  Effect.gen(function* () {
    const existing = Option.fromNullishOr(finders.get(cwd))
    if (Option.isSome(existing)) return existing.value

    if (!FileFinder.isAvailable()) {
      return yield* new FileFinderUnavailableError()
    }

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

    // Yield one tick so finder.create returns synchronously to the first
    // search call before the blocking scan begins.
    const scanReady: Effect.Effect<ScanOutcome> = Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => finder.waitForScan(15_000),
          catch: String,
        }),
      ),
      Effect.match({
        onFailure: (reason) => ({ ok: false, reason }) satisfies ScanOutcome,
        onSuccess: (scan) => {
          if (scan.ok) return { ok: true } satisfies ScanOutcome
          return { ok: false, reason: "waitForScan returned !ok" } satisfies ScanOutcome
        },
      }),
    )

    const entry: FinderEntry = { finder, scanReady }
    finders.set(cwd, entry)
    return entry
  })

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Search for files matching `query` under `cwd`, keeping its frecency and
 * history databases in `dbDir`. Fails with a typed error if FFF is
 * unavailable, init failed, or the initial scan failed.
 */
export const searchFiles = (
  cwd: string,
  dbDir: string,
  query: string,
  pageSize: number = 50,
): Effect.Effect<
  SearchResult,
  FileFinderUnavailableError | FileFinderInitError | FileFinderScanError
> =>
  Effect.gen(function* () {
    const entry = yield* ensureFinder(cwd, dbDir)
    const outcome = yield* entry.scanReady
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
  const entry = Option.fromNullishOr(finders.get(cwd))
  if (Option.isNone(entry)) return
  entry.value.finder.trackQuery(query, filePath)
}
