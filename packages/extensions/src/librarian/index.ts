import { defineAgent, defineExtension, defineResource, ModelId } from "@gent/core/extensions/api"
import { RepoTool } from "./repo-explorer.js"
import { GitReader } from "./git-reader.js"

const LIBRARIAN_PROMPT = `
Librarian agent. Answer questions about an external repository by reading its source code.
You have access to a local clone at the path specified in the prompt.
Use read, grep, and glob tools to explore the code. Be precise — cite file paths and line numbers.
- Comparative architecture: compare 2-3 implementations before recommending.
- Pattern: fetch → explore → cite → compare.
- Always ground conclusions in specific file paths and line numbers.
`.trim()

export const librarian = defineAgent({
  name: "librarian",
  description: "Answers questions about external repos using local cached clones",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "repo"],
  systemPromptAddendum: LIBRARIAN_PROMPT,
})

export const LibrarianExtension = defineExtension({
  id: "@gent/librarian",
  capabilities: [RepoTool],
  agents: [librarian],
  resources: ({ ctx }) => [
    defineResource({ tag: GitReader, scope: "process", layer: GitReader.Live(ctx.home) }),
  ],
})
