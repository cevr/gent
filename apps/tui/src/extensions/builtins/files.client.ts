import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { fuzzyScore } from "../../hooks/use-file-search"
import { truncatePath } from "../../components/message-list-utils"
import { getFileTag } from "../../components/file-tag"
import { Glob } from "bun"

const FILE_GLOB = new Glob("**/*")
const MAX_RESULTS = 50

export default ExtensionPackage.tui("@gent/files-ui", () => ({
  autocompleteItems: [
    {
      prefix: "@",
      title: "Files",
      trigger: "inline" as const,
      items: async (filter: string) => {
        if (filter.length === 0) return []

        const cwd = process.cwd()
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
        return matches.slice(0, MAX_RESULTS).map((f) => {
          const tag = getFileTag(f.path)
          return {
            id: f.path,
            label: tag.length > 0 ? `${tag} ${f.name}` : f.name,
            description: truncatePath(f.path, 40),
          }
        })
      },
    },
  ],
}))
