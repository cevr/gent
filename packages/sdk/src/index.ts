// Shared transport contract
export {
  QueueEntryInfo,
  QueueSnapshot,
  emptyQueueSnapshot,
} from "@gent/core-internal/domain/queue.js"

export {
  Session,
  Branch,
  SessionSnapshot,
  SlashCommandInfo,
  DriverInfo,
  DriverListResult,
  ConnectionState,
  GentConnectionError,
} from "@gent/core-internal/server/transport-contract.js"
export type {
  GentLifecycle,
  BranchTreeNode,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  SteerCommand,
  SessionTreeNode,
} from "@gent/core-internal/server/transport-contract.js"
export type { CreateSessionResult } from "./client.js"

// Client constructors
export {
  Gent,
  type GentServer,
  type GentServerOptions,
  type StateSpec,
  type ProviderSpec,
  type RpcHandlersContext,
  type GentClientRpcError,
  type GentClientBundle,
  type GentClientOptions,
} from "./client.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Server identity probe (shared by resolveServer + CLI `server stop`)
export { probeServerLockEntryIdentity } from "./server.js"

// Message types
export type { AuthProviderInfo, AuthMethod, AuthAuthorization } from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  Message,
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  ProjectedMessage,
  ToolInteraction,
  PermissionRule,
  SessionId,
  BranchId,
  MessageId,
} from "./client.js"

// Utility functions
export { extractText, extractReasoning, extractImages, type ImageInfo } from "./client.js"
