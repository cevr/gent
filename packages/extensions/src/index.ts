import { Effect, Option, Schema } from "effect"
import {
  type GentExtension,
  defineExtension,
  ExtensionContext,
  ExtensionId,
  hook,
  tool,
} from "@gent/core/extensions/api"
import { BuiltinArtifactIdentity } from "./artifact-identity.js"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { DelegateExtension } from "./delegate/delegate-tool.js"
export { ChildAgentExtension } from "./delegate/child-agent-tools.js"
import { AgentsExtension } from "./agents.js"
import { MemoryExtension } from "./memory/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { GoogleExtension, MistralExtension } from "./openai-compatible-driver.js"
import { PrinciplesExtension } from "./principles/principles-tool.js"
import { SkillsExtension } from "./skills/index.js"
import { LibrarianExtension } from "./librarian/index.js"
import { AcpAgentsExtension } from "./acp-agents/index.js"
import { WorkflowsExtension } from "./workflows.js"
import { HandoffExtension } from "./handoff.js"
import { ArtifactsExtension } from "./artifacts/index.js"
import { ChildAgentExtension } from "./delegate/child-agent-tools.js"
import { ReadTool } from "./fs-tools/read.js"
import { WriteTool } from "./fs-tools/write.js"
import { EditTool } from "./fs-tools/edit.js"
import { GlobTool } from "./fs-tools/glob.js"
import { GrepTool } from "./fs-tools/grep.js"
import { WebFetchTool } from "./network-tools/webfetch.js"
import { WebSearchTool } from "./network-tools/websearch.js"
import { SearchSessionsTool } from "./session-tools/search-sessions.js"
import { ReadSessionTool } from "./session-tools/read-session.js"
import { AskUserTool } from "./interaction-tools/ask-user.js"
import { PromptTool } from "./interaction-tools/prompt.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

const RenameSessionParams = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short session title, 3-5 lowercase words describing the current task",
  }),
})

const RenameSessionResult = Schema.Struct({
  renamed: Schema.Boolean,
  name: Schema.optional(Schema.String),
})

const RenameSessionTool = tool({
  id: "rename_session",
  description:
    "Rename the current session. Call once you understand the task, and again if the topic shifts significantly.",
  params: RenameSessionParams,
  output: RenameSessionResult,
  execute: Effect.fn("RenameSessionTool.execute")(function* (
    params: typeof RenameSessionParams.Type,
  ) {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.renameCurrent(params.name)
  }),
})

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  tools: [ReadTool, WriteTool, EditTool, GlobTool, GrepTool],
})

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  tools: [WebFetchTool, WebSearchTool],
})

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  tools: [SearchSessionsTool, ReadSessionTool, RenameSessionTool],
  hooks: [
    hook.systemPrompt((input) => {
      if (input.interactive === false) {
        return Effect.succeed(input.basePrompt)
      }
      return Effect.succeed(input.basePrompt + NAMING_INSTRUCTION)
    }),
  ],
})

export const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  tools: [AskUserTool, PromptTool],
})

export {
  ExecToolsExtension,
  DelegateExtension,
  AgentsExtension,
  MemoryExtension,
  PrinciplesExtension,
  SkillsExtension,
  LibrarianExtension,
  AcpAgentsExtension,
  WorkflowsExtension,
  HandoffExtension,
  ArtifactsExtension,
}

export const BuiltinExtensions: ReadonlyArray<GentExtension<ChildProcessSpawner>> = [
  HandoffExtension,
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  ChildAgentExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  AgentsExtension,
  WorkflowsExtension,
  MemoryExtension,
  PrinciplesExtension,
  SkillsExtension,
  LibrarianExtension,
  AcpAgentsExtension,
  AnthropicExtension,
  OpenAIExtension,
  GoogleExtension,
  MistralExtension,
  ArtifactsExtension,
].map((extension) => {
  if (Option.isNone(BuiltinArtifactIdentity)) return extension
  return {
    ...extension,
    artifactIdentity: BuiltinArtifactIdentity.value,
  }
})
