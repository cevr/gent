// Shared transport contract
export {
  Branch,
  ConnectionState,
  GentConnectionError,
  QueueEntryInfo,
  QueueSnapshot,
  Session,
  SessionSnapshot,
  emptyQueueSnapshot,
} from "@gent/core/protocol"
export type {
  BranchTreeNode,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  SteerCommand,
} from "@gent/core/protocol"

// Client constructors
export {
  Gent,
  type IdleShutdownSpec,
  type GentClientRpcError,
  type GentClientBundle,
} from "./client.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Server identity probe (shared by resolveServer + CLI `server stop`)
export { probeServerLockEntryIdentity } from "./server.js"
// Server discovery: the shared lock file clients read to find a running server
export {
  getLocalHostname,
  isPidAlive,
  readServerLock,
  removeServerLock,
  ServerLockEntry,
  signalIfIdentityOwned,
  validateServerLockEntry,
} from "./server-lock.js"
// The log paths a client shares with its server, and the JSON line format both write
export { buildLogPaths, LOG_DIR } from "./log-paths.js"
export { makeJsonFileLogger } from "./logger.js"

// Message types
export type { AuthProviderInfo, AuthMethod, AuthAuthorization } from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  Message,
  MessagePart,
  MessageSegment,
  ProjectedMessage,
  ToolInteraction,
} from "./client.js"

// Utility functions
export { extractText, extractReasoning, extractImages, type ImageInfo } from "./client.js"
