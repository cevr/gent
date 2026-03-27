// Re-export client types/functions from SDK
export {
  type GentNamespacedClient,
  type GentRuntime,
  type GentRpcError,
  type MessageInfoReadonly,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SessionTreeNode,
  type SteerCommand,
  type AuthProviderInfo,
  type AuthMethod,
  type AuthAuthorization,
  type MessagePart,
  type TextPart,
  type ReasoningPart,
  type ToolCallPart,
  type ToolResultPart,
  type PermissionRule,
  type ImageInfo,
  type ExtractedToolCall,
  extractText,
  extractReasoning,
  extractImages,
  extractToolCalls,
  extractToolCallsWithResults,
  buildToolResultMap,
} from "@gent/sdk"

// Local context exports
export type { Session, SessionState, ClientContextValue } from "./context"
export { ClientProvider, useClient } from "./context"
