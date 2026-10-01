// Client constructors
export { Gent, type GentClientBundle, type GentRuntime } from "./client.js"

// Server discovery: the shared lock file clients read to find, and stop, a running server
export { serverLock, ServerLockEntry, ServerLockStatus } from "./server.js"
// Where gent keeps its durable state: the server writes it, the doctor reads it
export { dataPaths } from "./server.js"
// The log paths a client shares with its server, and the JSON line format both write
export { buildLogPaths, classifyLogFile, ensureLogDir, makeJsonFileLogger } from "./logger.js"
