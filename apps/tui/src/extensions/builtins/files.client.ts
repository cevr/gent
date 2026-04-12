import { ExtensionPackage } from "@gent/core/domain/extension-package.js"
import { truncatePath } from "../../components/message-list-utils"
import { getFileTag } from "../../components/file-tag"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readdirSync } from "node:fs"
import { searchFiles, trackSelection } from "../../utils/file-finder"
import { fallbackSearch, isGitignored, loadGitignore } from "../../utils/fallback-file-search"

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
      items: async (filter: string) => {
        const cwd = ctx.cwd

        // Empty filter: list top-level directory entries
        if (filter.length === 0) {
          const ignorePatterns = loadGitignore(cwd)
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

        // Try native FFF search first
        const fffResult = await searchFiles(cwd, filter, MAX_RESULTS)
        if (fffResult !== null) {
          return fffResult.items.map((item) =>
            formatMatch({ path: item.relativePath, name: item.fileName }),
          )
        }

        // Fallback: Bun Glob + fuzzyScore
        return (await fallbackSearch(cwd, filter, MAX_RESULTS)).map(formatMatch)
      },
      onSelect: (id: string, filter: string) => {
        trackSelection(ctx.cwd, filter, id)
      },
    },
  ],
}))
