// Shared transport contract
export type {
  GentClient,
  MessageInfoReadonly,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  SessionSnapshot,
  SessionRuntime,
  CreateSessionResult,
  SteerCommand,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionTreeNode,
  SkillInfo,
  SkillContent,
} from "@gent/core/server/transport-contract.js"

// Transport adapters
export {
  type GentRpcClient,
  type GentRpcError,
  type GentRpcsClient,
  createClient,
  makeClient,
  makeHttpGentClient,
  makeInProcessClient,
  makeInProcessRpcClient,
  type RpcHandlersContext,
} from "./client.js"

// HTTP transport
export { HttpTransport, type HttpTransportConfig } from "./client.js"

// Message types
export type {
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

// Direct in-process transport adapter
export { makeDirectGentClient, type DirectGentClientContext } from "./client.js"
export type { SkillScope } from "./client.js"
