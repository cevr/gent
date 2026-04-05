import type { GentExtension } from "../domain/extension.js"
import { FsToolsExtension } from "./fs-tools/index.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { NetworkToolsExtension } from "./network-tools/index.js"
import { SubagentToolsExtension } from "./subagent-tools.js"
import { InteractionToolsExtension } from "./interaction-tools.js"
import { SessionToolsExtension } from "./session-tools.js"
import { TaskExtension } from "./task-tools.js"
import { WorkflowToolsExtension } from "./workflow-tools.js"
import { AgentsExtension } from "./agents.js"
import { PlanExtension } from "./plan.js"
import { AutoExtension } from "./auto.js"
import { MemoryExtension } from "./memory/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { BedrockExtension } from "./bedrock/index.js"
import { GoogleExtension } from "./google/index.js"
import { MistralExtension } from "./mistral/index.js"
import { InteractionHandlersExtension } from "./interaction-handlers.js"
import { HandoffExtension } from "./handoff.js"

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
  InteractionHandlersExtension,
  HandoffExtension,
}

export const BuiltinExtensions: ReadonlyArray<GentExtension> = [
  InteractionHandlersExtension,
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
  AnthropicExtension,
  OpenAIExtension,
  BedrockExtension,
  GoogleExtension,
  MistralExtension,
]
