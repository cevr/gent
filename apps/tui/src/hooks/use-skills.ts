/**
 * useSkills Hook
 *
 * Scans skill directories with stale-while-revalidate caching.
 * Skill dirs: ~/.claude/skills, ~/.cursor/skills, ~/.config/opencode/skills
 */

import { createSignal, onMount, onCleanup, type Accessor } from "solid-js"
import { readdir, readFile, mkdir, writeFile } from "fs/promises"
import { homedir } from "os"
import { join, basename } from "path"

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
const REFRESH_INTERVAL = 30_000 // 30 seconds

async function loadCache(): Promise<Skill[] | null> {
  try {
    const content = await readFile(CACHE_PATH, "utf-8")
    const cache: SkillCache = JSON.parse(content) as SkillCache
    return cache.skills
  } catch {
    return null
  }
}

async function saveCache(skills: Skill[]): Promise<void> {
  try {
    const cacheDir = join(homedir(), ".cache", "gent")
    await mkdir(cacheDir, { recursive: true })
    const cache: SkillCache = { skills, timestamp: Date.now() }
    await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8")
  } catch {
    // Cache write failure is non-critical
  }
}

async function scanSkillDir(
  dir: string,
  source: Skill["source"],
): Promise<Skill[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skills: Skill[] = []

    for (const entry of entries) {
      // Only .md files are skills
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
  } catch {
    // Directory doesn't exist or isn't readable
    return []
  }
}

async function scanAllSkillDirs(): Promise<Skill[]> {
  const results = await Promise.all(
    SKILL_DIRS.map(({ path, source }) => scanSkillDir(path, source)),
  )
  return results.flat()
}

export interface UseSkillsReturn {
  skills: Accessor<Skill[]>
  isRefreshing: Accessor<boolean>
  refresh: () => Promise<void>
}

export function useSkills(): UseSkillsReturn {
  const [skills, setSkills] = createSignal<Skill[]>([])
  const [isRefreshing, setIsRefreshing] = createSignal(false)

  let refreshInterval: ReturnType<typeof setInterval> | null = null

  const refresh = async () => {
    if (isRefreshing()) return
    setIsRefreshing(true)

    try {
      const fresh = await scanAllSkillDirs()
      setSkills(fresh)
      await saveCache(fresh)
    } finally {
      setIsRefreshing(false)
    }
  }

  onMount(() => {
    // Load from cache first (stale-while-revalidate)
    void loadCache().then((cached) => {
      if (cached) setSkills(cached)
      // Background refresh
      void refresh()
    })

    // Periodic refresh
    refreshInterval = setInterval(() => {
      void refresh()
    }, REFRESH_INTERVAL)
  })

  onCleanup(() => {
    if (refreshInterval) clearInterval(refreshInterval)
  })

  return { skills, isRefreshing, refresh }
}
