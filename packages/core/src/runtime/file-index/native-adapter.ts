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

export const ensureDbDir: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | RuntimeEnvironment
> = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const { home } = yield* RuntimeEnvironment
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
// Native FileIndex implementation
// ---------------------------------------------------------------------------

const makeNativeService = (
  dbDir: string,
): Effect.Effect<{ service: FileIndexService; finalize: Effect.Effect<void> }, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const finders = new Map<string, FinderEntry>()
    const frecencyDbPath = path.join(dbDir, "frecency.mdb")
    const historyDbPath = path.join(dbDir, "history.mdb")

    const toIndexedFile = (basePath: string, item: FileItem): IndexedFile => ({
      path: path.join(basePath, item.relativePath),
      relativePath: item.relativePath,
      fileName: item.fileName,
      size: item.size,
      modifiedMs: item.modified * 1000,
    })

    const getOrCreate = (cwd: string): FinderEntry | undefined => {
      const existing = finders.get(cwd)
      if (existing !== undefined) return existing

      const result = NativeFileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
      })

      if (!result.ok) return undefined

      const entry: FinderEntry = { finder: result.value, scanned: false }
      finders.set(cwd, entry)
      return entry
    }

    const service: FileIndexService = {
      listFiles: (params) =>
        Effect.gen(function* () {
          const entry = getOrCreate(params.cwd)
          if (entry === undefined) {
            return yield* new FileIndexError({
              message: "failed to create finder",
              cwd: params.cwd,
            })
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
              allFiles.push(toIndexedFile(params.cwd, item))
            }

            if (allFiles.length >= totalFiles || result.value.items.length < pageSize) break
            pageIndex++
          }

          return allFiles
        }),
    }

    const finalize: Effect.Effect<void> = Effect.sync(() => {
      for (const [, entry] of finders) {
        try {
          entry.finder.destroy()
        } catch {
          // Ignore cleanup errors
        }
      }
      finders.clear()
    })

    return { service, finalize }
  })

// ---------------------------------------------------------------------------
// Factory for composite usage
// ---------------------------------------------------------------------------

/** Create a native service + finalizer. Yields Path internally. */
export const makeNativeServiceFromModule = (
  dbDir: string,
): Effect.Effect<{ service: FileIndexService; finalize: Effect.Effect<void> }, never, Path.Path> =>
  makeNativeService(dbDir)

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

    const dbDir = yield* ensureDbDir

    const { service, finalize } = yield* makeNativeServiceFromModule(dbDir)
    yield* Effect.addFinalizer(() => finalize)

    return Layer.succeed(FileIndex, service)
  }),
)
