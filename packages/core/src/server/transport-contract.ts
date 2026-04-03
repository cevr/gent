import { Schema } from "effect"
import type { Effect } from "effect"
import { AgentName, ReasoningEffort } from "../domain/agent.js"
import { AuthAuthorization, AuthMethod } from "../domain/auth-method.js"
import { AuthProviderInfo, AuthProviderQuery } from "../domain/auth-guard.js"
import { EventEnvelope, HandoffDecision, PromptDecision } from "../domain/event.js"
import { ExtensionMessageEnvelope } from "../domain/extension-protocol.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { MessageMetadata, MessagePart } from "../domain/message.js"
// PermissionDecision removed — permissions are now default-allow with deny rules
import { QueueSnapshot } from "../domain/queue.js"
import { SkillScope } from "../domain/skills.js"

export const CreateSessionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  /** If provided, sends this message immediately after creation */
  initialPrompt: Schema.optional(Schema.String),
  /** Agent override for the initial prompt (turn-scoped, not persistent) */
  agentOverride: Schema.optional(Schema.String),
  /** Client-generated request ID for end-to-end correlation */
  requestId: Schema.optional(Schema.String),
})
export type CreateSessionInput = typeof CreateSessionInput.Type

export const CreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
})
export type CreateSessionResult = typeof CreateSessionResult.Type

export const SessionInfo = Schema.Struct({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  reasoningLevel: Schema.optional(ReasoningEffort),
  branchId: Schema.optional(BranchId),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type SessionInfo = typeof SessionInfo.Type

export interface SessionTreeNode {
  id: SessionId
  name?: string
  cwd?: string
  parentSessionId?: SessionId
  parentBranchId?: BranchId
  createdAt: number
  updatedAt: number
  children: readonly SessionTreeNode[]
}

interface SessionTreeNodeEncoded {
  id: string
  name?: string
  cwd?: string
  parentSessionId?: string
  parentBranchId?: string
  createdAt: number
  updatedAt: number
  children: readonly SessionTreeNodeEncoded[]
}

export const SessionTreeNode: Schema.Codec<SessionTreeNode, SessionTreeNodeEncoded> = Schema.Struct(
  {
    id: SessionId,
    name: Schema.optional(Schema.String),
    cwd: Schema.optional(Schema.String),
    parentSessionId: Schema.optional(SessionId),
    parentBranchId: Schema.optional(BranchId),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    children: Schema.Array(Schema.suspend(() => SessionTreeNode)),
  },
)
export const SessionTreeNodeSchema = SessionTreeNode
export type SessionTreeNodeType = SessionTreeNode

export const GetChildSessionsInput = Schema.Struct({
  parentSessionId: SessionId,
})
export type GetChildSessionsInput = typeof GetChildSessionsInput.Type

export const GetSessionTreeInput = Schema.Struct({
  sessionId: SessionId,
})
export type GetSessionTreeInput = typeof GetSessionTreeInput.Type

export const BranchInfo = Schema.Struct({
  id: BranchId,
  sessionId: SessionId,
  parentBranchId: Schema.optional(BranchId),
  parentMessageId: Schema.optional(MessageId),
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})
export type BranchInfo = typeof BranchInfo.Type

export const ListBranchesInput = Schema.Struct({
  sessionId: SessionId,
})
export type ListBranchesInput = typeof ListBranchesInput.Type

export const CreateBranchInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
})
export type CreateBranchInput = typeof CreateBranchInput.Type

export const CreateBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type CreateBranchResult = typeof CreateBranchResult.Type

export interface BranchTreeNode {
  id: BranchId
  name?: string
  summary?: string
  parentMessageId?: MessageId
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

interface BranchTreeNodeEncoded {
  id: string
  name?: string
  summary?: string
  parentMessageId?: string
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNodeEncoded[]
}

export const BranchTreeNode: Schema.Codec<BranchTreeNode, BranchTreeNodeEncoded> = Schema.Struct({
  id: BranchId,
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(MessageId),
  messageCount: Schema.Number,
  createdAt: Schema.Number,
  children: Schema.Array(Schema.suspend(() => BranchTreeNode)),
})
export const BranchTreeNodeSchema = BranchTreeNode

export const GetBranchTreeInput = Schema.Struct({
  sessionId: SessionId,
})
export type GetBranchTreeInput = typeof GetBranchTreeInput.Type

export const SwitchBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
  summarize: Schema.optional(Schema.Boolean),
})
export type SwitchBranchInput = typeof SwitchBranchInput.Type

export const ForkBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  atMessageId: MessageId,
  name: Schema.optional(Schema.String),
})
export type ForkBranchInput = typeof ForkBranchInput.Type

export const ForkBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type ForkBranchResult = typeof ForkBranchResult.Type

export const SendMessageInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  /** Per-run agent override — switches agent for this message only. Uses fresh ephemeral sessions to avoid state bleed. */
  agentOverride: Schema.optional(Schema.String),
  /** Client-generated request ID for end-to-end correlation */
  requestId: Schema.optional(Schema.String),
})
export type SendMessageInput = typeof SendMessageInput.Type

export const MessageInfo = Schema.Struct({
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  kind: Schema.optional(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
  metadata: Schema.optional(MessageMetadata),
})
export type MessageInfoReadonly = typeof MessageInfo.Type

export const ListMessagesInput = Schema.Struct({
  branchId: BranchId,
})
export type ListMessagesInput = typeof ListMessagesInput.Type

export const GetSessionSnapshotInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type GetSessionSnapshotInput = typeof GetSessionSnapshotInput.Type

export const ExtensionSnapshotInfo = Schema.Struct({
  extensionId: Schema.String,
  epoch: Schema.Number,
  model: Schema.Unknown,
})
export type ExtensionSnapshotInfo = typeof ExtensionSnapshotInfo.Type

export const ActiveInteractionSnapshot = Schema.Struct({
  requestId: Schema.String,
  tag: Schema.String,
  event: Schema.Unknown,
})
export type ActiveInteractionSnapshot = typeof ActiveInteractionSnapshot.Type

export const SessionSnapshot = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.optional(Schema.String),
  messages: Schema.Array(MessageInfo),
  lastEventId: Schema.NullOr(Schema.Number),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
  /** Current runtime state (phase/status/agent/queue). Idle sessions return idle runtime. */
  runtime: Schema.suspend(() => SessionRuntime),
  /** Extension UI snapshots for cold-start hydration */
  extensionSnapshots: Schema.optional(Schema.Array(ExtensionSnapshotInfo)),
  /** Pending interaction request, if any — for reconnect hydration */
  activeInteraction: Schema.optional(ActiveInteractionSnapshot),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export const RuntimePhase = Schema.Literals([
  "idle",
  "resolving",
  "streaming",
  "executing-tools",
  "waiting-for-interaction",
  "finalizing",
])
export type RuntimePhase = typeof RuntimePhase.Type

export const RuntimeStatus = Schema.Literals(["idle", "running", "interrupted"])
export type RuntimeStatus = typeof RuntimeStatus.Type

export const SessionRuntime = Schema.Struct({
  phase: RuntimePhase,
  status: RuntimeStatus,
  agent: AgentName,
  queue: QueueSnapshot,
})
export type SessionRuntime = typeof SessionRuntime.Type

const SteerTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SteerCommand = Schema.Union([
  Schema.TaggedStruct("Cancel", SteerTargetFields),
  Schema.TaggedStruct("Interrupt", SteerTargetFields),
  Schema.TaggedStruct("Interject", {
    ...SteerTargetFields,
    message: Schema.String,
    agent: Schema.optional(AgentName),
  }),
  Schema.TaggedStruct("SwitchAgent", { ...SteerTargetFields, agent: AgentName }),
])
export type SteerCommand = typeof SteerCommand.Type

export const QueueTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type QueueTarget = typeof QueueTarget.Type

export const SubscribeEventsInput = Schema.Struct({
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
  after: Schema.optional(Schema.Number),
})
export type SubscribeEventsInput = typeof SubscribeEventsInput.Type

export const WatchRuntimeInput = QueueTarget
export type WatchRuntimeInput = typeof WatchRuntimeInput.Type

export const RespondQuestionsInput = Schema.Struct({
  requestId: Schema.String,
  sessionId: SessionId,
  branchId: BranchId,
  answers: Schema.Array(Schema.Array(Schema.String)),
  cancelled: Schema.optional(Schema.Boolean),
})
export type RespondQuestionsInput = typeof RespondQuestionsInput.Type

export const UpdateSessionReasoningLevelInput = Schema.Struct({
  sessionId: SessionId,
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelInput = typeof UpdateSessionReasoningLevelInput.Type

export const UpdateSessionReasoningLevelResult = Schema.Struct({
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelResult = typeof UpdateSessionReasoningLevelResult.Type

export const RespondPromptInput = Schema.Struct({
  requestId: Schema.String,
  sessionId: SessionId,
  branchId: BranchId,
  decision: PromptDecision,
  content: Schema.optional(Schema.String),
})
export type RespondPromptInput = typeof RespondPromptInput.Type

export const RespondHandoffInput = Schema.Struct({
  requestId: Schema.String,
  sessionId: SessionId,
  branchId: BranchId,
  decision: HandoffDecision,
  reason: Schema.optional(Schema.String),
})
export type RespondHandoffInput = typeof RespondHandoffInput.Type

export const RespondHandoffResult = Schema.Struct({
  childSessionId: Schema.optional(SessionId),
  childBranchId: Schema.optional(BranchId),
})
export type RespondHandoffResult = typeof RespondHandoffResult.Type

export const DeletePermissionRuleInput = Schema.Struct({
  tool: Schema.String,
  pattern: Schema.optional(Schema.String),
})
export type DeletePermissionRuleInput = typeof DeletePermissionRuleInput.Type

export const SetAuthKeyInput = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
})
export type SetAuthKeyInput = typeof SetAuthKeyInput.Type

export const DeleteAuthKeyInput = Schema.Struct({
  provider: Schema.String,
})
export type DeleteAuthKeyInput = typeof DeleteAuthKeyInput.Type

export const ListAuthProvidersInput = AuthProviderQuery
export type ListAuthProvidersInput = typeof ListAuthProvidersInput.Type

export const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthInput = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
})
export type AuthorizeAuthInput = typeof AuthorizeAuthInput.Type

export const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

export const CallbackAuthInput = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
  authorizationId: Schema.String,
  code: Schema.optional(Schema.String),
})
export type CallbackAuthInput = typeof CallbackAuthInput.Type

export { AuthProviderInfo, AuthProviderQuery }
export { EventEnvelope }
export { QueueSnapshot }

export const SendExtensionMessageInput = Schema.Struct({
  sessionId: SessionId,
  message: ExtensionMessageEnvelope,
  branchId: Schema.optional(BranchId),
})
export type SendExtensionMessageInput = typeof SendExtensionMessageInput.Type

export const AskExtensionMessageInput = Schema.Struct({
  sessionId: SessionId,
  message: ExtensionMessageEnvelope,
  branchId: Schema.optional(BranchId),
})
export type AskExtensionMessageInput = typeof AskExtensionMessageInput.Type

export const ListExtensionStatusInput = Schema.Struct({
  sessionId: Schema.optional(SessionId),
})
export type ListExtensionStatusInput = typeof ListExtensionStatusInput.Type

export const ExtensionActivationPhase = Schema.Literals(["setup", "validation", "startup"])
export type ExtensionActivationPhase = typeof ExtensionActivationPhase.Type

export const ExtensionActorLifecycleStatus = Schema.Literals(["starting", "running", "failed"])
export type ExtensionActorLifecycleStatus = typeof ExtensionActorLifecycleStatus.Type

export const ExtensionActorStatusInfo = Schema.Struct({
  extensionId: Schema.String,
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
  status: ExtensionActorLifecycleStatus,
  error: Schema.optional(Schema.String),
})
export type ExtensionActorStatusInfo = typeof ExtensionActorStatusInfo.Type

export const ExtensionManifestInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
})
export type ExtensionManifestInfo = typeof ExtensionManifestInfo.Type

export const ExtensionStatusInfo = Schema.Struct({
  manifest: ExtensionManifestInfo,
  kind: Schema.Literals(["builtin", "user", "project"]),
  sourcePath: Schema.String,
  status: Schema.Literals(["active", "failed"]),
  phase: Schema.optional(ExtensionActivationPhase),
  error: Schema.optional(Schema.String),
  actor: Schema.optional(ExtensionActorStatusInfo),
})
export type ExtensionStatusInfo = typeof ExtensionStatusInfo.Type

export const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  scope: SkillScope,
  filePath: Schema.String,
})
export type SkillInfo = typeof SkillInfo.Type

export const SkillContent = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  scope: SkillScope,
  filePath: Schema.String,
  content: Schema.String,
})
export type SkillContent = typeof SkillContent.Type

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export class GentConnectionError extends Schema.TaggedErrorClass<GentConnectionError>()(
  "@gent/core/GentConnectionError",
  { message: Schema.String },
) {}

export type ConnectionState =
  | { readonly _tag: "connecting" }
  | { readonly _tag: "connected"; readonly pid?: number; readonly generation: number }
  | { readonly _tag: "reconnecting"; readonly attempt: number; readonly generation: number }
  | { readonly _tag: "disconnected"; readonly reason: string }

export interface GentLifecycle {
  readonly getState: () => ConnectionState
  readonly subscribe: (listener: (state: ConnectionState) => void) => () => void
  readonly restart: Effect.Effect<void, GentConnectionError>
  readonly waitForReady: Effect.Effect<void>
}
