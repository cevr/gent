/** Shared client schemas, projections, and the RPC contract. No host services. */
export {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  DriverRef,
  ReasoningEffort,
  resolveAgentModel,
} from "./domain/agent.js"
export { AuthAuthorization, AuthMethod, AuthProviderInfo } from "./runtime/provider.js"
export {
  type ActiveInteraction,
  AgentEvent,
  EventEnvelope,
  EventStoreError,
  type ApprovalResult,
  ErrorOccurred,
  EventId,
  InteractionPresented,
  MessageReceived,
  type QuestionOption,
  QuestionSchema,
  StreamEnded,
  StreamStarted,
  ToolCallStarted,
  ToolCallSucceeded,
  TurnCompleted,
} from "./domain/event.js"
export {
  type ExtensionScope,
  isClientEntrypoint,
  isClientFile,
  SCOPE_PRECEDENCE,
} from "./domain/extension.js"
export { BranchId, MessageId, SessionId, ToolCallId } from "./domain/ids.js"
export {
  Branch,
  Message,
  MessagePart,
  MessageSegment,
  OutputCut,
  ProjectedMessage,
  Session,
  SessionAdmission,
  ToolInteraction,
  SteerCommand,
  assistantMessageIdForTurn,
  dateFromMillis,
  formatHeadTail,
  headTail,
  projectMessage,
  projectMessagesWithToolInteractions,
  toolResultMessageIdForTurn,
} from "./domain/message.js"
export {
  type ImagePartProjection,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
} from "./domain/message.js"
export { Model, ModelId, ProviderId } from "./domain/agent.js"
export { QueueEntryInfo, QueueSnapshot, emptyQueueSnapshot } from "./domain/message.js"
export { type ModelContextMetrics, type SessionRuntimeState } from "./domain/agent-loop.js"
export { DriverError, DriverFailureId } from "./domain/driver.js"
export { SessionRuntimeError } from "./runtime/session.js"
export {
  CONTEXT_WINDOW_MESSAGE_TYPE,
  MODEL_CHANGE_MESSAGE_TYPE,
  windowDetails,
} from "./runtime/model-context.js"
export { NotFoundError, ProviderError, StorageError } from "./domain/errors.js"
export { GentRpcError } from "./server/rpc.js"
export {
  type GentClientRpcError,
  type GentNamespacedClient,
  type GentRpcClient,
  GentRpcs,
  makeNamespacedClient,
} from "./server/rpc.js"
export {
  BranchTreeNode,
  ConnectionState,
  CreateSessionInput,
  DriverListResult,
  ExtensionHealth,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  GentConnectionError,
  type GentLifecycle,
  SessionSnapshot,
} from "./server/rpc.js"
