import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { GitReader, RepoTool } from "./repo-explorer.js"

export { GitReader, GitReaderError } from "./repo-explorer.js"

export const LibrarianExtension = defineExtension({
  id: "@gent/librarian",
  tools: [RepoTool],
  resources: [
    defineResource({
      id: "@gent/librarian/git-reader",
      tag: GitReader,
      scope: "process",
      layer: GitReader.Live,
    }),
  ],
})
