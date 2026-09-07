import { Schema } from "effect"
import {
  Rpc,
  RpcGroup,
  type RpcClient,
  type RpcClientError,
  type RpcGroup as RpcGroupNs,
} from "effect/unstable/rpc"
import { SessionId } from "../domain/ids.js"
import { Model } from "../domain/model.js"
import { PermissionRule } from "../domain/permission.js"
import {
  ResourceGraphDesiredReceipt,
  ResourceGraphSnapshot,
} from "../domain/resource-graph-state.js"
import { GentRpcError } from "./errors.js"
import { SessionRpcs } from "./rpcs/session.js"
import {
  AuthProviderInfo,
  AuthorizeAuthInput,
  AuthorizeAuthSuccess,
  CallbackAuthInput,
  ClearDriverOverrideInput,
  DeleteAuthKeyInput,
  DeletePermissionRuleInput,
  DriverListResult,
  ExtensionHealthSnapshot,
  ExtensionRpcRequestInput,
  ResourceGraphGetInput,
  ResourceGraphPreviewInput,
  ResourceGraphStatusResult,
  ResourceGraphSubmitInput,
  type GentConnectionError,
  ListAuthMethodsSuccess,
  ListAuthProvidersInput,
  SetAuthKeyInput,
  SetDriverOverrideInput,
  SlashCommandInfo,
} from "./transport-contract.js"
import { WorkspaceHeaderError, WorkspaceRpcMiddleware } from "./workspace-rpc.js"

// ============================================================================
// Runtime status
// ============================================================================

export const RuntimeStatusResult = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  uptime: Schema.Finite,
  connectionCount: Schema.Finite,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})
export type RuntimeStatusResult = typeof RuntimeStatusResult.Type

export class RuntimeRpcs extends RpcGroup.make(
  Rpc.make("runtime.status", {
    success: RuntimeStatusResult,
    error: GentRpcError,
  }),
) {}

// ============================================================================
// Auth
// ============================================================================

export class AuthRpcs extends RpcGroup.make(
  Rpc.make("listProviders", {
    payload: ListAuthProvidersInput.fields,
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
// Extension + driver + model + permission
// ============================================================================

export class ExtensionRpcs extends RpcGroup.make(
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
    success: Schema.Array(Model),
    error: GentRpcError,
  }),
  Rpc.make("permission.listRules", {
    success: Schema.Array(PermissionRule),
    error: GentRpcError,
  }),
  Rpc.make("permission.deleteRule", {
    payload: DeletePermissionRuleInput.fields,
    error: GentRpcError,
  }),
) {}

// ============================================================================
// Durable resource graph
// ============================================================================

export class ResourceGraphRpcs extends RpcGroup.make(
  Rpc.make("submit", {
    payload: ResourceGraphSubmitInput.fields,
    success: ResourceGraphDesiredReceipt,
    error: GentRpcError,
  }),
  Rpc.make("get", {
    payload: ResourceGraphGetInput.fields,
    success: ResourceGraphStatusResult,
    error: GentRpcError,
  }),
  Rpc.make("preview", {
    payload: ResourceGraphPreviewInput.fields,
    success: ResourceGraphSnapshot,
    error: GentRpcError,
  }),
).prefix("resourceGraph.") {}

// Re-export sub-groups for handler wiring
export { SessionRpcs, WorkspaceHeaderError, WorkspaceRpcMiddleware }

// Re-export transport contract schemas (consumed by SDK + tests)
export {
  CreateSessionInput,
  Session,
  Branch,
  CreateBranchInput,
  SwitchBranchInput,
  ForkBranchInput,
  SendMessageInput,
  GetSessionSnapshotInput,
  SessionSnapshot,
  SteerCommand,
  QueueTarget,
  QueueSnapshot,
  SubscribeEventsInput,
  RespondInteractionInput,
  UpdateSessionReasoningLevelInput,
  DeletePermissionRuleInput,
  ListAuthProvidersInput,
  SetAuthKeyInput,
  DeleteAuthKeyInput,
  ListAuthMethodsSuccess,
  AuthorizeAuthInput,
  AuthorizeAuthSuccess,
  CallbackAuthInput,
  AuthProviderInfo,
  EventEnvelope,
  DriverInfo,
  DriverListResult,
  SetDriverOverrideInput,
  ClearDriverOverrideInput,
  ExtensionActivationPhase,
  ExtensionHealth,
  ExtensionHealthSnapshot,
  ExtensionHealthIssue,
  ExtensionManifestInfo,
  ResourceGraphGetInput,
  ResourceGraphPreviewInput,
  ResourceGraphStatusResult,
  ResourceGraphSubmitInput,
} from "./transport-contract.js"

// ============================================================================
// Merged RPC Group
// ============================================================================

export class GentRpcs extends RpcGroup.make()
  .merge(SessionRpcs, ExtensionRpcs, ResourceGraphRpcs, AuthRpcs, RuntimeRpcs)
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
