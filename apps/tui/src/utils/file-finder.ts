/**
 * FileFinder — singleton wrapper around the @ff-labs/fff-bun native file finder.
 *
 * Provides a per-cwd cached instance with lazy initialization.
 * Falls back gracefully if the native library is unavailable.
 */

import type { AsyncFileSystem } from "@gent/core/domain/extension-client"
import { FileFinder, type SearchResult } from "@ff-labs/fff-bun"

// ---------------------------------------------------------------------------
// Frecency DB paths — shared across sessions
// ---------------------------------------------------------------------------

let _dbDir: string | undefined

async function ensureDbDir(home: string, fs: AsyncFileSystem): Promise<string> {
  if (_dbDir !== undefined) return _dbDir
  const dir = `${home}/.gent/fff`
  try {
    await fs.makeDirectory(dir, { recursive: true })
  } catch {
    // Best effort
  }
  _dbDir = dir
  return dir
}

// ---------------------------------------------------------------------------
// Singleton cache
// ---------------------------------------------------------------------------

interface FinderEntry {
  finder: FileFinder
  ready: boolean
  scanPromise: Promise<void>
}

const finders = new Map<string, FinderEntry>()

/**
 * Get or create a FileFinder for the given working directory.
 * Returns null if the native library is unavailable or init fails.
 */
export async function ensureFinder(
  cwd: string,
  home: string,
  fs: AsyncFileSystem,
): Promise<FinderEntry | null> {
  const existing = finders.get(cwd)
  if (existing !== undefined) return existing

  if (!FileFinder.isAvailable()) return null

  const dbDir = await ensureDbDir(home, fs)
  const result = FileFinder.create({
    basePath: cwd,
    frecencyDbPath: `${dbDir}/frecency.mdb`,
    historyDbPath: `${dbDir}/history.mdb`,
    aiMode: true,
  })

  if (!result.ok) return null

  const finder = result.value
  // Start scan in background — don't block
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
}

/**
 * Search for files matching the query.
 * Returns null if the finder isn't available — caller should use fallback.
 */
export async function searchFiles(
  cwd: string,
  query: string,
  pageSize: number = 50,
  home?: string,
  fs?: AsyncFileSystem,
): Promise<SearchResult | null> {
  const entry =
    home !== undefined && fs !== undefined
      ? await ensureFinder(cwd, home, fs)
      : (finders.get(cwd) ?? null)
  if (entry === null) return null

  if (!entry.ready) await entry.scanPromise

  const result = entry.finder.fileSearch(query, { pageSize })
  if (!result.ok) return null
  return result.value
}

/** Track a selection for frecency learning. */
export function trackSelection(cwd: string, query: string, filePath: string): void {
  const entry = finders.get(cwd)
  if (entry === undefined) return
  entry.finder.trackQuery(query, filePath)
}

/** Destroy all finder instances. */
export function destroyAll(): void {
  for (const [, entry] of finders) {
    try {
      entry.finder.destroy()
    } catch {
      // Ignore
    }
  }
  finders.clear()
}

/** Destroy the finder for a specific cwd. */
export function destroyFinder(cwd: string): void {
  const entry = finders.get(cwd)
  if (entry === undefined) return
  try {
    entry.finder.destroy()
  } catch {
    // Ignore
  }
  finders.delete(cwd)
}
