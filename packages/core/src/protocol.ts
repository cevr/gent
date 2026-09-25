/** Shared client schemas, projections, and the RPC contract. No host services. */
export {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DEFAULT_MODEL_ID,
  ReasoningEffort,
  resolveAgentModel,
} from "./domain/agent.js"
export { AuthAuthorization, AuthMethod, AuthProviderInfo } from "./runtime/provider.js"
export {
  type ActiveInteraction,
  AgentEvent,
  EventEnvelope,
  type ApprovalResult,
  InteractionPresented,
  type QuestionOption,
  QuestionSchema,
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
  lineCount,
  splitLines,
  headTail,
  projectMessage,
} from "./domain/message.js"
export {
  type ImagePartProjection,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
} from "./domain/message.js"
export { Model, ModelId, ProviderId } from "./domain/agent.js"
export { QueueEntryInfo, QueueSnapshot } from "./domain/message.js"
export { type ModelContextMetrics } from "./domain/agent-loop.js"
export {
  CONTEXT_WINDOW_MESSAGE_TYPE,
  MODEL_CHANGE_MESSAGE_TYPE,
  modelInputCeilingTokens,
  windowDetails,
} from "./runtime/model-context.js"
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
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  GentConnectionError,
  type GentLifecycle,
  SessionSnapshot,
  type UpdateSessionSettingsInput,
} from "./server/rpc.js"
