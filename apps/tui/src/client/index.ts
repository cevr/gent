// Re-export client types/functions from SDK
export {
  type GentClient,
  type GentRpcClient,
  type GentRpcError,
  type MessageInfoReadonly,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SteerCommand,
  type AuthProviderInfo,
  type AuthMethod,
  type AuthAuthorization,
  type MessagePart,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type PermissionRule,
  type ImageInfo,
  type ExtractedToolCall,
  createClient,
  makeInProcessRpcClient,
  extractText,
  extractImages,
  extractToolCalls,
  extractToolCallsWithResults,
  buildToolResultMap,
} from "@gent/sdk"

// Local context exports
export type { Session, SessionState, ClientContextValue } from "./context"
export { ClientProvider, useClient } from "./context"
