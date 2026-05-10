import { Effect, FileSystem, Layer, Option, Path } from "effect"
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

const gitignoreCache = new Map<string, PathMatcher[]>()

const loadGitignore = (
  cwd: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<PathMatcher[]> => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return Effect.succeed(cached)

  return fs.readFileString(path.join(cwd, ".gitignore")).pipe(
    Effect.map((content) => parseGitignorePatterns(content)),
    Effect.orElseSucceed(() => [] as PathMatcher[]),
    Effect.tap((patterns) => Effect.sync(() => gitignoreCache.set(cwd, patterns))),
  )
}

// ---------------------------------------------------------------------------
// Async scan helper — walks the Effect FileSystem and filters with picomatch
// ---------------------------------------------------------------------------

const scanAllFiles = (
  cwd: string,
  fs: FileSystem.FileSystem,
  pathService: Path.Path,
): Effect.Effect<ReadonlyArray<IndexedFile>, FileIndexError> =>
  Effect.gen(function* () {
    const ignorePatterns = yield* loadGitignore(cwd, fs, pathService)

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

          const absPath = pathService.join(absoluteDir, entry)
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
            fileName: pathService.basename(relativePath),
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

// ---------------------------------------------------------------------------
// Fallback FileIndex implementation
// ---------------------------------------------------------------------------

export const makeFallbackService = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
): FileIndexService => ({
  listFiles: (params) =>
    scanAllFiles(params.cwd, fs, path).pipe(
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
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return makeFallbackService(fs, path)
  }),
)
