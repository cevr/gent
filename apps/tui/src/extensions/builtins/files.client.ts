/**
 * Files autocomplete (`@`) — Effect-typed setup.
 *
 * Yields `ClientWorkspace` for cwd/home and `FileSystem.FileSystem` for the
 * empty-filter top-level directory listing. Non-empty filter goes through
 * the FFF-backed `searchFiles` Effect — no Bun.Glob fallback (deleted in
 * C9.3 with the "no native bun apis" mandate).
 */

import { Effect, FileSystem } from "effect"
import {
  defineClientExtension,
  autocompleteContribution,
} from "@gent/core/domain/extension-client.js"
import { truncatePath } from "../../components/message-list-utils"
import { getFileTag } from "../../components/file-tag"
import { searchFiles, trackSelection } from "../../utils/file-finder"
import { ClientWorkspace } from "../client-services"

const MAX_RESULTS = 50

const formatMatch = (f: { path: string; name: string }) => {
  const tag = getFileTag(f.path)
  return {
    id: f.path,
    label: tag.length > 0 ? `${tag} ${f.name}` : f.name,
    description: truncatePath(f.path, 40),
  }
}

export default defineClientExtension("@gent/files-ui", {
  setup: Effect.gen(function* () {
    const workspace = yield* ClientWorkspace
    return [
      autocompleteContribution({
        prefix: "@",
        title: "Files",
        items: (filter: string) =>
          Effect.gen(function* () {
            const cwd = workspace.cwd

            // Empty filter: list top-level directory entries via Effect FS.
            // Drops gitignore filtering at the top level — FFF respects
            // gitignore for the actual fuzzy search where it matters.
            if (filter.length === 0) {
              const fs = yield* FileSystem.FileSystem
              const entries = yield* Effect.orElseSucceed(
                fs.readDirectory(cwd),
                (): ReadonlyArray<string> => [],
              )
              return entries
                .filter((name: string) => !name.startsWith("."))
                .slice()
                .sort()
                .slice(0, MAX_RESULTS)
                .map((name: string) => formatMatch({ path: name, name }))
            }

            // Non-empty filter: FFF Effect. Failures (FFF unavailable, init
            // failure) are caught here so the popup adapter still shows []
            // instead of swallowing the failure as opaque.
            const fffResult = yield* Effect.orElseSucceed(
              searchFiles(cwd, workspace.home, filter, MAX_RESULTS),
              () => undefined,
            )
            if (fffResult === undefined) return []
            return fffResult.items.map((item: { relativePath: string; fileName: string }) =>
              formatMatch({ path: item.relativePath, name: item.fileName }),
            )
          }),
        onSelect: (id: string, filter: string) => {
          trackSelection(workspace.cwd, filter, id)
        },
      }),
    ]
  }),
})
