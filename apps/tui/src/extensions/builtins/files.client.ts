import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { fuzzyScore } from "../../utils/fuzzy-score"
import { truncatePath } from "../../components/message-list-utils"
import { getFileTag } from "../../components/file-tag"
import { Glob } from "bun"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readdirSync } from "node:fs"

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

export default ExtensionPackage.tui("@gent/files-ui", (ctx) => ({
  autocompleteItems: [
    {
      prefix: "@",
      title: "Files",
      trigger: "inline" as const,
      items: async (filter: string) => {
        const cwd = ctx.cwd

        // Empty filter: list top-level directory entries
        if (filter.length === 0) {
          try {
            const entries = readdirSync(cwd, { withFileTypes: true })
            return entries
              .filter((e) => !e.name.startsWith("."))
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
