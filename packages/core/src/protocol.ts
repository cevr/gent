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
  ProjectedMessage,
  Session,
  ToolInteraction,
  assistantMessageIdForTurn,
  dateFromMillis,
  projectMessage,
} from "./domain/message.js"
export {
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
} from "./domain/message-part-display.js"
export { Model, ModelId, ProviderId } from "./domain/agent.js"
export { QueueEntryInfo, QueueSnapshot, emptyQueueSnapshot } from "./domain/queue.js"
export { type ModelContextMetrics } from "./runtime/agent/agent-loop.state.js"
export { GentRpcError } from "./server/errors.js"
export { type GentClientRpcError, type GentRpcClient, GentRpcs } from "./server/rpcs.js"
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
  type SteerCommand,
} from "./server/transport-contract.js"
