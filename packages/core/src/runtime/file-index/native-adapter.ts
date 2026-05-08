import { Effect, FileSystem, Layer, Path } from "effect"
import {
  FileIndex,
  FileIndexError,
  type FileIndexService,
  type IndexedFile,
} from "../../domain/file-index.js"
import { RuntimeEnvironment } from "../runtime-environment.js"
import { FileFinder as NativeFileFinder, type FileItem } from "@ff-labs/fff-bun"

type FileFinder = NativeFileFinder

export const isNativeFileIndexAvailable = (): boolean => NativeFileFinder.isAvailable()

// ---------------------------------------------------------------------------
// Per-cwd finder cache
// ---------------------------------------------------------------------------

interface FinderEntry {
  finder: FileFinder
  scanned: boolean
}

export const ensureDbDir = (
  home: string,
  path: Path.Path,
  fs: FileSystem.FileSystem,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const dir = path.join(home, ".gent", "fff")
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
    return dir
  })

// ---------------------------------------------------------------------------
// Scan completion (delegated to native `waitForScan` FFI)
// ---------------------------------------------------------------------------

// The fff-bun library exposes a synchronous `waitForScan(timeoutMs)` that
// blocks until the indexer signals completion (or the timeout elapses).
// Using it directly removes the JS-side 50ms `Effect.sleep` poll loop —
// scan completion is a single FFI rendezvous, not a busy-wait.
const waitForScan = (finder: FileFinder, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const result = finder.waitForScan(timeoutMs)
    return result.ok && result.value
  })

// ---------------------------------------------------------------------------
// Convert FFF FileItem to IndexedFile
// ---------------------------------------------------------------------------

const toIndexedFile = (path: Path.Path, basePath: string, item: FileItem): IndexedFile => ({
  path: path.join(basePath, item.relativePath),
  relativePath: item.relativePath,
  fileName: item.fileName,
  size: item.size,
  modifiedMs: item.modified * 1000,
})

// ---------------------------------------------------------------------------
// Native FileIndex implementation
// ---------------------------------------------------------------------------

const makeNativeService = (
  finders: Map<string, FinderEntry>,
  dbDir: string,
  path: Path.Path,
): FileIndexService => {
  const getOrCreate = (cwd: string): FinderEntry | undefined => {
    const existing = finders.get(cwd)
    if (existing !== undefined) return existing

    const result = NativeFileFinder.create({
      basePath: cwd,
      frecencyDbPath: path.join(dbDir, "frecency.mdb"),
      historyDbPath: path.join(dbDir, "history.mdb"),
      aiMode: true,
    })

    if (!result.ok) return undefined

    const entry: FinderEntry = { finder: result.value, scanned: false }
    finders.set(cwd, entry)
    return entry
  }

  return {
    listFiles: (params) =>
      Effect.gen(function* () {
        const entry = getOrCreate(params.cwd)
        if (entry === undefined) {
          return yield* new FileIndexError({ message: "failed to create finder", cwd: params.cwd })
        }

        if (!entry.scanned) {
          const completed = yield* waitForScan(entry.finder, params.waitForScanMs ?? 5000)
          if (!completed) {
            return yield* new FileIndexError({
              message: "scan timed out",
              cwd: params.cwd,
            })
          }
          entry.scanned = true
        }

        const pageSize = 200
        const allFiles: IndexedFile[] = []
        let pageIndex = 0
        let totalFiles = 0

        // eslint-disable-next-line no-constant-condition -- cursor loop exits on empty page or backend error
        while (true) {
          const result = entry.finder.fileSearch("", { pageSize, pageIndex })
          if (!result.ok) {
            return yield* new FileIndexError({
              message: `fileSearch failed: ${result.error}`,
              cwd: params.cwd,
            })
          }

          totalFiles = result.value.totalFiles
          for (const item of result.value.items) {
            allFiles.push(toIndexedFile(path, params.cwd, item))
          }

          if (allFiles.length >= totalFiles || result.value.items.length < pageSize) break
          pageIndex++
        }

        return allFiles
      }),

    searchFiles: (params) =>
      Effect.gen(function* () {
        const entry = getOrCreate(params.cwd)
        if (entry === undefined) {
          return yield* new FileIndexError({ message: "failed to create finder", cwd: params.cwd })
        }

        if (!entry.scanned) {
          const completed = yield* waitForScan(entry.finder, 5000)
          if (!completed) {
            return yield* new FileIndexError({ message: "scan timed out", cwd: params.cwd })
          }
          entry.scanned = true
        }

        const result = entry.finder.fileSearch(params.query, {
          pageSize: params.limit ?? 50,
        })
        if (!result.ok) {
          return yield* new FileIndexError({
            message: `fileSearch failed: ${result.error}`,
            cwd: params.cwd,
          })
        }

        return result.value.items.map((item) => toIndexedFile(path, params.cwd, item))
      }),

    trackSelection: (params) =>
      Effect.sync(() => {
        const entry = finders.get(params.cwd)
        if (entry === undefined) return
        entry.finder.trackQuery(params.query, params.path)
      }),
  }
}

// ---------------------------------------------------------------------------
// Factory for composite usage
// ---------------------------------------------------------------------------

/** Create a native service + finalizer from a loaded module. */
export const makeNativeServiceFromModule = (
  dbDir: string,
  path: Path.Path,
): { service: FileIndexService; finalize: Effect.Effect<void> } => {
  const finders = new Map<string, FinderEntry>()
  return {
    service: makeNativeService(finders, dbDir, path),
    finalize: Effect.sync(() => {
      for (const [, entry] of finders) {
        try {
          entry.finder.destroy()
        } catch {
          // Ignore cleanup errors
        }
      }
      finders.clear()
    }),
  }
}

// ---------------------------------------------------------------------------
// Layer (standalone native, no fallback)
// ---------------------------------------------------------------------------

export const NativeFileIndexLive: Layer.Layer<
  FileIndex,
  FileIndexError,
  FileSystem.FileSystem | Path.Path | RuntimeEnvironment
> = Layer.unwrap(
  Effect.gen(function* () {
    if (!isNativeFileIndexAvailable()) {
      return yield* new FileIndexError({ message: "native binary not available", cwd: "" })
    }

    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const { home } = yield* RuntimeEnvironment
    const dbDir = yield* ensureDbDir(home, path, fs)

    const { service, finalize } = makeNativeServiceFromModule(dbDir, path)
    yield* Effect.addFinalizer(() => finalize)

    return Layer.succeed(FileIndex, service)
  }),
)
