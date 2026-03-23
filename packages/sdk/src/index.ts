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
  QueueEntryInfo,
  QueueSnapshot,
  AuthProviderInfo,
  AuthMethod,
  AuthAuthorization,
} from "./client.js"

// Part types (re-exported from @gent/core)
export type {
  MessagePart,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  PermissionRule,
  SessionId,
  BranchId,
  MessageId,
} from "./client.js"

// Utility functions
export {
  extractText,
  extractReasoning,
  extractImages,
  extractToolCalls,
  extractToolCallsWithResults,
  buildToolResultMap,
  type ImageInfo,
  type ExtractedToolCall,
} from "./client.js"

// Direct GentClient (in-process, no RPC layer)
export { makeDirectGentClient, type DirectGentClientContext } from "./client.js"

// Session tree types
export type { SessionTreeNode } from "./client.js"

// Skill types
export type { SkillInfo, SkillContent, SkillScope } from "./client.js"
