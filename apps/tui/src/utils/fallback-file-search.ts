/**
 * Fallback file search — Bun Glob walk + fuzzyScore + basic gitignore.
 *
 * Used when the native FFF file finder is unavailable (unsupported platform,
 * missing binary, init failure). Slower than FFF — walks the directory tree
 * on every query with no index or caching.
 */

import { Glob } from "bun"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs"
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

export const loadGitignore = (cwd: string): Glob[] => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return cached

  let patterns: Glob[] = []
  try {
    patterns = parseGitignorePatterns(readFileSync(`${cwd}/.gitignore`, "utf-8"))
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
): Promise<ReadonlyArray<{ path: string; name: string }>> {
  const ignorePatterns = loadGitignore(cwd)
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
