import {
  RpcGroup,
  type RpcClient,
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
import { TaskRpcs } from "./rpcs/task.js"
import { SkillRpcs } from "./rpcs/skill.js"
import { ExtensionRpcs } from "./rpcs/extension.js"
import { ActorRpcs } from "./rpcs/actor.js"

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
  TaskRpcs,
  SkillRpcs,
  ExtensionRpcs,
  ActorRpcs,
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
  ListExtensionStatusInput,
  ExtensionActivationPhase,
  ExtensionActorLifecycleStatus,
  ExtensionActorStatusInfo,
  ExtensionHealth,
  ExtensionHealthSnapshot,
  ExtensionHealthSummary,
  ExtensionManifestInfo,
  SkillInfo,
  SkillContent,
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
  TaskRpcs,
  SkillRpcs,
  ExtensionRpcs,
  ActorRpcs,
) {}

// ============================================================================
// RPC Client Types
// ============================================================================

export type GentRpcClient = RpcClient.RpcClient<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcClientError = Rpc.Error<RpcGroupNs.Rpcs<typeof GentRpcs>>

export type GentRpcsClient = GentRpcClient
