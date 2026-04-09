import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { fuzzyScore } from "../../utils/fuzzy-score"
import { truncatePath } from "../../components/message-list-utils"
import { getFileTag } from "../../components/file-tag"
import { Glob } from "bun"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync, readdirSync } from "node:fs"

const FILE_GLOB = new Glob("**/*")
const MAX_RESULTS = 50

const formatMatch = (f: { path: string; name: string }) => {
  const tag = getFileTag(f.path)
  return {
    id: f.path,
    label: tag.length > 0 ? `${tag} ${f.name}` : f.name,
    description: truncatePath(f.path, 40),
  }
}

/** Parse .gitignore into Glob matchers. Caches per cwd. */
const gitignoreCache = new Map<string, Glob[]>()

const loadGitignore = (cwd: string): Glob[] => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return cached

  let patterns: Glob[] = []
  try {
    const content = readFileSync(`${cwd}/.gitignore`, "utf-8")
    patterns = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((p) => {
        // Normalize: strip trailing slash (we match files), ensure glob-ready
        const cleaned = p.endsWith("/") ? `${p}**` : p
        return new Glob(cleaned)
      })
  } catch {
    // No .gitignore or unreadable — no patterns
  }
  gitignoreCache.set(cwd, patterns)
  return patterns
}

const isGitignored = (path: string, patterns: Glob[]): boolean =>
  patterns.some((g) => g.match(path))

export default ExtensionPackage.tui("@gent/files-ui", (ctx) => ({
  autocompleteItems: [
    {
      prefix: "@",
      title: "Files",
      trigger: "inline" as const,
      items: async (filter: string) => {
        const cwd = ctx.cwd
        const ignorePatterns = loadGitignore(cwd)

        // Empty filter: list top-level directory entries
        if (filter.length === 0) {
          try {
            const entries = readdirSync(cwd, { withFileTypes: true })
            return entries
              .filter(
                (e) =>
                  !e.name.startsWith(".") &&
                  !isGitignored(e.isDirectory() ? `${e.name}/` : e.name, ignorePatterns),
              )
              .sort((a, b) => {
                // Directories first, then alphabetical
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              .slice(0, MAX_RESULTS)
              .map((e) => formatMatch({ path: e.name, name: e.name }))
          } catch {
            return []
          }
        }

        const matches: Array<{ path: string; name: string; score: number }> = []

        for await (const path of FILE_GLOB.scan({ cwd, onlyFiles: true })) {
          if (path.startsWith(".") || path.includes("/.")) continue
          if (isGitignored(path, ignorePatterns)) continue
          const score = fuzzyScore(filter, path)
          if (score > 0) {
            matches.push({ path, name: path.split("/").pop() ?? path, score })
          }
          if (matches.length > MAX_RESULTS * 3) break
        }

        matches.sort((a, b) => b.score - a.score)
        return matches.slice(0, MAX_RESULTS).map(formatMatch)
      },
    },
  ],
}))
