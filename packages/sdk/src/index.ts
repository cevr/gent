// Shared transport contract
export { QueueEntryInfo, QueueSnapshot, emptyQueueSnapshot } from "@gent/core/domain/queue.js"

export { Message } from "@gent/core/domain/message.js"

export {
  Session,
  Branch,
  SessionSnapshot,
  SlashCommandInfo,
  DriverInfo,
  DriverListResult,
  GentConnectionError,
} from "@gent/core/server/transport-contract.js"
export type {
  GentLifecycle,
  ConnectionState,
  BranchTreeNode,
  SessionRuntime,
  CreateSessionResult,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  SteerCommand,
  SessionTreeNode,
} from "@gent/core/server/transport-contract.js"

// Client constructors
export {
  Gent,
  type GentServer,
  type GentServerOptions,
  type StateSpec,
  type ProviderSpec,
  type RpcHandlersContext,
  type GentRpcClient,
  type GentRpcsClient,
  type GentRpcError,
  type GentClientBundle,
} from "./client.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Server identity probe (shared by resolveServer + CLI `server stop`)
export { probeRegistryEntryIdentity } from "./server.js"

// Message types
export type { AuthProviderInfo, AuthMethod, AuthAuthorization } from "./client.js"

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
