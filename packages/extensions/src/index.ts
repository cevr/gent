import { type GentExtension } from "@gent/core/extensions/api"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FsToolsExtension } from "./fs-tools/index.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { NetworkToolsExtension } from "./network-tools/index.js"
import { DelegateExtension } from "./delegate/delegate-tool.js"
import { SessionToolsExtension } from "./session-tools/index.js"
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
import { InteractionToolsExtension } from "./interaction-tools/index.js"
import { ArtifactsExtension } from "./artifacts/index.js"
import { ExecutorExtension } from "./executor/index.js"

export {
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  DelegateExtension,
  SessionToolsExtension,
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
  InteractionToolsExtension,
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
