/**
 * useFileSearch Hook
 *
 * Provides file searching with glob patterns and fuzzy filtering.
 * Respects .gitignore files.
 */

import { createSignal, type Accessor } from "solid-js"
import { Glob } from "bun"
import { readFile, access } from "fs/promises"
import { join, dirname } from "path"

const FILE_GLOB = new Glob("**/*")
const MAX_PARENT_TRAVERSAL = 10

/** Find .gitignore patterns by walking up to git root */
async function loadGitignorePatterns(cwd: string): Promise<Set<string>> {
  const patterns = new Set<string>()
  let dir = cwd
  let traversals = 0

  while (traversals < MAX_PARENT_TRAVERSAL) {
    const gitignorePath = join(dir, ".gitignore")
    try {
      await access(gitignorePath)
      const content = await readFile(gitignorePath, "utf-8")
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith("#")) {
          patterns.add(trimmed)
        }
      }
    } catch {
      // No .gitignore here
    }

    // Check if we hit git root
    const gitDir = join(dir, ".git")
    try {
      await access(gitDir)
      break // Found git root, stop
    } catch {
      // Not git root, keep going
    }

    const parent = dirname(dir)
    if (parent === dir) break // Hit filesystem root
    dir = parent
    traversals++
  }

  return patterns
}

/** Check if path matches any gitignore pattern */
function matchesGitignore(path: string, patterns: Set<string>): boolean {
  for (const pattern of patterns) {
    // Simple matching - handles common cases
    const cleanPattern = pattern.replace(/^\//, "").replace(/\/$/, "")

    // Exact directory match (e.g., "node_modules")
    if (path === cleanPattern || path.startsWith(cleanPattern + "/")) {
      return true
    }

    // Contains pattern (e.g., path includes "/node_modules/")
    if (path.includes("/" + cleanPattern + "/") || path.includes("/" + cleanPattern)) {
      return true
    }

    // Glob suffix match (e.g., "*.log")
    if (cleanPattern.startsWith("*")) {
      const suffix = cleanPattern.slice(1)
      if (path.endsWith(suffix)) return true
    }

    // Glob prefix match (e.g., "build/*")
    if (cleanPattern.endsWith("*")) {
      const prefix = cleanPattern.slice(0, -1)
      if (path.startsWith(prefix) || path.includes("/" + prefix)) return true
    }
  }
  return false
}

export interface FileMatch {
  path: string
  name: string
  score: number
}

export interface UseFileSearchOptions {
  cwd: string
  maxResults?: number
}

export interface UseFileSearchReturn {
  results: Accessor<FileMatch[]>
  isSearching: Accessor<boolean>
  search: (filter: string) => void
}

/**
 * Simple fuzzy match scoring
 * Returns 0 if no match, higher = better match
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Exact match - highest score
  if (t === q) return 1000

  // Contains query - high score
  if (t.includes(q)) return 500 + (100 - target.length)

  // Fuzzy match - check if all chars appear in order
  let qIdx = 0
  let score = 0
  let consecutive = 0

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      // Bonus for consecutive matches
      consecutive++
      score += consecutive * 10

      // Bonus for matching at word boundaries
      if (tIdx === 0 || t[tIdx - 1] === "/" || t[tIdx - 1] === "-" || t[tIdx - 1] === "_") {
        score += 20
      }

      qIdx++
    } else {
      consecutive = 0
    }
  }

  // All query chars must be found
  if (qIdx < q.length) return 0

  // Prefer shorter paths
  return score + Math.max(0, 50 - target.length)
}

export function useFileSearch(options: UseFileSearchOptions): UseFileSearchReturn {
  const { cwd, maxResults = 50 } = options

  const [results, setResults] = createSignal<FileMatch[]>([])
  const [isSearching, setIsSearching] = createSignal(false)

  // Cache gitignore patterns
  let gitignorePatterns: Set<string> | null = null
  let gitignoreLoading: Promise<Set<string>> | null = null

  const getGitignorePatterns = async (): Promise<Set<string>> => {
    if (gitignorePatterns) return gitignorePatterns
    if (gitignoreLoading) return gitignoreLoading

    gitignoreLoading = loadGitignorePatterns(cwd)
    gitignorePatterns = await gitignoreLoading
    gitignoreLoading = null
    return gitignorePatterns
  }

  // Debounced search
  let searchTimeout: ReturnType<typeof setTimeout> | null = null

  const performSearch = async (query: string) => {
    if (!query) {
      setResults([])
      setIsSearching(false)
      return
    }

    setIsSearching(true)

    try {
      const patterns = await getGitignorePatterns()
      const matches: FileMatch[] = []

      for await (const path of FILE_GLOB.scan({ cwd, onlyFiles: true })) {
        // Skip hidden files/dirs
        if (path.startsWith(".") || path.includes("/.")) {
          continue
        }

        // Skip gitignored paths
        if (matchesGitignore(path, patterns)) {
          continue
        }

        const score = fuzzyScore(query, path)
        if (score > 0) {
          const name = path.split("/").pop() ?? path
          matches.push({ path, name, score })
        }

        // Early exit if we have enough high-scoring matches
        if (matches.length > maxResults * 3) break
      }

      // Sort by score and take top results
      matches.sort((a, b) => b.score - a.score)
      setResults(matches.slice(0, maxResults))
    } catch {
      setResults([])
    } finally {
      setIsSearching(false)
    }
  }

  const search = (query: string) => {
    // Debounce
    if (searchTimeout) clearTimeout(searchTimeout)
    searchTimeout = setTimeout(() => {
      void performSearch(query)
    }, 50)
  }

  return { results, isSearching, search }
}
