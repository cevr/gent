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

// Durable resource-graph repair values. These schemas let a control client
// validate a snapshot previewed from the target declarations before submit.
export {
  CanonicalCwd,
  ResourceGraphExtensionSource,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
} from "@gent/core-internal/domain/resource-graph-state.js"
export type {
  ResourceGraphExtensionSource as ResourceGraphExtensionSourceType,
  ResourceGraphSnapshot as ResourceGraphSnapshotType,
  ResourceGraphSource as ResourceGraphSourceType,
} from "@gent/core-internal/domain/resource-graph-state.js"
export {
  ResourceDescriptor,
  ResourceId,
  ResourceRevision,
} from "@gent/core-internal/domain/resource-graph.js"
export type { ResourceDescriptor as ResourceDescriptorType } from "@gent/core-internal/domain/resource-graph.js"

// Client constructors
export {
  Gent,
  type GentServer,
  type GentServerOptions,
  type GentClientRpcError,
  type GentClientBundle,
} from "./client.js"

export { RequestId } from "@gent/core-internal/domain/ids.js"

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
  ProjectedMessage,
  ToolInteraction,
  PermissionRule,
  SessionId,
  BranchId,
  MessageId,
} from "./client.js"

// Utility functions
export { extractText, extractReasoning, extractImages, type ImageInfo } from "./client.js"
