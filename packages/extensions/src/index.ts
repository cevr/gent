import { Effect } from "effect"
import {
  type GentExtension,
  defineExtension,
  defineResource,
  ExtensionId,
} from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { DelegateExtension } from "./delegate/delegate-tool.js"
import { AuditExtension } from "./audit/index.js"
import { AgentsExtension } from "./agents.js"
import { MemoryExtension } from "./memory/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { GoogleExtension, MistralExtension } from "./openai-compatible-driver.js"
import { PrinciplesExtension } from "./principles/principles-tool.js"
import { SkillsExtension } from "./skills/index.js"
import { ReviewExtension } from "./review/review-tool.js"
import { CounselExtension } from "./counsel/counsel-tool.js"
import { ResearchExtension } from "./research/index.js"
import { LibrarianExtension } from "./librarian/index.js"
import { AcpAgentsExtension } from "./acp-agents/index.js"
import { AutoExtension } from "./auto/index.js"
import { PlanExtension } from "./plan.js"
import { TodoExtension } from "./todo/index.js"
import { HandoffExtension } from "./handoff.js"
import { ArtifactsExtension } from "./artifacts/index.js"
import { ExecutorExtension } from "./executor/index.js"
import { ReadTool } from "./fs-tools/read.js"
import { WriteTool } from "./fs-tools/write.js"
import { EditTool } from "./fs-tools/edit.js"
import { GlobTool } from "./fs-tools/glob.js"
import { GrepTool } from "./fs-tools/grep.js"
import { FsRead } from "./fs-tools/read-service.js"
import { WebFetchTool } from "./network-tools/webfetch.js"
import { WebSearchTool } from "./network-tools/websearch.js"
import { SearchSessionsTool } from "./session-tools/search-sessions.js"
import { ReadSessionTool } from "./session-tools/read-session.js"
import { RenameSessionTool } from "./session-tools/rename-session.js"
import { AskUserTool } from "./interaction-tools/ask-user.js"
import { PromptTool } from "./interaction-tools/prompt.js"

const NAMING_INSTRUCTION = `
## Session naming
Call rename_session with a specific 3-5 word lowercase title once you understand what the user needs. If the conversation topic shifts significantly, rename again.`

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  resources: [defineResource({ scope: "process", layer: FsRead.Live })],
  tools: [ReadTool, WriteTool, EditTool, GlobTool, GrepTool],
})

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  tools: [WebFetchTool, WebSearchTool],
})

export const SessionToolsExtension = defineExtension({
  id: "@gent/session-tools",
  tools: [SearchSessionsTool, ReadSessionTool, RenameSessionTool],
  reactions: {
    systemPrompt: (input) =>
      Effect.succeed(
        input.interactive === false ? input.basePrompt : input.basePrompt + NAMING_INSTRUCTION,
      ),
  },
})

export const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  tools: [AskUserTool, PromptTool],
})

export {
  ExecToolsExtension,
  DelegateExtension,
  AuditExtension,
  AgentsExtension,
  MemoryExtension,
  PrinciplesExtension,
  SkillsExtension,
  ReviewExtension,
  CounselExtension,
  ResearchExtension,
  LibrarianExtension,
  AcpAgentsExtension,
  AutoExtension,
  PlanExtension,
  TodoExtension,
  HandoffExtension,
  ArtifactsExtension,
  ExecutorExtension,
}

export { AllBuiltinAgents, getBuiltinAgent } from "./all-agents.js"

export const BuiltinExtensions: ReadonlyArray<GentExtension<ChildProcessSpawner>> = [
  HandoffExtension,
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  ExecutorExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TodoExtension,
  AuditExtension,
  AgentsExtension,
  PlanExtension,
  AutoExtension,
  MemoryExtension,
  PrinciplesExtension,
  SkillsExtension,
  ReviewExtension,
  CounselExtension,
  ResearchExtension,
  LibrarianExtension,
  AcpAgentsExtension,
  AnthropicExtension,
  OpenAIExtension,
  GoogleExtension,
  MistralExtension,
  ArtifactsExtension,
]
