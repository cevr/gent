/** Shared client schemas, projections, and the RPC contract. No host services. */
export {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  ExternalDriverRef,
  ModelDriverRef,
  ReasoningEffort,
  type RunSpec,
  RunSpecSchema,
} from "./domain/agent.js"
export { AuthAuthorization, AuthMethod, AuthProviderInfo } from "./domain/auth.js"
export {
  type ActiveInteraction,
  AgentEvent,
  EventEnvelope,
  type ApprovalResult,
  InteractionPresented,
  type QuestionOption,
  QuestionSchema,
} from "./domain/event.js"
export { BranchId, MessageId, RequestId, SessionId, ToolCallId } from "./domain/ids.js"
export {
  Branch,
  Message,
  MessagePart,
  ProjectedMessage,
  Session,
  ToolInteraction,
  assistantMessageIdForTurn,
  dateFromMillis,
  projectMessage,
} from "./domain/message.js"
export {
  messagePartImage,
  messagePartReasoning,
  messagePartText,
  messagePartToolCall,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
} from "./domain/message-part-projection.js"
export { Model, ModelId, ProviderId } from "./domain/model.js"
export { PermissionRule } from "./domain/permission.js"
export { QueueEntryInfo, QueueSnapshot, emptyQueueSnapshot } from "./domain/queue.js"
export { ResourceDescriptor, ResourceId, ResourceRevision } from "./domain/resource-graph.js"
export {
  CanonicalCwd,
  ResourceGraphExtensionSource,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
} from "./domain/resource-graph-state.js"
export { type ModelContextMetrics } from "./runtime/agent/agent-loop.state.js"
export { GentRpcError } from "./server/errors.js"
export { type GentClientRpcError, type GentRpcClient, GentRpcs } from "./server/rpcs.js"
export {
  BranchTreeNode,
  ConnectionState,
  CreateSessionInput,
  DriverInfo,
  DriverListResult,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  GentConnectionError,
  type GentLifecycle,
  SessionSnapshot,
  SessionTreeNode,
  SlashCommandInfo,
  type SteerCommand,
} from "./server/transport-contract.js"
