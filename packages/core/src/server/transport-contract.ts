import { Schema } from "effect"
import type { Effect } from "effect"
import { AgentName, DriverRef, ReasoningEffort, RunSpecSchema } from "../domain/agent.js"
import {
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo,
  AuthProviderQuery,
  ListAuthProvidersPayload,
} from "../domain/auth.js"
import { EventEnvelope } from "../domain/event.js"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
} from "../domain/ids.js"
import {
  Branch,
  BranchTreeNode,
  ProjectedMessage,
  Session,
  SessionTreeNode,
} from "../domain/message.js"
// PermissionDecision removed — permissions are now default-allow with deny rules
import { QueueSnapshot } from "../domain/queue.js"
import { TaggedEnumClass } from "../domain/schema-tagged-enum-class.js"
import { SessionRuntimeMetrics, SessionRuntimeStateSchema } from "../runtime/session-runtime.js"

export { Branch, BranchTreeNode, Session, SessionTreeNode }
export type { SessionRuntimeState } from "../runtime/session-runtime.js"

/**
 * Client-generated request ID for end-to-end correlation and transport-retry
 * dedup. Bounded to 128 chars so a malicious/buggy client cannot bloat the
 * per-server dedup cache with arbitrary-length keys. Callers in this repo
 * use `crypto.randomUUID()` which fits comfortably.
 */
export const RequestIdSchema = RequestId

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

export type SessionTreeNodeType = Schema.Schema.Type<typeof SessionTreeNode>

export const CreateBranchInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
  /** Client-generated request ID for end-to-end correlation + dedup. See RequestIdSchema. */
  requestId: Schema.optional(RequestIdSchema),
})
export type CreateBranchInput = typeof CreateBranchInput.Type

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

export const GetSessionSnapshotInput = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type GetSessionSnapshotInput = typeof GetSessionSnapshotInput.Type

export class SessionSnapshot extends Schema.Class<SessionSnapshot>("SessionSnapshot")({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.optional(Schema.String),
  messages: Schema.Array(ProjectedMessage),
  lastEventId: Schema.NullOr(Schema.Number),
  reasoningLevel: Schema.optional(ReasoningEffort),
  activeBranchId: Schema.optional(BranchId),
  /** Current runtime state (`_tag` + agent/queue). Idle sessions return Idle runtime. */
  runtime: Schema.suspend(() => SessionRuntimeStateSchema),
  /** Cumulative usage derived from the event log (turns, tokens, cost, last
   * model). The server is the authority — clients that hydrate from here do
   * not maintain their own cost/model bookkeeping. */
  metrics: SessionRuntimeMetrics,
}) {}

export { SteerCommand } from "../domain/steer.js"

export const QueueTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type QueueTarget = typeof QueueTarget.Type

export const QueueDrainInput = Schema.Struct({
  ...QueueTarget.fields,
  requestId: RequestId,
})
export type QueueDrainInput = typeof QueueDrainInput.Type

export const SubscribeEventsInput = Schema.Struct({
  sessionId: SessionId,
  branchId: Schema.optional(BranchId),
  after: Schema.optional(Schema.Number),
})
export type SubscribeEventsInput = typeof SubscribeEventsInput.Type

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

/** Input shape for public extension RPC dispatch.
 *  `extensionId` + `capabilityId` route to the registered request;
 *  `intent` is forwarded to the registry, which enforces the read/write fence.
 *
 *  `branchId` is required because extension RPCs execute against the
 *  live session runtime, not a transport-local stub. Callers must pass the
 *  active branch so the runtime can construct the full extension host context.
 */
export const ExtensionRpcRequestInput = Schema.Struct({
  sessionId: SessionId,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  intent: Schema.Literals(["read", "write"]),
  input: Schema.Unknown,
  branchId: BranchId,
})
export type ExtensionRpcRequestInput = typeof ExtensionRpcRequestInput.Type

export class SlashCommandInfo extends Schema.Class<SlashCommandInfo>("SlashCommandInfo")({
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
  extensionId: ExtensionId,
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

export const ExtensionHealth = TaggedEnumClass("ExtensionHealth", {
  Healthy: TaggedEnumClass.variant("healthy", {
    ...ExtensionHealthIdentityFields,
  }),
  Degraded: TaggedEnumClass.variant("degraded", {
    ...ExtensionHealthIdentityFields,
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

export const ConnectionState = TaggedEnumClass("ConnectionState", {
  Connecting: TaggedEnumClass.variant("connecting", {}),
  Connected: TaggedEnumClass.variant("connected", {
    pid: Schema.optional(Schema.Number),
    generation: Schema.Number,
  }),
  Reconnecting: TaggedEnumClass.variant("reconnecting", {
    attempt: Schema.Number,
    generation: Schema.Number,
  }),
  Disconnected: TaggedEnumClass.variant("disconnected", {
    reason: Schema.String,
  }),
})
export type ConnectionState = Schema.Schema.Type<typeof ConnectionState>

export interface GentLifecycle {
  readonly getState: () => ConnectionState
  readonly subscribe: (listener: (state: ConnectionState) => void) => () => void
  readonly restart: Effect.Effect<void, GentConnectionError>
  readonly waitForReady: Effect.Effect<void>
}
