import {
  RpcGroup,
  type RpcClient,
  type RpcClientError,
  type RpcGroup as RpcGroupNs,
  type Rpc,
} from "effect/unstable/rpc"
import { SessionRpcs } from "./rpcs/session.js"
import { BranchRpcs } from "./rpcs/branch.js"
import { MessageRpcs } from "./rpcs/message.js"
import { SteerRpcs } from "./rpcs/steer.js"
import { QueueRpcs } from "./rpcs/queue.js"
import { InteractionRpcs } from "./rpcs/interaction.js"
import { PermissionRpcs } from "./rpcs/permission.js"
import { ModelRpcs } from "./rpcs/model.js"
import { AuthRpcs } from "./rpcs/auth.js"
import { DriverRpcs } from "./rpcs/driver.js"
import { ExtensionRpcs } from "./rpcs/extension.js"
import { ServerRpcs } from "./rpcs/server.js"
import type { GentConnectionError } from "./transport-contract.js"
import { WorkspaceRpcMiddleware, WorkspaceHeaderError } from "./workspace-rpc.js"

// Re-export sub-groups for handler wiring
export {
  SessionRpcs,
  BranchRpcs,
  MessageRpcs,
  SteerRpcs,
  QueueRpcs,
  InteractionRpcs,
  PermissionRpcs,
  ModelRpcs,
  AuthRpcs,
  DriverRpcs,
  ExtensionRpcs,
  ServerRpcs,
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
  .merge(
    SessionRpcs,
    BranchRpcs,
    MessageRpcs,
    SteerRpcs,
    QueueRpcs,
    InteractionRpcs,
    PermissionRpcs,
    ModelRpcs,
    AuthRpcs,
    DriverRpcs,
    ExtensionRpcs,
    ServerRpcs,
  )
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
