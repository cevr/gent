import type { GentExtension } from "../domain/extension.js"
import { FsToolsExtension } from "./fs-tools/index.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { NetworkToolsExtension } from "./network-tools/index.js"
import { DelegateExtension } from "./delegate/index.js"
import { InteractionToolsExtension } from "./interaction-tools/index.js"
import { SessionToolsExtension } from "./session-tools/index.js"
import { TaskExtension } from "./task-tools/index.js"
import { AuditExtension } from "./audit/index.js"
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
import { SkillsExtension } from "./skills/index.js"
import { ReviewExtension } from "./review/index.js"
import { CounselExtension } from "./counsel/index.js"
import { ResearchExtension } from "./research/index.js"

export {
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskExtension,
  AuditExtension,
  AgentsExtension,
  PlanExtension,
  AutoExtension,
  MemoryExtension,
  HandoffExtension,
  PrinciplesExtension,
  SkillsExtension,
  ReviewExtension,
  CounselExtension,
  ResearchExtension,
}

export const BuiltinExtensions: ReadonlyArray<GentExtension> = [
  HandoffExtension,
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  DelegateExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskExtension,
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
  AnthropicExtension,
  OpenAIExtension,
  BedrockExtension,
  GoogleExtension,
  MistralExtension,
]
