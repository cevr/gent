/**
 * Indexed file discovery for the grep tool.
 *
 * Native-first (`@ff-labs/fff-bun`, per-cwd cached finders) with a
 * `.gitignore`-aware FileSystem walk as the per-call fallback. The layer
 * always succeeds: a missing native module or a per-call native failure
 * degrades to the walk.
 */
import {
  Context,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  type Scope,
  TxRef,
} from "effect"
import picomatch from "picomatch"
import { FileFinder as NativeFileFinder, type FileItem } from "@ff-labs/fff-bun"

export interface IndexedFile {
  readonly path: string
  readonly relativePath: string
  readonly fileName: string
  readonly size: number
  readonly modifiedMs: number
}

export class FileIndexError extends Schema.TaggedError<FileIndexError>()("FileIndexError", {
  message: Schema.String,
  cwd: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

interface FileIndexService {
  /** List all indexed files for a directory. */
  readonly listFiles: (params: {
    readonly cwd: string
  }) => Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError>
}

export class FileIndex extends Context.Service<FileIndex, FileIndexService>()(
  "@gent/extensions/src/fs-tools/file-index/FileIndex",
) {}

// ── Fallback: FileSystem walk with .gitignore filtering ──

type PathMatcher = (path: string) => boolean

type GitignoreCacheRef = TxRef.TxRef<HashMap.HashMap<string, ReadonlyArray<PathMatcher>>>

const parseGitignorePatterns = (content: string): PathMatcher[] => {
  const patterns: PathMatcher[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    if (line.startsWith("!")) continue

    let pattern = line
    const isDir = pattern.endsWith("/")
    if (isDir) pattern = pattern.slice(0, -1)

    const hasSlash = pattern.includes("/")
    if (pattern.startsWith("/")) pattern = pattern.slice(1)

    if (hasSlash) {
      patterns.push(picomatch(pattern, { dot: true }))
      patterns.push(picomatch(`${pattern}/**`, { dot: true }))
    } else {
      patterns.push(picomatch(pattern, { dot: true }))
      patterns.push(picomatch(`**/${pattern}`, { dot: true }))
      patterns.push(picomatch(`${pattern}/**`, { dot: true }))
      patterns.push(picomatch(`**/${pattern}/**`, { dot: true }))
    }
  }
  return patterns
}

const isGitignored = (path: string, patterns: ReadonlyArray<PathMatcher>): boolean =>
  patterns.some((matches) => matches(path))

const makeFallbackService: Effect.Effect<
  FileIndexService,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cacheRef: GitignoreCacheRef = yield* TxRef.make(
    HashMap.empty<string, ReadonlyArray<PathMatcher>>(),
  )

  const loadGitignore = (cwd: string): Effect.Effect<ReadonlyArray<PathMatcher>> =>
    Effect.gen(function* () {
      const cache = yield* TxRef.get(cacheRef)
      const cached = HashMap.get(cache, cwd)
      if (cached._tag === "Some") return cached.value

      const patterns = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
        Effect.map(parseGitignorePatterns),
        Effect.orElseSucceed((): ReadonlyArray<PathMatcher> => []),
      )
      yield* TxRef.update(cacheRef, (m) => HashMap.set(m, cwd, patterns))
      return patterns
    })

  const scanAllFiles = (cwd: string): Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError> =>
    Effect.gen(function* () {
      const ignorePatterns = yield* loadGitignore(cwd)

      const files: IndexedFile[] = []
      const scanDir: (
        absoluteDir: string,
        relativeDir: string,
      ) => Effect.Effect<void, FileIndexError> = (absoluteDir, relativeDir) =>
        Effect.gen(function* () {
          const entries = yield* fs
            .readDirectory(absoluteDir)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new FileIndexError({ message: `directory scan failed: ${cause.message}`, cwd }),
              ),
            )

          for (const entry of entries) {
            let relativePath = relativeDir
            if (relativeDir.length === 0) {
              relativePath = entry
            } else {
              relativePath = `${relativeDir}/${entry}`
            }
            if (isGitignored(relativePath, ignorePatterns)) continue

            const absPath = path.join(absoluteDir, entry)
            const info = yield* fs.stat(absPath).pipe(Effect.option)
            if (info._tag === "None") continue

            if (info.value.type === "Directory") {
              yield* scanDir(absPath, relativePath)
              continue
            }

            if (info.value.type !== "File") continue

            files.push({
              path: absPath,
              relativePath,
              fileName: path.basename(relativePath),
              size: Number(info.value.size),
              modifiedMs: Option.match(info.value.mtime, {
                onNone: () => 0,
                onSome: (d) => d.getTime(),
              }),
            })
          }
        })

      yield* scanDir(cwd, "")

      return files
    })

  return {
    listFiles: (params) =>
      scanAllFiles(params.cwd).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new FileIndexError({
              message: `fallback scan failed: ${e}`,
              cwd: params.cwd,
              cause: e,
            }),
          ),
        ),
      ),
  }
})

export const FallbackFileIndexLive: Layer.Layer<
  FileIndex,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(FileIndex, makeFallbackService)

// ── Native: fff-bun finders, one per cwd ──

interface FinderEntry {
  finder: NativeFileFinder
  scanned: boolean
}

const SCAN_TIMEOUT_MS = 5000

// The fff-bun library exposes a synchronous `waitForScan(timeoutMs)` that
// blocks until the indexer signals completion (or the timeout elapses).
const waitForScan = (finder: NativeFileFinder): Effect.Effect<boolean> =>
  Effect.promise(() => finder.waitForScan(SCAN_TIMEOUT_MS)).pipe(
    Effect.map((result) => result.ok && result.value),
  )

const makeNativeService = (
  dbDir: string,
): Effect.Effect<FileIndexService, never, Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const finders = new Map<string, FinderEntry>()
    const frecencyDbPath = path.join(dbDir, "frecency.mdb")
    const historyDbPath = path.join(dbDir, "history.mdb")

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [, entry] of finders) {
          // Cleanup is best effort. The native module can throw during teardown.
          Result.try(() => entry.finder.destroy())
        }
        finders.clear()
      }),
    )

    const toIndexedFile = (basePath: string, item: FileItem): IndexedFile => ({
      path: path.join(basePath, item.relativePath),
      relativePath: item.relativePath,
      fileName: item.fileName,
      size: item.size,
      modifiedMs: item.modified * 1000,
    })

    const getOrCreate = (cwd: string): Option.Option<FinderEntry> => {
      const existing = Option.fromUndefinedOr(finders.get(cwd))
      if (Option.isSome(existing)) return existing

      const result = NativeFileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
      })

      if (!result.ok) return Option.none()

      const entry: FinderEntry = { finder: result.value, scanned: false }
      finders.set(cwd, entry)
      return Option.some(entry)
    }

    return {
      listFiles: (params) =>
        Effect.gen(function* () {
          const entry = getOrCreate(params.cwd)
          if (Option.isNone(entry)) {
            return yield* new FileIndexError({
              message: "failed to create finder",
              cwd: params.cwd,
            })
          }
          const finderEntry = entry.value

          if (!finderEntry.scanned) {
            const completed = yield* waitForScan(finderEntry.finder)
            if (!completed) {
              return yield* new FileIndexError({
                message: "scan timed out",
                cwd: params.cwd,
              })
            }
            finderEntry.scanned = true
          }

          const pageSize = 200
          const allFiles: IndexedFile[] = []
          let pageIndex = 0
          let totalFiles = 0

          // eslint-disable-next-line no-constant-condition -- cursor loop exits on empty page or backend error
          while (true) {
            const result = finderEntry.finder.fileSearch("", { pageSize, pageIndex })
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
  })

/** Wrap a primary service with per-method fallback on FileIndexError. */
const withFallback = (primary: FileIndexService, fallback: FileIndexService): FileIndexService => ({
  listFiles: (params) =>
    primary
      .listFiles(params)
      .pipe(Effect.catchTag("FileIndexError", () => fallback.listFiles(params))),
})

/** Native-first with per-call fallback. Finder databases live under `${home}/.gent/fff`. */
export const FileIndexLive = (options: {
  readonly home: string
}): Layer.Layer<FileIndex, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FileIndex,
    Effect.gen(function* () {
      const fallback = yield* makeFallbackService
      if (!NativeFileFinder.isAvailable()) return fallback

      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const dbDir = path.join(options.home, ".gent", "fff")
      yield* fs.makeDirectory(dbDir, { recursive: true }).pipe(Effect.ignore)
      const native = yield* makeNativeService(dbDir)
      return withFallback(native, fallback)
    }),
  )
