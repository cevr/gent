import { Schema } from "effect"
import type { Effect } from "effect"
import { AgentName, DriverRef, ReasoningEffort, RunSpecSchema } from "../domain/agent.js"
import { AuthAuthorization, AuthMethod } from "../domain/auth-method.js"
import {
  AuthProviderInfo,
  AuthProviderQuery,
  ListAuthProvidersPayload,
} from "../domain/auth-guard.js"
import { EventEnvelope } from "../domain/event.js"
import { ExtensionMessageEnvelope } from "../domain/extension-protocol.js"
import { ExtensionActorFailurePhase, ExtensionActorStatusInfo } from "../domain/extension.js"
import { BranchId, InteractionRequestId, MessageId, SessionId } from "../domain/ids.js"
import { MessageMetadata, MessagePart } from "../domain/message.js"
// PermissionDecision removed — permissions are now default-allow with deny rules
import { QueueSnapshot } from "../domain/queue.js"
import { TaggedEnumClass } from "../domain/schema-tagged-enum-class.js"
import { SessionRuntimeMetrics, SessionRuntimeStateSchema } from "../runtime/session-runtime.js"

// Re-export shared domain shapes — the transport contract is the same
// identity as the domain-owned state, not a parallel copy.
export { ExtensionActorFailurePhase, ExtensionActorStatusInfo }

/**
 * Client-generated request ID for end-to-end correlation and transport-retry
 * dedup. Bounded to 128 chars so a malicious/buggy client cannot bloat the
 * per-server dedup cache with arbitrary-length keys. Callers in this repo
 * use `crypto.randomUUID()` which fits comfortably.
 */
export const RequestIdSchema = Schema.String.check(Schema.isMaxLength(128))

export const CreateSessionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  /** If provided, sends this message immediately after creation */
  initialPrompt: Schema.optional(Schema.String),
  /** Agent override for the initial prompt (turn-scoped, not persistent) */
  agentOverride: Schema.optional(AgentName),
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
})
export type CreateSessionInput = typeof CreateSessionInput.Type

export const CreateSessionResult = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
})
export type CreateSessionResult = typeof CreateSessionResult.Type

export class SessionInfo extends Schema.Class<SessionInfo>("SessionInfo")({
  id: SessionId,
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  reasoningLevel: Schema.optional(ReasoningEffort),
  branchId: Schema.optional(BranchId),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
}) {}

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

export class BranchInfo extends Schema.Class<BranchInfo>("BranchInfo")({
  id: BranchId,
  sessionId: SessionId,
  parentBranchId: Schema.optional(BranchId),
  parentMessageId: Schema.optional(MessageId),
  name: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  createdAt: Schema.Number,
}) {}

export const ListBranchesInput = Schema.Struct({
  sessionId: SessionId,
})
export type ListBranchesInput = typeof ListBranchesInput.Type

export const CreateBranchInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
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
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
})
export type SwitchBranchInput = typeof SwitchBranchInput.Type

export const ForkBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  atMessageId: MessageId,
  name: Schema.optional(Schema.String),
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
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
  agentOverride: Schema.optional(AgentName),
  /** Per-run dispatch config — forwarded to the agent loop for this turn only. */
  runSpec: Schema.optional(RunSpecSchema),
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
})
export type SendMessageInput = typeof SendMessageInput.Type

const MessageInfoFields = {
  id: MessageId,
  sessionId: SessionId,
  branchId: BranchId,
  role: Schema.Literals(["user", "assistant", "system", "tool"]),
  parts: Schema.Array(MessagePart),
  createdAt: Schema.Number,
  turnDurationMs: Schema.optional(Schema.Number),
  metadata: Schema.optional(MessageMetadata),
}

export const MessageInfo = TaggedEnumClass("MessageInfo", {
  Regular: TaggedEnumClass.variant("regular", MessageInfoFields),
  Interjection: TaggedEnumClass.variant("interjection", {
    ...MessageInfoFields,
    role: Schema.Literal("user"),
  }),
})
export type MessageInfo = typeof MessageInfo.Type
export type MessageInfoReadonly = MessageInfo

export const ListMessagesInput = Schema.Struct({
  branchId: BranchId,
})
export type ListMessagesInput = typeof ListMessagesInput.Type

export const GetSessionSnapshotInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type GetSessionSnapshotInput = typeof GetSessionSnapshotInput.Type

export class SessionSnapshot extends Schema.Class<SessionSnapshot>("SessionSnapshot")({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.optional(Schema.String),
  messages: Schema.Array(MessageInfo),
  lastEventId: Schema.NullOr(Schema.Number),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
  /** Current runtime state (`_tag` + agent/queue). Idle sessions return Idle runtime. */
  runtime: Schema.suspend(() => SessionRuntime),
  /** Cumulative usage derived from the event log (turns, tokens, cost, last
   * model). The server is the authority — clients that hydrate from here do
   * not maintain their own cost/model bookkeeping. */
  metrics: SessionRuntimeMetrics,
}) {}

export const SessionRuntime = SessionRuntimeStateSchema
export type SessionRuntime = typeof SessionRuntime.Type

export { SteerCommand } from "../domain/steer.js"

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

/** Generic interaction response — replaces RespondPromptInput/RespondHandoffInput/RespondQuestionsInput */
export const RespondInteractionInput = Schema.Struct({
  requestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
  approved: Schema.Boolean,
  notes: Schema.optional(Schema.String),
})
export type RespondInteractionInput = typeof RespondInteractionInput.Type

export const UpdateSessionReasoningLevelInput = Schema.Struct({
  sessionId: SessionId,
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelInput = typeof UpdateSessionReasoningLevelInput.Type

export const UpdateSessionReasoningLevelResult = Schema.Struct({
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type UpdateSessionReasoningLevelResult = typeof UpdateSessionReasoningLevelResult.Type

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

// Public RPC payload — server re-derives `driverOverrides` from
// session-cwd config, so callers cannot smuggle in an override
// that bypasses model auth.
export const ListAuthProvidersInput = ListAuthProvidersPayload
export type ListAuthProvidersInput = typeof ListAuthProvidersInput.Type

export const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthInput = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  method: Schema.Number,
})
export type AuthorizeAuthInput = typeof AuthorizeAuthInput.Type

export const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

export const CallbackAuthInput = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  method: Schema.Number,
  authorizationId: Schema.String,
  code: Schema.optional(Schema.String),
})
export type CallbackAuthInput = typeof CallbackAuthInput.Type

export { AuthProviderInfo, AuthProviderQuery, ListAuthProvidersPayload }
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

/** Input shape for transport capability RPCs.
 *  `extensionId` + `capabilityId` route to the registered capability;
 *  `intent` preserves the read/write fence at the transport boundary.
 *
 *  `branchId` is required because capability requests execute against the
 *  live session runtime, not a transport-local stub. Callers must pass the
 *  active branch so the runtime can construct a complete
 *  `CapabilityCoreContext` for the handler.
 */
export const RequestCapabilityInput = Schema.Struct({
  sessionId: SessionId,
  extensionId: Schema.String,
  capabilityId: Schema.String,
  intent: Schema.Literals(["read", "write"]),
  input: Schema.Unknown,
  branchId: BranchId,
})
export type RequestCapabilityInput = typeof RequestCapabilityInput.Type

export const ListExtensionStatusInput = Schema.Struct({
  sessionId: Schema.optional(SessionId),
})
export type ListExtensionStatusInput = typeof ListExtensionStatusInput.Type

export const ListExtensionCommandsInput = Schema.Struct({
  sessionId: SessionId,
})
export type ListExtensionCommandsInput = typeof ListExtensionCommandsInput.Type

export class CommandInfo extends Schema.Class<CommandInfo>("CommandInfo")({
  /** Routing key (capability id). */
  name: Schema.String,
  /** Author-supplied display name (slash menu / palette). Falls back to
   *  `name` when absent. */
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Author-supplied palette category. */
  category: Schema.optional(Schema.String),
  /** Author-supplied keybind hint (display-only). */
  keybind: Schema.optional(Schema.String),
  extensionId: Schema.String,
  capabilityId: Schema.String,
  intent: Schema.Literals(["read", "write"]),
}) {}

export const ExtensionActivationPhase = Schema.Literals(["setup", "validation", "startup"])
export type ExtensionActivationPhase = typeof ExtensionActivationPhase.Type

export const ExtensionManifestInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
})
export type ExtensionManifestInfo = typeof ExtensionManifestInfo.Type

export const ScheduledJobFailureInfo = Schema.Struct({
  jobId: Schema.String,
  error: Schema.String,
})
export type ScheduledJobFailureInfo = typeof ScheduledJobFailureInfo.Type

export const ExtensionHealthIssue = TaggedEnumClass("ExtensionHealthIssue", {
  ActivationFailed: TaggedEnumClass.variant("activation-failed", {
    phase: ExtensionActivationPhase,
    error: Schema.String,
  }),
  ActorFailed: TaggedEnumClass.variant("actor-failed", {
    sessionId: SessionId,
    branchId: Schema.optional(BranchId),
    error: Schema.String,
    failurePhase: ExtensionActorFailurePhase,
    restartCount: Schema.optional(Schema.Number),
  }),
  ScheduledJobFailed: TaggedEnumClass.variant("scheduled-job-failed", {
    jobId: Schema.String,
    error: Schema.String,
  }),
})
export type ExtensionHealthIssue = typeof ExtensionHealthIssue.Type

const ExtensionHealthIdentityFields = {
  manifest: ExtensionManifestInfo,
  scope: Schema.Literals(["builtin", "user", "project"]),
  sourcePath: Schema.String,
}

const HealthyExtensionActorStatusInfo = Schema.Union([
  ExtensionActorStatusInfo.Starting,
  ExtensionActorStatusInfo.Running,
  ExtensionActorStatusInfo.Restarting,
])

export const ExtensionHealth = TaggedEnumClass("ExtensionHealth", {
  Healthy: TaggedEnumClass.variant("healthy", {
    ...ExtensionHealthIdentityFields,
    actor: Schema.optional(HealthyExtensionActorStatusInfo),
  }),
  Degraded: TaggedEnumClass.variant("degraded", {
    ...ExtensionHealthIdentityFields,
    actor: Schema.optional(HealthyExtensionActorStatusInfo),
    issues: Schema.NonEmptyArray(ExtensionHealthIssue),
  }),
})
export type ExtensionHealth = typeof ExtensionHealth.Type

export const ExtensionHealthSnapshot = TaggedEnumClass("ExtensionHealthSnapshot", {
  Healthy: TaggedEnumClass.variant("healthy", {
    extensions: Schema.Array(ExtensionHealth.Healthy),
  }),
  Degraded: TaggedEnumClass.variant("degraded", {
    healthyExtensions: Schema.Array(ExtensionHealth.Healthy),
    degradedExtensions: Schema.NonEmptyArray(ExtensionHealth.Degraded),
  }),
})
export type ExtensionHealthSnapshot = typeof ExtensionHealthSnapshot.Type

// ---------------------------------------------------------------------------
// Driver routing
// ---------------------------------------------------------------------------

/** Per-driver descriptor returned by `driver.list`. The `_tag` matches `DriverRef`. */
export const DriverInfo = TaggedEnumClass("DriverInfo", {
  Model: TaggedEnumClass.variant("model", {
    id: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  External: TaggedEnumClass.variant("external", {
    id: Schema.String,
    description: Schema.optional(Schema.String),
  }),
})
export type DriverInfo = typeof DriverInfo.Type

/** Snapshot returned by `driver.list`. Carries every registered driver
 *  and the active per-agent override map. The TUI joins these against
 *  the agent catalogue to render `/driver`. */
export class DriverListResult extends Schema.Class<DriverListResult>("DriverListResult")({
  drivers: Schema.Array(DriverInfo),
  overrides: Schema.Record(AgentName, DriverRef),
}) {}

export const SetDriverOverrideInput = Schema.Struct({
  agentName: AgentName,
  driver: DriverRef,
})
export type SetDriverOverrideInput = typeof SetDriverOverrideInput.Type

export const ClearDriverOverrideInput = Schema.Struct({
  agentName: AgentName,
})
export type ClearDriverOverrideInput = typeof ClearDriverOverrideInput.Type

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
