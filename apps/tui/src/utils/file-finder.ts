/**
 * FileFinder — singleton wrapper around the @ff-labs/fff-bun native file finder.
 *
 * Provides a per-cwd cached instance with lazy initialization.
 * Falls back gracefully if the native library is unavailable.
 */

// @effect-diagnostics nodeBuiltinImport:off
import { join } from "node:path"
// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync } from "node:fs"
// @effect-diagnostics nodeBuiltinImport:off
import { homedir } from "node:os"
import { FileFinder, type SearchResult } from "@ff-labs/fff-bun"

// ---------------------------------------------------------------------------
// Frecency DB paths — shared across sessions
// ---------------------------------------------------------------------------

function ensureDbDir(): string {
  const dir = join(homedir(), ".gent", "fff")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Already exists
  }
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
export function ensureFinder(cwd: string): FinderEntry | null {
  const existing = finders.get(cwd)
  if (existing !== undefined) return existing

  if (!FileFinder.isAvailable()) return null

  const dbDir = ensureDbDir()
  const result = FileFinder.create({
    basePath: cwd,
    frecencyDbPath: join(dbDir, "frecency.mdb"),
    historyDbPath: join(dbDir, "history.mdb"),
    aiMode: true,
  })

  if (!result.ok) return null

  const finder = result.value
  // Start scan in background — don't block
  const scanPromise = new Promise<void>((resolve) => {
    // waitForScan is blocking in the native layer, so run via setTimeout
    // to avoid blocking the event loop during init
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
): Promise<SearchResult | null> {
  const entry = ensureFinder(cwd)
  if (entry === null) return null

  // Wait for scan to complete on first search
  if (!entry.ready) await entry.scanPromise

  const result = entry.finder.fileSearch(query, { pageSize })
  if (!result.ok) return null
  return result.value
}

/**
 * Track a selection for frecency learning.
 */
export function trackSelection(cwd: string, query: string, filePath: string): void {
  const entry = finders.get(cwd)
  if (entry === undefined) return
  entry.finder.trackQuery(query, filePath)
}

/**
 * Destroy all finder instances. Call on process exit.
 */
export function destroyAll(): void {
  for (const [, entry] of finders) {
    try {
      entry.finder.destroy()
    } catch {
      // Ignore cleanup errors
    }
  }
  finders.clear()
}

/**
 * Destroy the finder for a specific cwd.
 */
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
