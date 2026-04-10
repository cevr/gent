import type { ExtensionInput } from "../domain/extension-package.js"
import { FsToolsExtension } from "./fs-tools/index.js"
import { ExecToolsExtension } from "./exec-tools/index.js"
import { NetworkToolsExtension } from "./network-tools/index.js"
import { DelegateExtension } from "./delegate/index.js"
import { SessionToolsExtension } from "./session-tools/index.js"
import { AuditExtension } from "./audit/index.js"
import { AgentsExtension } from "./agents.js"
import { MemoryExtension } from "./memory/index.js"
import { AnthropicExtension } from "./anthropic/index.js"
import { OpenAIExtension } from "./openai/index.js"
import { BedrockExtension } from "./bedrock/index.js"
import { GoogleExtension } from "./google/index.js"
import { MistralExtension } from "./mistral/index.js"
import { PrinciplesExtension } from "./principles/index.js"
import { SkillsExtension } from "./skills/index.js"
import { ReviewExtension } from "./review/index.js"
import { CounselExtension } from "./counsel/index.js"
import { ResearchExtension } from "./research/index.js"
// Package-based builtins
import { AutoPackage } from "./auto-package.js"
import { PlanPackage } from "./plan-package.js"
import { TaskToolsPackage } from "./task-tools-package.js"
import { HandoffPackage } from "./handoff-package.js"
import { InteractionToolsPackage } from "./interaction-tools-package.js"
import { ArtifactsPackage } from "./artifacts-package.js"

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
  AutoPackage,
  PlanPackage,
  TaskToolsPackage,
  HandoffPackage,
  InteractionToolsPackage,
  ArtifactsPackage,
}

// Re-export individual extensions for backwards compatibility
export { AutoExtension } from "./auto.js"
export { PlanExtension, PLAN_EXTENSION_ID } from "./plan.js"
export { TaskExtension } from "./task-tools/index.js"
export { HandoffExtension } from "./handoff.js"
export { InteractionToolsExtension } from "./interaction-tools/index.js"

export const BuiltinExtensions: ReadonlyArray<ExtensionInput> = [
  HandoffPackage,
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  DelegateExtension,
  InteractionToolsPackage,
  SessionToolsExtension,
  TaskToolsPackage,
  AuditExtension,
  AgentsExtension,
  PlanPackage,
  AutoPackage,
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
  ArtifactsPackage,
]
