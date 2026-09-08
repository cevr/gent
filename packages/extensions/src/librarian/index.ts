import { Effect } from "effect"
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api"
import { GitReader, RepoTool } from "./repo-explorer.js"

export { GitReader, GitReaderError } from "./repo-explorer.js"

export const LibrarianExtension = defineExtension({
  id: "@gent/librarian",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", RepoTool)
    yield* host.register(
      "resource",
      defineResource({
        id: "@gent/librarian/git-reader",
        tag: GitReader,
        scope: "process",
        layer: GitReader.Live,
      }),
    )
  }),
})
