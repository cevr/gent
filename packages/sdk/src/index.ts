// Client
export {
  type GentClient,
  type GentRpcClient,
  type GentRpcError,
  type GentRpcsClient,
  createClient,
  makeClient,
  makeInProcessClient,
  makeInProcessRpcClient,
  type RpcHandlersContext,
} from "./client.js"

// HTTP transport
export { HttpTransport, type HttpTransportConfig } from "./client.js"

// Message types
export type {
  MessageInfoReadonly,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionState,
  CreateSessionResult,
  SteerCommand,
  AuthProviderInfo,
  AuthMethod,
  AuthAuthorization,
} from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  MessagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
} from "./client.js"

// Utility functions
export {
  extractText,
  extractImages,
  extractToolCalls,
  extractToolCallsWithResults,
  buildToolResultMap,
  type ImageInfo,
  type ExtractedToolCall,
} from "./client.js"

// Direct client (in-process, no RPC layer)
export { makeDirectClient, type DirectClient, type DirectClientContext } from "./direct-client.js"
