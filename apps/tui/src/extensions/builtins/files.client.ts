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

/** Parse .gitignore content into Glob matchers. */
export const parseGitignorePatterns = (content: string): Glob[] => {
  const patterns: Glob[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    // Negation patterns (!) not supported — skip
    if (line.startsWith("!")) continue

    let pattern = line
    const isDir = pattern.endsWith("/")
    if (isDir) pattern = pattern.slice(0, -1)

    const hasSlash = pattern.includes("/")
    // Leading slash anchors to root — strip it (paths are relative to cwd)
    if (pattern.startsWith("/")) pattern = pattern.slice(1)

    if (hasSlash) {
      // Contains slash → anchored, match as-is plus contents
      patterns.push(new Glob(pattern))
      patterns.push(new Glob(`${pattern}/**`))
    } else {
      // No slash → match at any depth
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

/** Load and cache gitignore patterns for a cwd. */
const gitignoreCache = new Map<string, Glob[]>()

const loadGitignore = (cwd: string): Glob[] => {
  const cached = gitignoreCache.get(cwd)
  if (cached !== undefined) return cached

  let patterns: Glob[] = []
  try {
    patterns = parseGitignorePatterns(readFileSync(`${cwd}/.gitignore`, "utf-8"))
  } catch {
    // No .gitignore or unreadable — no patterns
  }
  gitignoreCache.set(cwd, patterns)
  return patterns
}

export default ExtensionPackage.tui("@gent/files-ui", (ctx) => ({
  autocompleteItems: [
    {
      prefix: "@",
      title: "Files",
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
