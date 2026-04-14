import { Effect, Layer } from "effect"
import { Glob } from "bun"
import { statSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"
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

const loadGitignore = (cwd: string): Glob[] => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return cached

  let patterns: Glob[] = []
  try {
    patterns = parseGitignorePatterns(readFileSync(join(cwd, ".gitignore"), "utf-8"))
  } catch {
    // No .gitignore or unreadable
  }
  gitignoreCache.set(cwd, patterns)
  return patterns
}

// ---------------------------------------------------------------------------
// Async scan helper — collects all files from Bun.Glob
// ---------------------------------------------------------------------------

const FILE_GLOB = new Glob("**/*")

async function scanAllFiles(cwd: string): Promise<IndexedFile[]> {
  const ignorePatterns = loadGitignore(cwd)
  const files: IndexedFile[] = []

  for await (const relativePath of FILE_GLOB.scan({ cwd, onlyFiles: true })) {
    // Skip hidden files
    if (relativePath.startsWith(".") || relativePath.includes("/.")) continue
    if (isGitignored(relativePath, ignorePatterns)) continue

    const absPath = join(cwd, relativePath)
    try {
      const stat = statSync(absPath)
      files.push({
        path: absPath,
        relativePath,
        fileName: basename(relativePath),
        size: stat.size,
        modifiedMs: stat.mtimeMs,
      })
    } catch {
      // File may have been deleted between scan and stat
    }
  }

  return files
}

// ---------------------------------------------------------------------------
// Fallback FileIndex implementation
// ---------------------------------------------------------------------------

const makeFallbackService = (): FileIndexService => ({
  listFiles: (params) =>
    Effect.tryPromise({
      try: () => scanAllFiles(params.cwd),
      catch: (e) =>
        new FileIndexError({
          message: `fallback scan failed: ${e}`,
          cwd: params.cwd,
          cause: e,
        }),
    }),

  searchFiles: () =>
    // Fallback does not support fuzzy search — returns empty
    Effect.succeed([]),

  trackSelection: () => Effect.void,
})

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const FallbackFileIndexLive: Layer.Layer<FileIndex> = Layer.succeed(
  FileIndex,
  makeFallbackService(),
)
