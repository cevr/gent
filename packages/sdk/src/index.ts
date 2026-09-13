// Shared transport contract
export {
  Branch,
  ConnectionState,
  DriverInfo,
  DriverListResult,
  GentConnectionError,
  QueueEntryInfo,
  QueueSnapshot,
  RequestId,
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
// Server discovery: the shared lock file and the build fingerprint clients compare against
export {
  BuildFingerprint,
  getLocalHostname,
  isPidAlive,
  readServerLock,
  removeServerLock,
  ServerLockEntry,
  signalIfIdentityOwned,
  validateServerLockEntry,
} from "./server-lock.js"
// Observability for a composition root, and the log paths a client shares with its server
export { GentObservability } from "./logger.js"
// The debug fixture a composition root seeds when started with --debug
export { seedDebugSession } from "./debug-session.js"
export { buildLogPaths, LOG_DIR } from "./log-paths.js"
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
