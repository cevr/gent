import { type Effect, Schema } from "effect"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  Model,
  ModelId,
  ReasoningEffort,
  RunSpecSchema,
  SessionDepthLimitError,
} from "../domain/agent.js"
import { InvalidStateError, NotFoundError, ProviderError } from "../domain/errors.js"
import { StorageError } from "../storage/storage.js"
import { EventEnvelope, EventStoreError } from "../domain/event.js"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
} from "../domain/ids.js"
import { InteractionRequestMismatchError } from "../domain/interaction.js"
import { DriverError, ProviderAuthError } from "../domain/driver.js"
import { ConfigLoadError } from "../runtime/config.js"
import { SessionRuntimeError } from "../runtime/session.js"
import {
  AuthAuthorization,
  AuthMethod,
  AuthProviderInfo,
  ListAuthProvidersPayload,
} from "../runtime/provider.js"
import {
  Branch,
  BranchTreeNode,
  Message,
  ProjectedMessage,
  QueueSnapshot,
  Session,
  SteerCommand,
} from "../domain/message.js"
import { SessionRuntimeMetrics, SessionRuntimeStateSchema } from "../domain/agent-loop.js"
import {
  Rpc,
  type RpcClient,
  type RpcClientError,
  RpcGroup,
  type RpcGroup as RpcGroupNs,
} from "effect/unstable/rpc"
import { WorkspaceRpcMiddleware } from "./workspace-rpc.js"

// ── errors ──────────────────────────────────────────────────────────────────

export { InvalidStateError, NotFoundError } from "../domain/errors.js"

export class ExtensionProtocolError extends Schema.TaggedError<ExtensionProtocolError>()(
  "ExtensionProtocolError",
  {
    extensionId: ExtensionId,
    tag: Schema.String,
    message: Schema.String,
  },
) {}

export const GentRpcError = Schema.Union([
  ConfigLoadError,
  StorageError,
  SessionRuntimeError,
  ProviderError,
  ProviderAuthError,
  DriverError,
  ExtensionProtocolError,
  EventStoreError,
  InteractionRequestMismatchError,
  NotFoundError,
  InvalidStateError,
  SessionDepthLimitError,
]).pipe(Schema.toTaggedUnion("_tag"))

export type GentRpcError = typeof GentRpcError.Type

// ── transport-contract ──────────────────────────────────────────────────────

export { Branch, BranchTreeNode, Session }

export const CreateSessionInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(SessionId),
  parentBranchId: Schema.optional(BranchId),
  /**
   * Join the parent's thread instead of starting one. A handoff continues the
   * parent's work, so it stays in the parent's thread; a spawned child leaves
   * this unset and starts its own. Requires `parentSessionId`.
   */
  continueThread: Schema.optional(Schema.Boolean),
  /** Copy this branch's visible messages into the new session before its first turn. */
  historyBranchId: Schema.optional(BranchId),
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

export { SteerCommand }

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

const ListAuthMethodsSuccess = Schema.Record(Schema.String, Schema.Array(AuthMethod))

export const AuthorizeAuthInput = Schema.Struct({
  sessionId: SessionId,
  provider: Schema.String,
  method: Schema.Finite,
})
export type AuthorizeAuthInput = typeof AuthorizeAuthInput.Type

const AuthorizeAuthSuccess = Schema.NullOr(AuthAuthorization)

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

const ExtensionActivationPhase = Schema.Literals(["load", "setup", "validation", "startup"])

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
export const DriverInfo = Schema.TaggedStruct("Model", {
  id: Schema.String,
})
export type DriverInfo = typeof DriverInfo.Type

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
  /** Validate the driver against this session's profile; the launch profile without one. */
  sessionId: Schema.optional(SessionId),
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

// ── rpcs/session ────────────────────────────────────────────────────────────

export class SessionRpcs extends RpcGroup.make(
  Rpc.make("session.create", {
    payload: CreateSessionInput.fields,
    success: Schema.Struct({
      sessionId: SessionId,
      branchId: BranchId,
      name: Schema.String,
    }),
    error: GentRpcError,
  }),
  Rpc.make("session.list", {
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.thread", {
    payload: { sessionId: SessionId },
    success: Schema.Array(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.get", {
    payload: { sessionId: SessionId },
    success: Schema.NullOr(Session),
    error: GentRpcError,
  }),
  Rpc.make("session.delete", {
    payload: { sessionId: SessionId },
    error: GentRpcError,
  }),
  Rpc.make("session.getSnapshot", {
    payload: GetSessionSnapshotInput.fields,
    success: SessionSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("session.updateSettings", {
    payload: UpdateSessionSettingsInput.fields,
    success: SessionSettings,
    error: GentRpcError,
  }),
  Rpc.make("session.events", {
    payload: SubscribeEventsInput.fields,
    success: EventEnvelope,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("session.watchRuntime", {
    payload: { sessionId: SessionId, branchId: BranchId },
    success: SessionRuntimeStateSchema,
    stream: true,
    error: GentRpcError,
  }),
  Rpc.make("branch.list", {
    payload: { sessionId: SessionId },
    success: Schema.Array(Branch),
    error: GentRpcError,
  }),
  Rpc.make("branch.create", {
    payload: CreateBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
  Rpc.make("branch.getTree", {
    payload: { sessionId: SessionId },
    success: Schema.Array(BranchTreeNode),
    error: GentRpcError,
  }),
  Rpc.make("branch.switch", {
    payload: SwitchBranchInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("branch.fork", {
    payload: ForkBranchInput.fields,
    success: Schema.Struct({ branchId: BranchId }),
    error: GentRpcError,
  }),
  Rpc.make("message.send", {
    payload: SendMessageInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("message.list", {
    payload: { branchId: BranchId },
    success: Schema.Array(Message),
    error: GentRpcError,
  }),
  Rpc.make("steer.command", {
    payload: { command: SteerCommand },
    error: GentRpcError,
  }),
  Rpc.make("queue.drain", {
    payload: QueueDrainInput.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("queue.get", {
    payload: QueueTarget.fields,
    success: QueueSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("interaction.respondInteraction", {
    payload: RespondInteractionInput.fields,
    error: GentRpcError,
  }),
) {}

// ── rpcs/index ──────────────────────────────────────────────────────────────

// ============================================================================
// Runtime status
// ============================================================================

const RuntimeStatusResult = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  uptime: Schema.Finite,
  connectionCount: Schema.Finite,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})
type RuntimeStatusResult = typeof RuntimeStatusResult.Type

class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("runtime.status", {
    success: RuntimeStatusResult,
    error: GentRpcError,
  }),
) {}

// ============================================================================
// Auth
// ============================================================================

class AuthRpcs extends RpcGroup.make(
  Rpc.make("listProviders", {
    payload: ListAuthProvidersPayload.fields,
    success: Schema.Array(AuthProviderInfo),
    error: GentRpcError,
  }),
  Rpc.make("setKey", {
    payload: SetAuthKeyInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("deleteKey", {
    payload: DeleteAuthKeyInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("listMethods", {
    success: ListAuthMethodsSuccess,
    error: GentRpcError,
  }),
  Rpc.make("authorize", {
    payload: AuthorizeAuthInput.fields,
    success: AuthorizeAuthSuccess,
    error: GentRpcError,
  }),
  Rpc.make("callback", {
    payload: CallbackAuthInput.fields,
    error: GentRpcError,
  }),
).prefix("auth.") {}

// ============================================================================
// Extension + driver + model
// ============================================================================

class ExtensionRpcs extends RpcGroup.make(
  Rpc.make("extension.request", {
    payload: ExtensionRpcRequestInput.fields,
    success: Schema.Unknown,
    error: GentRpcError,
  }),
  Rpc.make("extension.listStatus", {
    payload: { sessionId: Schema.optional(SessionId) },
    success: ExtensionHealthSnapshot,
    error: GentRpcError,
  }),
  Rpc.make("extension.listSlashCommands", {
    payload: { sessionId: SessionId },
    success: Schema.Array(SlashCommandInfo),
    error: GentRpcError,
  }),
  Rpc.make("driver.list", {
    payload: { sessionId: Schema.optional(SessionId) },
    success: DriverListResult,
    error: GentRpcError,
  }),
  Rpc.make("driver.set", {
    payload: SetDriverOverrideInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("driver.clear", {
    payload: ClearDriverOverrideInput.fields,
    error: GentRpcError,
  }),
  Rpc.make("model.list", {
    payload: { sessionId: Schema.optional(SessionId) },
    success: Schema.Array(Model),
    error: GentRpcError,
  }),
) {}

// ============================================================================
// Merged RPC Group
// ============================================================================

export class GentRpcs extends RpcGroup.make()
  .merge(SessionRpcs, ExtensionRpcs, AuthRpcs, RuntimeRpcs)
  .middleware(WorkspaceRpcMiddleware) {}

// ============================================================================
// RPC Client Types
// ============================================================================

export type GentRpcClient = RpcClient.RpcClient<
  RpcGroupNs.Rpcs<typeof GentRpcs>,
  RpcClientError.RpcClientError | GentConnectionError
>

export type GentClientRpcError =
  | Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>
  | RpcClientError.RpcClientError
  | GentConnectionError
