import type { GentExtension } from "../domain/extension.js"
import { FsToolsExtension } from "./fs-tools/index.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { NetworkToolsExtension } from "./network-tools/index.js"
import { SubagentToolsExtension } from "./subagent-tools/index.js"
import { InteractionToolsExtension } from "./interaction-tools/index.js"
import { SessionToolsExtension } from "./session-tools/index.js"
import { TaskExtension } from "./task-tools/index.js"
import { WorkflowToolsExtension } from "./workflow-tools/index.js"
import { AgentsExtension } from "./agents.js"
import { PlanExtension } from "./plan.js"
import { AutoExtension } from "./auto.js"
import { MemoryExtension } from "./memory/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { BedrockExtension } from "./bedrock/index.js"
import { GoogleExtension } from "./google/index.js"
import { MistralExtension } from "./mistral/index.js"
import { HandoffExtension } from "./handoff.js"
import { PrinciplesExtension } from "./principles/index.js"
import { ReviewExtension } from "./review/index.js"
import { CounselExtension } from "./counsel/index.js"

export {
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  SubagentToolsExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskExtension,
  WorkflowToolsExtension,
  AgentsExtension,
  PlanExtension,
  AutoExtension,
  MemoryExtension,
  HandoffExtension,
  PrinciplesExtension,
  ReviewExtension,
  CounselExtension,
}

export const BuiltinExtensions: ReadonlyArray<GentExtension> = [
  HandoffExtension,
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  SubagentToolsExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskExtension,
  WorkflowToolsExtension,
  AgentsExtension,
  PlanExtension,
  AutoExtension,
  MemoryExtension,
  PrinciplesExtension,
  ReviewExtension,
  CounselExtension,
  AnthropicExtension,
  OpenAIExtension,
  BedrockExtension,
  GoogleExtension,
  MistralExtension,
]
