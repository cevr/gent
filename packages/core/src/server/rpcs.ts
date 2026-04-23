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
import { ActorRpcs } from "./rpcs/actor.js"
import { ServerRpcs } from "./rpcs/server.js"
import type { GentConnectionError } from "./transport-contract.js"

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
  ActorRpcs,
  ServerRpcs,
}

// Re-export transport contract schemas (consumed by SDK + tests)
export {
  CreateSessionInput,
  CreateSessionResult,
  SessionInfo,
  SessionTreeNodeSchema,
  type SessionTreeNodeType,
  GetChildSessionsInput,
  GetSessionTreeInput,
  BranchInfo,
  ListBranchesInput,
  CreateBranchInput,
  CreateBranchResult,
  BranchTreeNodeSchema,
  GetBranchTreeInput,
  SwitchBranchInput,
  ForkBranchInput,
  ForkBranchResult,
  SendMessageInput,
  MessageInfo,
  ListMessagesInput,
  GetSessionSnapshotInput,
  SessionSnapshot,
  SteerCommand,
  QueueTarget,
  QueueSnapshot,
  SubscribeEventsInput,
  WatchRuntimeInput,
  SessionRuntime,
  RespondInteractionInput,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
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
  ListExtensionStatusInput,
  ExtensionActivationPhase,
  ExtensionActorLifecycleStatus,
  ExtensionActorStatusInfo,
  ExtensionHealth,
  ExtensionHealthSnapshot,
  ExtensionHealthSummary,
  ExtensionManifestInfo,
} from "./transport-contract.js"

// ============================================================================
// Merged RPC Group
// ============================================================================

export class GentRpcs extends RpcGroup.make().merge(
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
  ActorRpcs,
  ServerRpcs,
) {}

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
