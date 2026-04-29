/**
 * Stable extension authoring surface.
 *
 * This file is intentionally smaller than `extensions/api`: it exports the
 * primitives extension authors should reach for by default, while advanced
 * runtime, provider, actor-engine, and test plumbing stays on explicit domain
 * subpaths or the legacy full-power facade during migration.
 *
 * @module
 */

export {
  defineExtension,
  defineStatefulExtension,
  defineToolExtension,
  defineUiExtension,
  type DefineExtensionInput,
  type DefineStatefulExtensionInput,
  type DefineToolExtensionInput,
  type DefineUiExtensionInput,
  type FieldSpec,
} from "./api.js"

export {
  defineAgent,
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  ModelDriverRef,
  ExternalDriverRef,
  AgentSpec,
  makeRunSpec,
  RunSpecSchema,
  AgentRunOverridesSchema,
  type AgentRunOverrides,
  type AgentRunResult,
  type RunSpec,
} from "../domain/agent.js"

export {
  tool,
  type ToolCapabilityContext,
  type ToolInput,
  type ToolToken,
} from "../domain/capability/tool.js"
export {
  ref,
  request,
  type ReadRequestInput,
  type RequestToken,
  type WriteRequestInput,
} from "../domain/capability/request.js"
export {
  action,
  type ActionInput,
  type ActionSurface,
  type ActionToken,
} from "../domain/capability/action.js"

export type { CapabilityContext, CapabilityRef } from "../domain/capability.js"
export { CapabilityError, CapabilityNotFoundError } from "../domain/capability.js"

export {
  defineResource,
  resource,
  behavior,
  type ExtensionContributions,
  type ExtensionReactions,
} from "../domain/contribution.js"
export type {
  AnyResourceContribution,
  ResourceContribution,
  ResourceSchedule,
  ResourceScope,
  ResourceSpec,
  ScopeOf,
} from "../domain/resource.js"

export {
  ServiceKey,
  ActorAskTimeout,
  type ActorContext,
  type ActorRef,
  type ActorView,
  type Behavior,
} from "../domain/actor.js"

export {
  type ExtensionHostContext,
  ExtensionHostError,
  ExtensionHostSearchResult,
} from "../domain/extension-host-context.js"
export {
  type GentExtension,
  type ProjectionTurnContext,
  type TurnProjection,
  type SystemPromptInput,
  type ToolExecuteInput,
  type PermissionCheckInput,
  type ContextMessagesInput,
  type TurnBeforeInput,
  type TurnAfterInput,
  type ToolResultInput,
  type MessageInputInput,
  type MessageOutputInput,
} from "../domain/extension.js"

export {
  SessionId,
  BranchId,
  TaskId,
  ArtifactId,
  MessageId,
  ToolCallId,
  ExtensionId,
} from "../domain/ids.js"
export { Model, ModelId } from "../domain/model.js"
export { Task, TaskStatus, TaskTransitionError, isValidTaskTransition } from "../domain/task.js"
export { PermissionRule, type PermissionResult } from "../domain/permission.js"

export { isRecord, isRecordArray } from "../domain/guards.js"
export { TaggedEnumClass } from "../domain/schema-tagged-enum-class.js"
export type { PromptSection } from "../domain/prompt.js"
export {
  sectionStartMarker,
  sectionEndMarker,
  sectionPatternFor,
  withSectionMarkers,
} from "../domain/prompt.js"

export {
  type ReadOnly,
  type ReadOnlyTag,
  ReadOnlyBrand,
  withReadOnly,
} from "../domain/read-only.js"

export { buildToolJsonSchema, flattenAllOf } from "../domain/tool-schema.js"
