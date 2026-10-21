/** Shared client schemas, projections, and the RPC contract. No host services. */
export { AgentDefinition, AgentName, DEFAULT_AGENT_NAME, ReasoningEffort } from "./domain/agent.js"
export {
  AuthMethod,
  AuthPrompt,
  authMethodAppliesTo,
  type CredentialReceipt,
  LaneReport,
  type LaneWindow,
  ProviderLanes,
  sameCredential,
} from "./domain/driver.js"
export { AuthAuthorization, AuthProviderInfo } from "./runtime/provider.js"
export { AgentEvent, EventEnvelope, InteractionPresented } from "./domain/event.js"
// A request's reply on the wire, and its decode by the request's output schema.
export { decodeRequestReply, RequestReply } from "./domain/capability.js"
// One decision schema; the client names its type `ApprovalResult`.
export {
  ApprovalDecisionSchema,
  type ApprovalDecision as ApprovalResult,
} from "./domain/interaction.js"
export {
  type ExtensionScope,
  isClientEntrypoint,
  isClientFile,
  SCOPE_PRECEDENCE,
} from "./domain/extension.js"
export {
  BranchId,
  CredentialSlot,
  DEFAULT_CREDENTIAL_SLOT,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
} from "./domain/ids.js"
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
export {
  cacheWriteRate,
  effectiveEffort,
  Model,
  ModelAttempts,
  modelAttemptsLeft,
  MODEL_ATTEMPTS_NOTICE_LEFT,
  ModelId,
  promptCacheTtlMsFor,
  ProviderId,
} from "./domain/agent.js"
export {
  MODEL_ATTEMPTS_MESSAGE_TYPE,
  QueueEntryInfo,
  QueueSnapshot,
  RuntimeUserMessageType,
} from "./domain/message.js"
export {
  initialSessionMetrics,
  type ModelContextMetrics,
  type SessionRuntimeMetrics,
  SessionRuntimeStateSchema,
  stepSessionMetrics,
  interjectionMessageId,
  userMessageIdForRequest,
} from "./domain/agent-loop.js"
export {
  coldHandoffPays,
  CONTEXT_WINDOW_MESSAGE_TYPE,
  contextWindowOf,
  MODEL_CHANGE_MESSAGE_TYPE,
  modelInputCeilingTokens,
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
  EffortSetting,
  ExtensionHealthIssue,
  ExtensionHealthSnapshot,
  ExtensionStatusScope,
  GentConnectionError,
  type GentLifecycle,
  SessionSnapshot,
  type UpdateSessionSettingsInput,
} from "./server/rpc.js"

export { PermitStatus } from "./runtime/permits.js"
