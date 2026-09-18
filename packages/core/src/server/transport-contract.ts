import { Schema } from "effect"
import type { Effect } from "effect"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  ModelId,
  ReasoningEffort,
  RunSpecSchema,
} from "../domain/agent.js"
import {
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo,
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
import { Branch, BranchTreeNode, ProjectedMessage, Session } from "../domain/message.js"
import { QueueSnapshot } from "../domain/queue.js"
import {
  SessionRuntimeMetrics,
  SessionRuntimeStateSchema,
} from "../runtime/agent/agent-loop.state.js"

export { Branch, BranchTreeNode, Session }
export type { SessionRuntimeState } from "../runtime/agent/agent-loop.state.js"

export const CreateSessionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  /** If provided, sends this message immediately after creation */
  initialPrompt: Schema.optional(Schema.String),
  requestId: Schema.optional(RequestId),
})
export type CreateSessionInput = typeof CreateSessionInput.Type

export const CreateBranchInput = Schema.Struct({
  sessionId: SessionId,
  name: Schema.optional(Schema.String),
  requestId: Schema.optional(RequestId),
})
export type CreateBranchInput = typeof CreateBranchInput.Type

export const SwitchBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  toBranchId: BranchId,
  requestId: Schema.optional(RequestId),
})
export type SwitchBranchInput = typeof SwitchBranchInput.Type

export const ForkBranchInput = Schema.Struct({
  sessionId: SessionId,
  fromBranchId: BranchId,
  atMessageId: MessageId,
  name: Schema.optional(Schema.String),
  requestId: Schema.optional(RequestId),
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
  requestId: Schema.optional(RequestId),
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
  lastEventId: Schema.NullOr(Schema.Finite),
  modelId: Schema.optional(ModelId),
  reasoningLevel: Schema.optional(ReasoningEffort),
  /** What the next turn would use once session settings, config, and the
   * agent definition are folded together. Clients render these; they never
   * re-derive the precedence. */
  resolvedModelId: ModelId,
  resolvedReasoningLevel: Schema.optional(ReasoningEffort),
  /** Current runtime state (`_tag` + agent/queue). Idle sessions return Idle runtime. */
  runtime: Schema.suspend(() => SessionRuntimeStateSchema),
  /** Cumulative usage derived from the event log (turns, tokens, cost, last
   * model). The server is the authority — clients that hydrate from here do
   * not maintain their own cost/model bookkeeping. */
  metrics: SessionRuntimeMetrics,
}) {}

export { SteerCommand } from "../domain/agent.js"

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
  after: Schema.optional(Schema.Finite),
})
export type SubscribeEventsInput = typeof SubscribeEventsInput.Type

/** One response shape for every kind of interaction a turn can present. */
export const RespondInteractionInput = Schema.Struct({
  requestId: InteractionRequestId,
  sessionId: SessionId,
  branchId: BranchId,
  approved: Schema.Boolean,
  notes: Schema.optional(Schema.String),
  editedContent: Schema.optional(Schema.String),
})
export type RespondInteractionInput = typeof RespondInteractionInput.Type

/** The session's mutable settings, sent whole: an undefined field clears it. */
export const SessionSettings = Schema.Struct({
  modelId: Schema.UndefinedOr(ModelId),
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
})
export type SessionSettings = typeof SessionSettings.Type

export const UpdateSessionSettingsInput = Schema.Struct({
  sessionId: SessionId,
  ...SessionSettings.fields,
})
export type UpdateSessionSettingsInput = typeof UpdateSessionSettingsInput.Type

export const SetAuthKeyInput = Schema.Struct({
  provider: Schema.String,
  key: Schema.String,
})
export type SetAuthKeyInput = typeof SetAuthKeyInput.Type

export const DeleteAuthKeyInput = Schema.Struct({
  provider: Schema.String,
})
export type DeleteAuthKeyInput = typeof DeleteAuthKeyInput.Type

export const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthInput = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  method: Schema.Finite,
})
export type AuthorizeAuthInput = typeof AuthorizeAuthInput.Type

export const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

export const CallbackAuthInput = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  method: Schema.Finite,
  authorizationId: Schema.String,
  code: Schema.optional(Schema.String),
})
export type CallbackAuthInput = typeof CallbackAuthInput.Type

export { AuthProviderInfo, ListAuthProvidersPayload }
export { EventEnvelope }
export { QueueSnapshot }

/** Input shape for public extension RPC dispatch.
 *  `extensionId` + `capabilityId` route to the registered request;
 *
 *  `branchId` is required because extension RPCs execute against the
 *  live session runtime, not a transport-local stub. Callers must pass the
 *  active branch so the runtime can construct the full extension host context.
 */
export const ExtensionRpcRequestInput = Schema.Struct({
  sessionId: SessionId,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: Schema.Unknown,
  branchId: BranchId,
})
export type ExtensionRpcRequestInput = typeof ExtensionRpcRequestInput.Type

export class SlashCommandInfo extends Schema.Class<SlashCommandInfo>("SlashCommandInfo")({
  /** Routing key (capability id). */
  name: Schema.String,
  /** Author-supplied display name for the slash menu. Falls back to
   *  `name` when absent. */
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Author-supplied slash-menu category. */
  category: Schema.optional(Schema.String),
  /** Author-supplied keybind hint (display-only). */
  keybind: Schema.optional(Schema.String),
  extensionId: ExtensionId,
  capabilityId: Schema.String,
}) {}

const ExtensionActivationPhase = Schema.Literals(["setup", "validation", "startup"])

const ExtensionManifestInfo = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.String),
})

export const ExtensionHealthIssue = Schema.Union([
  Schema.TaggedStruct("ActivationFailed", {
    phase: ExtensionActivationPhase,
    error: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ExtensionHealthIssue = Schema.Schema.Type<typeof ExtensionHealthIssue>

const ExtensionHealthIdentityFields = {
  manifest: ExtensionManifestInfo,
  scope: Schema.Literals(["builtin", "user", "project"]),
  sourcePath: Schema.String,
}

export const ExtensionHealth = Schema.Union([
  Schema.TaggedStruct("Healthy", {
    ...ExtensionHealthIdentityFields,
  }),
  Schema.TaggedStruct("Degraded", {
    ...ExtensionHealthIdentityFields,
    issues: Schema.NonEmptyArray(ExtensionHealthIssue),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ExtensionHealth = Schema.Schema.Type<typeof ExtensionHealth>

export const ExtensionHealthSnapshot = Schema.Union([
  Schema.TaggedStruct("Healthy", {
    extensions: Schema.Array(ExtensionHealth.cases.Healthy),
  }),
  Schema.TaggedStruct("Degraded", {
    healthyExtensions: Schema.Array(ExtensionHealth.cases.Healthy),
    degradedExtensions: Schema.NonEmptyArray(ExtensionHealth.cases.Degraded),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ExtensionHealthSnapshot = Schema.Schema.Type<typeof ExtensionHealthSnapshot>

// ---------------------------------------------------------------------------
// Driver routing
// ---------------------------------------------------------------------------

/** Per-driver descriptor returned by `driver.list`. The `_tag` matches `DriverRef`. */
export const DriverInfo = Schema.Union([
  Schema.TaggedStruct("Model", {
    id: Schema.String,
  }),
  Schema.TaggedStruct("External", {
    id: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type DriverInfo = Schema.Schema.Type<typeof DriverInfo>

/** Snapshot returned by `driver.list`. Carries every registered driver
 *  and the active per-agent override map. The TUI joins these against
 *  the agent catalogue to render `/driver`. */
export class DriverListResult extends Schema.Class<DriverListResult>("DriverListResult")({
  drivers: Schema.Array(DriverInfo),
  overrides: Schema.Record(AgentName, DriverRef),
  agents: Schema.Array(AgentDefinition),
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

export class GentConnectionError extends Schema.TaggedError<GentConnectionError>()(
  "@gent/core/GentConnectionError",
  { message: Schema.String },
) {}

export const ConnectionState = Schema.Union([
  Schema.TaggedStruct("Connecting", {}),
  Schema.TaggedStruct("Connected", {
    pid: Schema.optional(Schema.Finite),
    generation: Schema.Finite,
  }),
  Schema.TaggedStruct("Reconnecting", {
    attempt: Schema.Finite,
    generation: Schema.Finite,
  }),
  Schema.TaggedStruct("Disconnected", {
    reason: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ConnectionState = Schema.Schema.Type<typeof ConnectionState>

export interface GentLifecycle {
  readonly getState: () => ConnectionState
  readonly subscribe: (listener: (state: ConnectionState) => void) => () => void
  readonly restart: Effect.Effect<void, GentConnectionError>
  readonly waitForReady: Effect.Effect<void>
}
