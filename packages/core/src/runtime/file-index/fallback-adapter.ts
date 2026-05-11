import { Effect, FileSystem, HashMap, Layer, Option, Path, TxRef } from "effect"
import picomatch from "picomatch"
import {
  FileIndex,
  FileIndexError,
  type FileIndexService,
  type IndexedFile,
} from "../../domain/file-index.js"

// ---------------------------------------------------------------------------
// Gitignore parsing (ported from apps/tui/src/utils/fallback-file-search.ts)
// ---------------------------------------------------------------------------

type PathMatcher = (path: string) => boolean

export type GitignoreCacheRef = TxRef.TxRef<HashMap.HashMap<string, ReadonlyArray<PathMatcher>>>

export const makeGitignoreCacheRef = (): Effect.Effect<GitignoreCacheRef> =>
  TxRef.make(HashMap.empty<string, ReadonlyArray<PathMatcher>>())

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

// ---------------------------------------------------------------------------
// Fallback FileIndex implementation
// ---------------------------------------------------------------------------

export const makeFallbackService = (
  cacheRef: GitignoreCacheRef,
): Effect.Effect<FileIndexService, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const loadGitignore = (cwd: string): Effect.Effect<ReadonlyArray<PathMatcher>> =>
      Effect.gen(function* () {
        const cache = yield* TxRef.get(cacheRef)
        const cached = HashMap.get(cache, cwd)
        if (cached._tag === "Some") return cached.value

        const patterns = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
          Effect.map((content) => parseGitignorePatterns(content) as ReadonlyArray<PathMatcher>),
          Effect.orElseSucceed(() => [] as ReadonlyArray<PathMatcher>),
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
              const relativePath = relativeDir.length === 0 ? entry : `${relativeDir}/${entry}`
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

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const FallbackFileIndexLive: Layer.Layer<
  FileIndex,
  never,
  FileSystem.FileSystem | Path.Path
> = Layer.effect(
  FileIndex,
  Effect.gen(function* () {
    const cacheRef = yield* makeGitignoreCacheRef()
    return yield* makeFallbackService(cacheRef)
  }),
)
