/**
 * Fallback file search — Bun Glob walk + fuzzyScore + basic gitignore.
 *
 * Used when the native FFF file finder is unavailable (unsupported platform,
 * missing binary, init failure). Slower than FFF — walks the directory tree
 * on every query with no index or caching.
 */

import { Effect, FileSystem } from "effect"
import { Glob } from "bun"
import { fuzzyScore } from "./fuzzy-score"

// ---------------------------------------------------------------------------
// Gitignore parsing
// ---------------------------------------------------------------------------

/** Parse .gitignore content into Glob matchers. */
export const parseGitignorePatterns = (content: string): Glob[] => {
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

export const isGitignored = (path: string, patterns: Glob[]): boolean =>
  patterns.some((g) => g.match(path))

const gitignoreCache = new Map<string, Glob[]>()

export const loadGitignore = async (
  cwd: string,
  runEffect: <A, E = never, R = never>(effect: Effect.Effect<A, E, R>) => Promise<A>,
): Promise<Glob[]> => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return cached

  let patterns: Glob[] = []
  try {
    const content = await runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        return yield* fs.readFileString(`${cwd}/.gitignore`)
      }),
    )
    patterns = parseGitignorePatterns(content)
  } catch {
    // No .gitignore or unreadable
  }
  gitignoreCache.set(cwd, patterns)
  return patterns
}

// ---------------------------------------------------------------------------
// Fallback search
// ---------------------------------------------------------------------------

const FILE_GLOB = new Glob("**/*")

export async function fallbackSearch(
  cwd: string,
  filter: string,
  maxResults: number,
  runEffect: <A, E = never, R = never>(effect: Effect.Effect<A, E, R>) => Promise<A>,
): Promise<ReadonlyArray<{ path: string; name: string }>> {
  const ignorePatterns = await loadGitignore(cwd, runEffect)
  const matches: Array<{ path: string; name: string; score: number }> = []

  for await (const path of FILE_GLOB.scan({ cwd, onlyFiles: true })) {
    if (path.startsWith(".") || path.includes("/.")) continue
    if (isGitignored(path, ignorePatterns)) continue
    const score = fuzzyScore(filter, path)
    if (score > 0) {
      matches.push({ path, name: path.split("/").pop() ?? path, score })
    }
    if (matches.length > maxResults * 3) break
  }

  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, maxResults)
}
