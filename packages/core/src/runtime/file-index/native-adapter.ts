import { Clock, Effect, Layer } from "effect"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import {
  FileIndex,
  FileIndexError,
  type FileIndexService,
  type IndexedFile,
} from "../../domain/file-index.js"

// ---------------------------------------------------------------------------
// Dynamic import — fails gracefully when @ff-labs/fff-bun is not installed.
// We use import() type annotations because the module may not exist at all;
// a static `import type` would fail module resolution.
// ---------------------------------------------------------------------------

// eslint-disable-next-line typescript-eslint/consistent-type-imports
type FileFinder = import("@ff-labs/fff-bun").FileFinder
// eslint-disable-next-line typescript-eslint/consistent-type-imports
type FffModule = typeof import("@ff-labs/fff-bun")

let _mod: FffModule | undefined

export const loadNativeModule: Effect.Effect<FffModule, FileIndexError> = Effect.tryPromise({
  try: async () => {
    if (_mod !== undefined) return _mod
    _mod = await import("@ff-labs/fff-bun")
    return _mod
  },
  catch: () => new FileIndexError({ message: "native file finder unavailable", cwd: "" }),
})

// ---------------------------------------------------------------------------
// Per-cwd finder cache
// ---------------------------------------------------------------------------

interface FinderEntry {
  finder: FileFinder
  scanned: boolean
}

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
// Poll-based scan wait (non-blocking)
// ---------------------------------------------------------------------------

const waitForScan = (finder: FileFinder, timeoutMs: number): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    while (finder.isScanning()) {
      if ((yield* Clock.currentTimeMillis) - start > timeoutMs) return false
      yield* Effect.sleep(50)
    }
    return true
  })

// ---------------------------------------------------------------------------
// Convert FFF FileItem to IndexedFile
// ---------------------------------------------------------------------------

const toIndexedFile = (item: {
  path: string
  relativePath: string
  fileName: string
  size: number
  modified: number
}): IndexedFile => ({
  path: item.path,
  relativePath: item.relativePath,
  fileName: item.fileName,
  size: item.size,
  modifiedMs: item.modified * 1000,
})

// ---------------------------------------------------------------------------
// Native FileIndex implementation
// ---------------------------------------------------------------------------

const makeNativeService = (finders: Map<string, FinderEntry>, mod: FffModule): FileIndexService => {
  const FF = mod.FileFinder

  const getOrCreate = (cwd: string): FinderEntry | undefined => {
    const existing = finders.get(cwd)
    if (existing !== undefined) return existing

    const dbDir = ensureDbDir()
    const result = FF.create({
      basePath: cwd,
      frecencyDbPath: join(dbDir, "frecency.mdb"),
      historyDbPath: join(dbDir, "history.mdb"),
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

        // eslint-disable-next-line no-constant-condition
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
            allFiles.push(toIndexedFile(item))
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

        return result.value.items.map(toIndexedFile)
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
  mod: FffModule,
): { service: FileIndexService; finalize: Effect.Effect<void> } => {
  const finders = new Map<string, FinderEntry>()
  return {
    service: makeNativeService(finders, mod),
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

export const NativeFileIndexLive: Layer.Layer<FileIndex, FileIndexError> = Layer.unwrap(
  Effect.gen(function* () {
    const mod = yield* loadNativeModule

    if (!mod.FileFinder.isAvailable()) {
      return yield* new FileIndexError({ message: "native binary not available", cwd: "" })
    }

    const { service, finalize } = makeNativeServiceFromModule(mod)
    yield* Effect.addFinalizer(() => finalize)

    return Layer.succeed(FileIndex, service)
  }),
)
