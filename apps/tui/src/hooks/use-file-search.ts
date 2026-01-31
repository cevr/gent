/**
 * useFileSearch Hook
 *
 * Provides file searching with glob patterns and fuzzy filtering.
 * Respects .gitignore files.
 */

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { Glob } from "bun"
import { readFile, access } from "fs/promises"
import { join, dirname } from "path"
import { Effect, Exit, Fiber, Runtime } from "effect"
import { atom, state, useAtomSet, useAtomValue } from "@gent/atom-solid"

const FILE_GLOB = new Glob("**/*")
const MAX_PARENT_TRAVERSAL = 10

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => access(path).then(() => true)).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
  )

const readFileIfExists = (path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => readFile(path, "utf-8")).pipe(Effect.catchAll(() => Effect.succeed(null)))

const loadGitignorePatterns = (cwd: string): Effect.Effect<Set<string>> =>
  Effect.gen(function* () {
    const patterns = new Set<string>()
    let dir = cwd
    let traversals = 0

    while (traversals < MAX_PARENT_TRAVERSAL) {
      const gitignorePath = join(dir, ".gitignore")
      const content = yield* readFileIfExists(gitignorePath)
      if (content !== null && content.length > 0) {
        for (const line of content.split("\n")) {
          const trimmed = line.trim()
          if (trimmed.length > 0 && !trimmed.startsWith("#")) {
            patterns.add(trimmed)
          }
        }
      }

      const gitDir = join(dir, ".git")
      const isRoot = yield* exists(gitDir)
      if (isRoot) break

      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
      traversals++
    }

    return patterns
  })

/** Check if path matches any gitignore pattern */
function matchesGitignore(path: string, patterns: Set<string>): boolean {
  for (const pattern of patterns) {
    const cleanPattern = pattern.replace(/^\//, "").replace(/\/$/, "")

    if (path === cleanPattern || path.startsWith(cleanPattern + "/")) {
      return true
    }

    if (path.includes("/" + cleanPattern + "/") || path.includes("/" + cleanPattern)) {
      return true
    }

    if (cleanPattern.startsWith("*")) {
      const suffix = cleanPattern.slice(1)
      if (path.endsWith(suffix)) return true
    }

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
  includeHidden?: boolean
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

  if (t === q) return 1000

  if (t.includes(q)) return 500 + (100 - target.length)

  let qIdx = 0
  let score = 0
  let consecutive = 0

  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      consecutive++
      score += consecutive * 10

      if (tIdx === 0 || t[tIdx - 1] === "/" || t[tIdx - 1] === "-" || t[tIdx - 1] === "_") {
        score += 20
      }

      qIdx++
    } else {
      consecutive = 0
    }
  }

  if (qIdx < q.length) return 0

  return score + Math.max(0, 50 - target.length)
}

export function useFileSearch(options: UseFileSearchOptions): UseFileSearchReturn {
  type FileSearchState =
    | { _tag: "idle"; results: FileMatch[] }
    | { _tag: "searching"; results: FileMatch[] }

  const { cwd, maxResults = 50, includeHidden = false } = options

  let gitignorePatterns: Set<string> | null = null

  const getGitignorePatterns = (): Effect.Effect<Set<string>> =>
    Effect.suspend(() => {
      if (gitignorePatterns !== null) return Effect.succeed(gitignorePatterns)
      return loadGitignorePatterns(cwd).pipe(
        Effect.tap((patterns) => {
          gitignorePatterns = patterns
        }),
      )
    })

  const searchEffect = (query: string): Effect.Effect<FileMatch[]> =>
    Effect.gen(function* () {
      const patterns = yield* getGitignorePatterns()
      const matches: FileMatch[] = []
      const iterator = FILE_GLOB.scan({ cwd, onlyFiles: true })[Symbol.asyncIterator]()

      while (true) {
        const next = yield* Effect.tryPromise(() => iterator.next()).pipe(
          Effect.catchAll(() =>
            Effect.succeed({ done: true, value: undefined } as IteratorResult<string>),
          ),
        )

        if (next.done === true) break
        const path = next.value

        // Skip hidden files unless includeHidden is true
        if (!includeHidden && (path.startsWith(".") || path.includes("/."))) {
          continue
        }

        if (matchesGitignore(path, patterns)) {
          continue
        }

        const score = fuzzyScore(query, path)
        if (score > 0) {
          const name = path.split("/").pop() ?? path
          matches.push({ path, name, score })
        }

        if (matches.length > maxResults * 3) break
      }

      matches.sort((a, b) => b.score - a.score)
      return matches.slice(0, maxResults)
    })

  const queryAtom = state("")

  const fileSearchAtom = atom((registry) => {
    const [state, setState] = createSignal<FileSearchState>({
      _tag: "idle",
      results: [],
    })
    const query = () => registry.read(queryAtom)()
    let cancel: (() => void) | undefined

    const cleanup = () => {
      if (cancel === undefined) return
      cancel()
      cancel = undefined
    }

    createEffect(() => {
      const value = query()
      cleanup()
      if (value.length === 0) {
        setState({ _tag: "idle", results: [] })
        return
      }

      setState((prev) => ({ _tag: "searching", results: prev.results }))
      const runtime = registry.runtime
      const effect = Effect.sleep(50).pipe(Effect.flatMap(() => searchEffect(value)))
      const fiber = Runtime.runFork(runtime)(effect)
      cancel = () => {
        Runtime.runFork(runtime)(Fiber.interruptFork(fiber))
      }

      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) {
          setState({ _tag: "idle", results: exit.value })
          return
        }
        setState({ _tag: "idle", results: [] })
      })

      onCleanup(cleanup)
    })

    return {
      get: () => state(),
      dispose: cleanup,
    }
  })

  const stateValue = useAtomValue(fileSearchAtom)
  const setQuery = useAtomSet(queryAtom)

  const results = () => stateValue().results
  const isSearching = () => stateValue()._tag === "searching"
  const search = (filter: string) => setQuery(filter)

  return { results, isSearching, search }
}
