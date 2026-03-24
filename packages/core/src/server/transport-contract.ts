import { Schema } from "effect"
import type { Effect, Fiber, Stream } from "effect"
import { AgentName, ReasoningEffort } from "../domain/agent.js"
import type { ReasoningEffort as ReasoningEffortType } from "../domain/agent.js"
import { AuthAuthorization, AuthMethod } from "../domain/auth-method.js"
import type {
  AuthAuthorization as AuthAuthorizationType,
  AuthMethod as AuthMethodType,
} from "../domain/auth-method.js"
import { AuthProviderInfo } from "../domain/auth-guard.js"
import type { AuthProviderInfo as AuthProviderInfoType } from "../domain/auth-guard.js"
import { EventEnvelope, HandoffDecision, PromptDecision } from "../domain/event.js"
import type {
  HandoffDecision as HandoffDecisionType,
  PromptDecision as PromptDecisionType,
} from "../domain/event.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { MessagePart } from "../domain/message.js"
import { PermissionDecision } from "../domain/permission.js"
import type {
  PermissionDecision as PermissionDecisionType,
  PermissionRule,
} from "../domain/permission.js"
import { QueueSnapshot } from "../domain/queue.js"
import type { QueueEntryInfo } from "../domain/queue.js"
import { SkillScope } from "../domain/skills.js"
import type { Task } from "../domain/task.js"
import type { Model } from "../domain/model.js"
import type { GentRpcError } from "./errors.js"

export const CreateSessionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  firstMessage: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
})
export type CreateSessionInput = typeof CreateSessionInput.Type
export const CreateSessionPayload = CreateSessionInput

export const CreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  bypass: Schema.Boolean,
})
export type CreateSessionResult = typeof CreateSessionResult.Type
export const CreateSessionSuccess = CreateSessionResult

export const SessionInfo = Schema.Struct({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  bypass: Schema.optional(Schema.Boolean),
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
  bypass?: boolean
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
  bypass?: boolean
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
    bypass: Schema.optional(Schema.Boolean),
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
export const GetChildSessionsPayload = GetChildSessionsInput

export const GetSessionTreeInput = Schema.Struct({
  sessionId: SessionId,
})
export type GetSessionTreeInput = typeof GetSessionTreeInput.Type
export const GetSessionTreePayload = GetSessionTreeInput

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
export const ListBranchesPayload = ListBranchesInput

export const CreateBranchInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
})
export type CreateBranchInput = typeof CreateBranchInput.Type
export const CreateBranchPayload = CreateBranchInput

export const CreateBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type CreateBranchResult = typeof CreateBranchResult.Type
export const CreateBranchSuccess = CreateBranchResult
export type CreateBranchOutput = CreateBranchResult

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
export const GetBranchTreePayload = GetBranchTreeInput

export const SwitchBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
  summarize: Schema.optional(Schema.Boolean),
})
export type SwitchBranchInput = typeof SwitchBranchInput.Type
export const SwitchBranchPayload = SwitchBranchInput

export const ForkBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  atMessageId: MessageId,
  name: Schema.optional(Schema.String),
})
export type ForkBranchInput = typeof ForkBranchInput.Type
export const ForkBranchPayload = ForkBranchInput

export const ForkBranchResult = Schema.Struct({
  branchId: BranchId,
})
export type ForkBranchResult = typeof ForkBranchResult.Type
export const ForkBranchSuccess = ForkBranchResult

export const SendMessageInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
})
export type SendMessageInput = typeof SendMessageInput.Type
export const SendMessagePayload = SendMessageInput

export const MessageInfo = Schema.Struct({
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  kind: Schema.optional(Schema.Literals(["regular", "interjection"])),
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
})
export type MessageInfoReadonly = typeof MessageInfo.Type

export const ListMessagesInput = Schema.Struct({
  branchId: BranchId,
})
export type ListMessagesInput = typeof ListMessagesInput.Type
export const ListMessagesPayload = ListMessagesInput

export const GetSessionSnapshotInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type GetSessionSnapshotInput = typeof GetSessionSnapshotInput.Type
export const GetSessionSnapshotPayload = GetSessionSnapshotInput

export const SessionSnapshot = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.optional(Schema.String),
  messages: Schema.Array(MessageInfo),
  lastEventId: Schema.NullOr(Schema.Number),
  bypass: Schema.optional(Schema.Boolean),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
  /** Current runtime state (phase/status/agent/queue). Idle sessions return idle runtime. */
  runtime: Schema.suspend(() => SessionRuntime),
})
export type SessionSnapshot = typeof SessionSnapshot.Type

export const RuntimePhase = Schema.Literals([
  "idle",
  "resolving",
  "streaming",
  "executing-tools",
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
export const SteerPayload = SteerCommand

export const QueueTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type QueueTarget = typeof QueueTarget.Type
export const DrainQueuedMessagesPayload = QueueTarget
export const DrainQueuedMessagesSuccess = QueueSnapshot
export const GetQueuedMessagesPayload = QueueTarget
export const GetQueuedMessagesSuccess = QueueSnapshot
export type QueueEntryInfoReadonly = QueueEntryInfo
export type QueueSnapshotReadonly = QueueSnapshot

export const SubscribeEventsInput = Schema.Struct({
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
  after: Schema.optional(Schema.Number),
})
export type SubscribeEventsInput = typeof SubscribeEventsInput.Type
export const SubscribeEventsPayload = SubscribeEventsInput

export const WatchRuntimeInput = QueueTarget
export type WatchRuntimeInput = typeof WatchRuntimeInput.Type
export const WatchRuntimePayload = WatchRuntimeInput

export const RespondQuestionsInput = Schema.Struct({
  requestId: Schema.String,
  answers: Schema.Array(Schema.Array(Schema.String)),
})
export type RespondQuestionsInput = typeof RespondQuestionsInput.Type
export const RespondQuestionsPayload = RespondQuestionsInput

export const RespondPermissionInput = Schema.Struct({
  requestId: Schema.String,
  decision: PermissionDecision,
  persist: Schema.optional(Schema.Boolean),
})
export type RespondPermissionInput = typeof RespondPermissionInput.Type
export const RespondPermissionPayload = RespondPermissionInput

export const UpdateSessionBypassInput = Schema.Struct({
  sessionId: SessionId,
  bypass: Schema.Boolean,
})
export type UpdateSessionBypassInput = typeof UpdateSessionBypassInput.Type
export const UpdateSessionBypassPayload = UpdateSessionBypassInput

export const UpdateSessionBypassResult = Schema.Struct({
  bypass: Schema.Boolean,
})
export type UpdateSessionBypassResult = typeof UpdateSessionBypassResult.Type
export const UpdateSessionBypassSuccess = UpdateSessionBypassResult

export const UpdateSessionReasoningLevelInput = Schema.Struct({
  sessionId: SessionId,
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelInput = typeof UpdateSessionReasoningLevelInput.Type
export const UpdateSessionReasoningLevelPayload = UpdateSessionReasoningLevelInput

export const UpdateSessionReasoningLevelResult = Schema.Struct({
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelResult = typeof UpdateSessionReasoningLevelResult.Type
export const UpdateSessionReasoningLevelSuccess = UpdateSessionReasoningLevelResult

export const RespondPromptInput = Schema.Struct({
  requestId: Schema.String,
  decision: PromptDecision,
  content: Schema.optional(Schema.String),
})
export type RespondPromptInput = typeof RespondPromptInput.Type
export const RespondPromptPayload = RespondPromptInput

export const RespondHandoffInput = Schema.Struct({
  requestId: Schema.String,
  decision: HandoffDecision,
  reason: Schema.optional(Schema.String),
})
export type RespondHandoffInput = typeof RespondHandoffInput.Type
export const RespondHandoffPayload = RespondHandoffInput

export const RespondHandoffResult = Schema.Struct({
  childSessionId: Schema.optional(SessionId),
  childBranchId: Schema.optional(BranchId),
})
export type RespondHandoffResult = typeof RespondHandoffResult.Type
export const RespondHandoffSuccess = RespondHandoffResult

export const DeletePermissionRuleInput = Schema.Struct({
  tool: Schema.String,
  pattern: Schema.optional(Schema.String),
})
export type DeletePermissionRuleInput = typeof DeletePermissionRuleInput.Type
export const DeletePermissionRulePayload = DeletePermissionRuleInput

export const SetAuthKeyInput = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
})
export type SetAuthKeyInput = typeof SetAuthKeyInput.Type
export const SetAuthKeyPayload = SetAuthKeyInput

export const DeleteAuthKeyInput = Schema.Struct({
  provider: Schema.String,
})
export type DeleteAuthKeyInput = typeof DeleteAuthKeyInput.Type
export const DeleteAuthKeyPayload = DeleteAuthKeyInput

export const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthInput = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
})
export type AuthorizeAuthInput = typeof AuthorizeAuthInput.Type
export const AuthorizeAuthPayload = AuthorizeAuthInput

export const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

export const CallbackAuthInput = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.String,
  method: Schema.Number,
  authorizationId: Schema.String,
  code: Schema.optional(Schema.String),
})
export type CallbackAuthInput = typeof CallbackAuthInput.Type
export const CallbackAuthPayload = CallbackAuthInput

export { AuthProviderInfo }
export { EventEnvelope }

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

export interface GentClient {
  sendMessage: (input: SendMessageInput) => Effect.Effect<void, GentRpcError>

  createSession: (
    input?: Omit<CreateSessionInput, "name">,
  ) => Effect.Effect<CreateSessionResult, GentRpcError>

  listMessages: (branchId: BranchId) => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>

  getSessionSnapshot: (
    input: GetSessionSnapshotInput,
  ) => Effect.Effect<SessionSnapshot, GentRpcError>

  getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, GentRpcError>

  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>

  getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<readonly SessionInfo[], GentRpcError>

  getSessionTree: (sessionId: SessionId) => Effect.Effect<SessionTreeNode, GentRpcError>

  listModels: () => Effect.Effect<readonly Model[], GentRpcError>

  listBranches: (sessionId: SessionId) => Effect.Effect<readonly BranchInfo[], GentRpcError>

  listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, GentRpcError>

  getBranchTree: (sessionId: SessionId) => Effect.Effect<readonly BranchTreeNode[], GentRpcError>

  createBranch: (
    sessionId: SessionId,
    name?: string,
  ) => Effect.Effect<CreateBranchResult["branchId"], GentRpcError>

  switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, GentRpcError>

  forkBranch: (input: ForkBranchInput) => Effect.Effect<ForkBranchResult, GentRpcError>

  streamEvents: (input: SubscribeEventsInput) => Stream.Stream<EventEnvelope, GentRpcError>
  watchRuntime: (input: WatchRuntimeInput) => Stream.Stream<SessionRuntime, GentRpcError>

  invokeTool: (input: {
    sessionId: SessionId
    branchId: BranchId
    toolName: string
    input: unknown
  }) => Effect.Effect<void, GentRpcError>

  steer: (command: SteerCommand) => Effect.Effect<void, GentRpcError>

  drainQueuedMessages: (input: QueueTarget) => Effect.Effect<QueueSnapshotReadonly, GentRpcError>

  getQueuedMessages: (input: QueueTarget) => Effect.Effect<QueueSnapshotReadonly, GentRpcError>

  respondQuestions: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, GentRpcError>

  respondPermission: (
    requestId: string,
    decision: PermissionDecisionType,
    persist?: boolean,
  ) => Effect.Effect<void, GentRpcError>

  respondPrompt: (
    requestId: string,
    decision: PromptDecisionType,
    content?: string,
  ) => Effect.Effect<void, GentRpcError>

  respondHandoff: (
    requestId: string,
    decision: HandoffDecisionType,
    reason?: string,
  ) => Effect.Effect<{ childSessionId?: SessionId; childBranchId?: BranchId }, GentRpcError>

  updateSessionBypass: (
    sessionId: SessionId,
    bypass: boolean,
  ) => Effect.Effect<UpdateSessionBypassResult, GentRpcError>

  updateSessionReasoningLevel: (
    sessionId: SessionId,
    reasoningLevel: ReasoningEffortType | undefined,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, GentRpcError>

  getPermissionRules: () => Effect.Effect<readonly PermissionRule[], GentRpcError>

  deletePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void, GentRpcError>

  listAuthProviders: () => Effect.Effect<readonly AuthProviderInfoType[], GentRpcError>

  setAuthKey: (provider: string, key: string) => Effect.Effect<void, GentRpcError>

  deleteAuthKey: (provider: string) => Effect.Effect<void, GentRpcError>

  listAuthMethods: () => Effect.Effect<Record<string, ReadonlyArray<AuthMethodType>>, GentRpcError>

  authorizeAuth: (
    sessionId: string,
    provider: string,
    method: number,
  ) => Effect.Effect<AuthAuthorizationType | null, GentRpcError>

  callbackAuth: (
    sessionId: string,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, GentRpcError>

  listSkills: () => Effect.Effect<readonly SkillContent[], GentRpcError>

  getSkillContent: (name: string) => Effect.Effect<SkillContent | null, GentRpcError>

  /** Fire-and-forget — run an effect on the client's captured runtime */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly runFork: <A, E>(effect: Effect.Effect<A, E, any>) => Fiber.Fiber<A, E>
  /** Run an effect as a Promise on the client's captured runtime */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>

  /** Connection lifecycle — present on all clients, behavior varies by transport */
  readonly lifecycle: GentLifecycle
}

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
