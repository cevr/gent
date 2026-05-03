// Re-export client types/functions from SDK
export {
  type GentNamespacedClient,
  type GentRuntime,
  type GentRpcError,
  type Message,
  type Session as DomainSession,
  type Branch,
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
  extractText,
  extractReasoning,
  extractImages,
} from "@gent/sdk"

// Local context exports
export type {
  Session,
  SessionState,
  ClientContextValue,
  ClientTransportValue,
  ClientSessionValue,
  ClientAgentValue,
  ClientActionValue,
} from "./context"
export {
  ClientProvider,
  useClient,
  useClientTransport,
  useClientSession,
  useClientAgent,
  useClientActions,
  useClientRuntime,
  useClientTransportState,
  SteerCommandInput,
} from "./context"
