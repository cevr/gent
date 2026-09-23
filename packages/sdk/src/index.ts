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
  GentNamespacedClient,
  Message,
  MessageSegment,
  ProjectedMessage,
  SteerCommand,
  ToolInteraction,
} from "@gent/core/protocol"

// Client constructors
export { Gent, type GentClientBundle } from "./client.js"
export type { GentRuntime } from "./runtime-boundary.js"
export type { IdleShutdownSpec } from "./server.js"

// Launch-value decoders: a launcher reads strings from its environment,
// and these turn one into a value `Gent.server` accepts, or fail at startup.
export { LaunchConfig } from "./server.js"
// Server discovery: the shared lock file clients read to find, and stop, a running server
export { serverLock, ServerLockEntry, ServerLockStatus } from "./server.js"
// Where gent keeps its durable state: the server writes it, the doctor reads it
export { dataPaths, dataPathsIn } from "./server.js"
// The log paths a client shares with its server, and the JSON line format both write
export {
  buildLogPaths,
  classifyLogFile,
  ensureLogDir,
  LOG_DIR,
  makeJsonFileLogger,
} from "./logger.js"

// Utility functions
