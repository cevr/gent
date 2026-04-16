import { extension, defineAgent, LIBRARIAN_PROMPT, ModelId } from "@gent/core/extensions/api"
import { RepoTool } from "./repo-explorer.js"
import { GitReader } from "./git-reader.js"

export const librarian = defineAgent({
  name: "librarian",
  description: "Answers questions about external repos using local cached clones",
  model: ModelId.of("openai/gpt-5.4-mini"),
  allowedTools: ["grep", "glob", "read", "memory_search", "repo"],
  systemPromptAddendum: LIBRARIAN_PROMPT,
  persistence: "ephemeral",
})

export const LibrarianExtension = extension("@gent/librarian", ({ ext, ctx }) =>
  ext.tools(RepoTool).agents(librarian).layer(GitReader.Live(ctx.home)),
)
