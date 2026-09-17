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
  GentClientRpcError,
  Message,
  MessageSegment,
  ProjectedMessage,
  SteerCommand,
  ToolInteraction,
} from "@gent/core/protocol"

// Client constructors
export { Gent, type GentClientBundle } from "./client.js"
export type { IdleShutdownSpec } from "./server.js"

// Namespaced client + runtime types
export type { GentNamespacedClient, GentRuntime } from "./namespaced-client.js"

// Server identity probe (shared by resolveServer + CLI `server stop`)
export { probeServerLockEntryIdentity } from "./server.js"
// Launch-value decoders: a launcher reads strings from its environment,
// and these turn one into a value `Gent.server` accepts, or fail at startup.
export { LaunchConfig } from "./server.js"
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
// Where gent keeps its durable state: the server writes it, the doctor reads it
export { dataPaths, dataPathsIn } from "./data-paths.js"
// The log paths a client shares with its server, and the JSON line format both write
export { buildLogPaths, classifyLogFile, ensureLogDir, LOG_DIR } from "./log-paths.js"
export { makeJsonFileLogger } from "./logger.js"

// Utility functions
export { extractText, extractReasoning, extractImages, type ImageInfo } from "./client.js"
