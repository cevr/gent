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
  ResourceGraphExtensionSource,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
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

// Durable resource-graph repair values. These schemas let a control client
// validate a snapshot previewed from the target declarations before submit.
export type {
  ResourceGraphExtensionSource as ResourceGraphExtensionSourceType,
  ResourceGraphSnapshot as ResourceGraphSnapshotType,
  ResourceGraphSource as ResourceGraphSourceType,
  ResourceDescriptor as ResourceDescriptorType,
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
