import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { Glob } from "bun"
import {
  FileIndex,
  FileIndexError,
  type FileIndexService,
  type IndexedFile,
} from "../../domain/file-index.js"

// ---------------------------------------------------------------------------
// Gitignore parsing (ported from apps/tui/src/utils/fallback-file-search.ts)
// ---------------------------------------------------------------------------

const parseGitignorePatterns = (content: string): Glob[] => {
  const patterns: Glob[] = []
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
      patterns.push(new Glob(pattern))
      patterns.push(new Glob(`${pattern}/**`))
    } else {
      patterns.push(new Glob(pattern))
      patterns.push(new Glob(`**/${pattern}`))
      patterns.push(new Glob(`${pattern}/**`))
      patterns.push(new Glob(`**/${pattern}/**`))
    }
  }
  return patterns
}

const isGitignored = (path: string, patterns: Glob[]): boolean =>
  patterns.some((g) => g.match(path))

const gitignoreCache = new Map<string, Glob[]>()

const loadGitignore = (
  cwd: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Effect.Effect<Glob[]> => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return Effect.succeed(cached)

  return fs.readFileString(path.join(cwd, ".gitignore")).pipe(
    Effect.map((content) => parseGitignorePatterns(content)),
    Effect.orElseSucceed(() => [] as Glob[]),
    Effect.tap((patterns) => Effect.sync(() => gitignoreCache.set(cwd, patterns))),
  )
}

// ---------------------------------------------------------------------------
// Async scan helper — collects all files from Bun.Glob
// ---------------------------------------------------------------------------

const FILE_GLOB = new Glob("**/*")

const scanAllFiles = (cwd: string, fs: FileSystem.FileSystem, pathService: Path.Path) =>
  Effect.gen(function* () {
    const ignorePatterns = yield* loadGitignore(cwd, fs, pathService)

    // Collect glob results first (async iterator), then stat each file via Effect
    const relativePaths: string[] = []
    yield* Effect.tryPromise({
      try: async () => {
        for await (const rp of FILE_GLOB.scan({ cwd, onlyFiles: true, dot: true })) {
          if (!isGitignored(rp, ignorePatterns)) relativePaths.push(rp)
        }
      },
      catch: () => new FileIndexError({ message: "glob scan failed", cwd }),
    })

    const files: IndexedFile[] = []
    for (const relativePath of relativePaths) {
      const absPath = pathService.join(cwd, relativePath)
      const info = yield* fs.stat(absPath).pipe(Effect.option)
      if (info._tag === "None") continue

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

  searchFiles: () =>
    // Fallback does not support fuzzy search — returns empty
    Effect.succeed([]),

  trackSelection: () => Effect.void,
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
