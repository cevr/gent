// Shared transport contract
export type {
  GentLifecycle,
  ConnectionState,
  MessageInfoReadonly,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  CreateSessionResult,
  SteerCommand,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionTreeNode,
  SkillInfo,
  SkillContent,
} from "@gent/core/server/transport-contract.js"

export { GentConnectionError } from "@gent/core/server/transport-contract.js"

// Client constructors
export {
  Gent,
  type GentSpawnOptions,
  type GentConnectOptions,
  type RpcHandlersContext,
  type GentRpcClient,
  type GentRpcsClient,
  type GentRpcError,
  type GentClientBundle,
} from "./client.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Message types
export type {
  QueueEntryInfo,
  QueueSnapshot,
  AuthProviderInfo,
  AuthMethod,
  AuthAuthorization,
} from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  SessionId,
  BranchId,
  MessageId,
} from "./client.js"

// Utility functions
export {
  extractText,
  extractReasoning,
  extractImages,
  extractToolCalls,
  extractToolCallsWithResults,
  buildToolResultMap,
  type ImageInfo,
  type ExtractedToolCall,
} from "./client.js"

export type { SkillScope } from "./client.js"
