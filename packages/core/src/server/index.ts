import { AgentLoopError, SteerCommand } from "../runtime/agent/agent-loop.js"
import { GentCore, type GentCoreError, type GentCoreService, StorageError } from "./core.js"
import { createDependencies, type DependenciesConfig } from "./dependencies.js"
import { SessionQueries, type SessionQueriesService } from "./session-queries.js"
import { SessionCommands, type SessionCommandsService } from "./session-commands.js"
import { SessionEvents, type SessionEventsService } from "./session-events.js"
import { InteractionCommands, type InteractionCommandsService } from "./interaction-commands.js"
import type {
  BranchInfo,
  CreateBranchInput,
  CreateBranchOutput,
  CreateSessionInput,
  CreateSessionResult as CreateSessionOutput,
  GetSessionStateInput,
  MessageInfoReadonly as MessageInfo,
  SendMessageInput,
  SessionInfo,
  SessionState,
  SubscribeEventsInput,
} from "./transport-contract.js"

export { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from "./system-prompt"

export { SteerCommand, AgentLoopError, StorageError, createDependencies, type DependenciesConfig }
export {
  SessionQueries,
  type SessionQueriesService,
  SessionCommands,
  type SessionCommandsService,
  SessionEvents,
  type SessionEventsService,
  InteractionCommands,
  type InteractionCommandsService,
  GentCore,
  type GentCoreService,
  type GentCoreError,
  type CreateSessionInput,
  type CreateSessionOutput,
  type CreateBranchInput,
  type CreateBranchOutput,
  type SendMessageInput,
  type SubscribeEventsInput,
  type GetSessionStateInput,
  type SessionState,
  type SessionInfo,
  type BranchInfo,
  type MessageInfo,
}
export { GentRpcError, NotFoundError } from "./errors.js"
export type {
  BranchInfo as TransportBranchInfo,
  BranchTreeNode as TransportBranchTreeNode,
  CreateSessionResult,
  GentClient,
  MessageInfoReadonly,
  QueueEntryInfoReadonly,
  QueueSnapshotReadonly,
  SessionInfo as TransportSessionInfo,
  SessionState as TransportSessionState,
  SessionTreeNode as TransportSessionTreeNode,
  SkillContent,
  SkillInfo,
  SteerCommand as TransportSteerCommand,
} from "./transport-contract.js"

export { RpcHandlersLive } from "./rpc-handlers"

export {
  AuthProviderInfo,
  AuthorizeAuthPayload,
  AuthorizeAuthSuccess,
  BranchInfo as BranchInfoSchema,
  BranchTreeNodeSchema,
  CallbackAuthPayload,
  CreateBranchPayload,
  CreateBranchSuccess,
  CreateSessionPayload,
  CreateSessionSuccess,
  DeleteAuthKeyPayload,
  ForkBranchPayload,
  ForkBranchSuccess,
  GetBranchTreePayload,
  GetChildSessionsPayload,
  GetSessionStatePayload,
  GetSessionTreePayload,
  ListAuthMethodsSuccess,
  ListBranchesPayload,
  ListMessagesPayload,
  MessageInfo as MessageInfoSchema,
  RespondHandoffPayload,
  RespondHandoffSuccess,
  RespondPermissionPayload,
  RespondPromptPayload,
  SendMessagePayload,
  SessionInfo as SessionInfoSchema,
  SessionState as SessionStateSchema,
  SessionTreeNodeSchema,
  type SessionTreeNodeType,
  SetAuthKeyPayload,
  SteerPayload,
  SubscribeEventsPayload,
  SwitchBranchPayload,
  UpdateSessionBypassPayload,
  UpdateSessionBypassSuccess,
} from "./rpcs"

export { GentRpcs, type GentRpcsClient } from "./rpcs"

export {
  CreateSessionRequest,
  CreateSessionResponse,
  EventsApi,
  GentApi,
  MessagesApi,
  SendMessageRequest,
  SessionsApi,
  SteerRequest,
} from "./http-api.js"
