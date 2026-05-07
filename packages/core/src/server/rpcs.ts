import {
  RpcGroup,
  type RpcClient,
  type RpcClientError,
  type RpcGroup as RpcGroupNs,
  type Rpc,
} from "effect/unstable/rpc"
import { SessionRpcs } from "./rpcs/session.js"
import { AuthRpcs } from "./rpcs/auth.js"
import { ExtensionRpcs } from "./rpcs/extension.js"
import { RuntimeRpcs } from "./rpcs/runtime.js"
import type { GentConnectionError } from "./transport-contract.js"
import { WorkspaceRpcMiddleware, WorkspaceHeaderError } from "./workspace-rpc.js"

// Re-export sub-groups for handler wiring
export {
  SessionRpcs,
  AuthRpcs,
  ExtensionRpcs,
  RuntimeRpcs,
  WorkspaceHeaderError,
  WorkspaceRpcMiddleware,
}

// Re-export transport contract schemas (consumed by SDK + tests)
export {
  CreateSessionInput,
  Session,
  type SessionTreeNodeType,
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
} from "./transport-contract.js"

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

export type GentRpcClientError =
  | Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>
  | RpcClientError.RpcClientError
  | GentConnectionError

export type GentRpcsClient = GentRpcClient
