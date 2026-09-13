// Shared transport contract
export {
  Branch,
  CanonicalCwd,
  ConnectionState,
  DriverInfo,
  DriverListResult,
  GentConnectionError,
  QueueEntryInfo,
  QueueSnapshot,
  RequestId,
  ResourceDescriptor,
  ResourceId,
  ResourceRevision,
  Session,
  SessionSnapshot,
  SlashCommandInfo,
  emptyQueueSnapshot,
} from "@gent/core/protocol"
export type {
  GentLifecycle,
  BranchTreeNode,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  SteerCommand,
  SessionTreeNode,
} from "@gent/core/protocol"

// Client constructors
export {
  Gent,
  type GentServer,
  type GentServerOptions,
  type GentClientRpcError,
  type GentClientBundle,
} from "./client.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Server identity probe (shared by resolveServer + CLI `server stop`)
export { probeServerLockEntryIdentity } from "./server.js"
export { ShippedExtensions } from "./shipped-extensions.js"

// Message types
export type { AuthProviderInfo, AuthMethod, AuthAuthorization } from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  Message,
  MessagePart,
  ProjectedMessage,
  ToolInteraction,
  PermissionRule,
  SessionId,
  BranchId,
  MessageId,
} from "./client.js"

// Utility functions
export { extractText, extractReasoning, extractImages, type ImageInfo } from "./client.js"
