/**
 * useSkills Hook
 *
 * Scans skill directories with stale-while-revalidate caching.
 * Skill dirs: ~/.claude/skills, ~/.cursor/skills, ~/.config/opencode/skills
 */

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { readdir, readFile, mkdir, writeFile } from "fs/promises"
import { homedir } from "os"
import { join, basename } from "path"
import { Effect, Fiber, Runtime } from "effect"
import { atom, useAtomValue, useRegistry } from "@gent/atom-solid"

export interface Skill {
  id: string
  name: string
  path: string
  source: "claude" | "cursor" | "opencode"
}

interface SkillCache {
  skills: Skill[]
  timestamp: number
}

const SKILL_DIRS: Array<{ path: string; source: Skill["source"] }> = [
  { path: join(homedir(), ".claude", "skills"), source: "claude" },
  { path: join(homedir(), ".cursor", "skills"), source: "cursor" },
  { path: join(homedir(), ".config", "opencode", "skills"), source: "opencode" },
]

const CACHE_PATH = join(homedir(), ".cache", "gent", "skills.json")
const REFRESH_INTERVAL = 30_000

const loadCache = (): Effect.Effect<Skill[] | null> =>
  Effect.tryPromise(() => readFile(CACHE_PATH, "utf-8")).pipe(
    Effect.map((content) => {
      if (!content) return null
      try {
        const cache = JSON.parse(content) as SkillCache
        return cache.skills
      } catch {
        return null
      }
    }),
    Effect.catchAll(() => Effect.succeed(null)),
  )

const saveCache = (skills: Skill[]): Effect.Effect<void> =>
  Effect.gen(function* () {
    const cacheDir = join(homedir(), ".cache", "gent")
    yield* Effect.tryPromise({
      try: () => mkdir(cacheDir, { recursive: true }),
      catch: () => undefined,
    })
    const cache: SkillCache = { skills, timestamp: Date.now() }
    yield* Effect.tryPromise({
      try: () => writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8"),
      catch: () => undefined,
    })
  }).pipe(Effect.catchAll(() => Effect.void))

const scanSkillDir = (dir: string, source: Skill["source"]): Effect.Effect<Skill[]> =>
  Effect.tryPromise(() => readdir(dir, { withFileTypes: true })).pipe(
    Effect.map((entries) => {
      const skills: Skill[] = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const name = basename(entry.name, ".md")
        const path = join(dir, entry.name)
        skills.push({
          id: `${source}:${name}`,
          name,
          path,
          source,
        })
      }
      return skills
    }),
    Effect.catchAll(() => Effect.succeed([])),
  )

const scanAllSkillDirs = (): Effect.Effect<Skill[]> =>
  Effect.all(SKILL_DIRS.map(({ path, source }) => scanSkillDir(path, source))).pipe(
    Effect.map((results) => results.flat()),
  )

export interface UseSkillsReturn {
  skills: Accessor<Skill[]>
  isRefreshing: Accessor<boolean>
  refresh: () => void
}

export function useSkills(): UseSkillsReturn {
  const registry = useRegistry()

  const skillsAtom = atom((registry) => {
    const [state, setState] = createSignal({ skills: [] as Skill[], isRefreshing: false })
    const [version, setVersion] = createSignal(0)
    let cancelRefresh: (() => void) | undefined

    const runRefresh = () => {
      const effect = Effect.gen(function* () {
        yield* Effect.sync(() => {
          setState((prev) => ({ ...prev, isRefreshing: true }))
        })

        const cached = yield* loadCache()
        if (cached) {
          yield* Effect.sync(() => {
            setState({ skills: cached, isRefreshing: true })
          })
        }

        const fresh = yield* scanAllSkillDirs()
        yield* Effect.sync(() => {
          setState({ skills: fresh, isRefreshing: false })
        })
        yield* saveCache(fresh)
      })

      const runtime = registry.runtime
      const fiber = Runtime.runFork(runtime)(effect)
      return () => {
        Runtime.runFork(runtime)(Fiber.interruptFork(fiber))
      }
    }

    const cleanupRefresh = () => {
      if (!cancelRefresh) return
      cancelRefresh()
      cancelRefresh = undefined
    }

    createEffect(() => {
      version()
      cleanupRefresh()
      cancelRefresh = runRefresh()
      onCleanup(cleanupRefresh)
    })

    const interval = setInterval(() => setVersion((v) => v + 1), REFRESH_INTERVAL)
    const dispose = () => {
      cleanupRefresh()
      clearInterval(interval)
    }
    onCleanup(dispose)

    return {
      get: () => state(),
      refresh: () => setVersion((v) => v + 1),
      dispose,
    }
  })

  const state = useAtomValue(skillsAtom)

  const skills = () => state().skills
  const isRefreshing = () => state().isRefreshing
  const refresh = () => registry.refresh(skillsAtom)

  return { skills, isRefreshing, refresh }
}
