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
  CreateSessionPayload,
  CreateSessionSuccess,
  SessionInfo,
  SessionTreeNodeSchema,
  type SessionTreeNodeType,
  GetChildSessionsPayload,
  GetSessionTreePayload,
  BranchInfo,
  ListBranchesPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  BranchTreeNodeSchema,
  GetBranchTreePayload,
  SwitchBranchPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  SendMessagePayload,
  MessageInfo,
  ListMessagesPayload,
  GetSessionSnapshotPayload,
  SessionSnapshot,
  SteerPayload,
  DrainQueuedMessagesPayload,
  DrainQueuedMessagesSuccess,
  GetQueuedMessagesPayload,
  GetQueuedMessagesSuccess,
  SubscribeEventsPayload,
  WatchRuntimePayload,
  SessionRuntime,
  RespondQuestionsPayload,
  RespondPermissionPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
  UpdateSessionReasoningLevelPayload,
  UpdateSessionReasoningLevelSuccess,
  RespondPromptPayload,
  RespondHandoffPayload,
  RespondHandoffSuccess,
  DeletePermissionRulePayload,
  SetAuthKeyPayload,
  DeleteAuthKeyPayload,
  ListAuthMethodsSuccess,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  CallbackAuthPayload,
  AuthProviderInfo,
  EventEnvelope,
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
