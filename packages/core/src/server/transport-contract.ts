import type { Effect, Stream, ServiceMap } from "effect"
import type { AgentName, ReasoningEffort } from "../domain/agent.js"
import type { AuthAuthorization, AuthMethod } from "../domain/auth-method.js"
import type { AuthProviderInfo } from "../domain/auth-guard.js"
import type { EventEnvelope, HandoffDecision, PromptDecision } from "../domain/event.js"
import type { BranchId, MessageId, SessionId } from "../domain/ids.js"
import type { MessagePart } from "../domain/message.js"
import type { PermissionDecision, PermissionRule } from "../domain/permission.js"
import type { QueueEntryInfo, QueueSnapshot } from "../domain/queue.js"
import type { SkillScope } from "../domain/skills.js"
import type { Task } from "../domain/task.js"
import type { Model } from "../domain/model.js"
import type { GentRpcError } from "./errors.js"

export interface SkillInfo {
  name: string
  description: string
  scope: SkillScope
  filePath: string
}

export interface SkillContent extends SkillInfo {
  content: string
}

export interface MessageInfoReadonly {
  readonly id: MessageId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly kind?: "regular" | "interjection"
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly parts: readonly MessagePart[]
  readonly createdAt: number
  readonly turnDurationMs?: number
}

export type SteerCommand =
  | { _tag: "Cancel"; sessionId: SessionId; branchId: BranchId }
  | { _tag: "Interrupt"; sessionId: SessionId; branchId: BranchId }
  | {
      _tag: "Interject"
      sessionId: SessionId
      branchId: BranchId
      message: string
      agent?: AgentName
    }
  | { _tag: "SwitchAgent"; sessionId: SessionId; branchId: BranchId; agent: AgentName }

export interface SessionInfo {
  id: SessionId
  name?: string
  cwd?: string
  bypass?: boolean
  reasoningLevel?: ReasoningEffort
  branchId?: BranchId
  parentSessionId?: SessionId
  parentBranchId?: BranchId
  createdAt: number
  updatedAt: number
}

export interface BranchInfo {
  id: BranchId
  sessionId: SessionId
  parentBranchId?: BranchId
  parentMessageId?: MessageId
  name?: string
  summary?: string
  createdAt: number
}

export interface BranchTreeNode {
  id: BranchId
  name?: string
  summary?: string
  parentMessageId?: MessageId
  messageCount: number
  createdAt: number
  children: readonly BranchTreeNode[]
}

export type QueueEntryInfoReadonly = QueueEntryInfo
export type QueueSnapshotReadonly = QueueSnapshot

export interface SessionState {
  sessionId: SessionId
  branchId: BranchId
  messages: readonly MessageInfoReadonly[]
  lastEventId: number | null
  isStreaming: boolean
  agent: AgentName
  bypass?: boolean
  reasoningLevel?: ReasoningEffort
}

export interface SessionTreeNode {
  id: SessionId
  name?: string
  cwd?: string
  bypass?: boolean
  parentSessionId?: SessionId
  parentBranchId?: BranchId
  createdAt: number
  updatedAt: number
  children: readonly SessionTreeNode[]
}

export interface CreateSessionResult {
  sessionId: SessionId
  branchId: BranchId
  name: string
  bypass: boolean
}

export interface GentClient {
  sendMessage: (input: {
    sessionId: SessionId
    branchId: BranchId
    content: string
  }) => Effect.Effect<void, GentRpcError>

  createSession: (input?: {
    firstMessage?: string
    cwd?: string
    bypass?: boolean
    parentSessionId?: SessionId
    parentBranchId?: BranchId
  }) => Effect.Effect<CreateSessionResult, GentRpcError>

  listMessages: (branchId: BranchId) => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>

  getSessionState: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<SessionState, GentRpcError>

  getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, GentRpcError>

  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>

  getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<readonly SessionInfo[], GentRpcError>

  getSessionTree: (sessionId: SessionId) => Effect.Effect<SessionTreeNode, GentRpcError>

  listModels: () => Effect.Effect<readonly Model[], GentRpcError>

  listBranches: (sessionId: SessionId) => Effect.Effect<readonly BranchInfo[], GentRpcError>

  listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, GentRpcError>

  getBranchTree: (sessionId: SessionId) => Effect.Effect<readonly BranchTreeNode[], GentRpcError>

  createBranch: (sessionId: SessionId, name?: string) => Effect.Effect<BranchId, GentRpcError>

  switchBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    toBranchId: BranchId
    summarize?: boolean
  }) => Effect.Effect<void, GentRpcError>

  forkBranch: (input: {
    sessionId: SessionId
    fromBranchId: BranchId
    atMessageId: MessageId
    name?: string
  }) => Effect.Effect<{ branchId: string }, GentRpcError>

  subscribeEvents: (input: {
    sessionId: SessionId
    branchId?: BranchId
    after?: number
  }) => Stream.Stream<EventEnvelope, GentRpcError>

  invokeTool: (input: {
    sessionId: SessionId
    branchId: BranchId
    toolName: string
    input: unknown
  }) => Effect.Effect<void, GentRpcError>

  steer: (command: SteerCommand) => Effect.Effect<void, GentRpcError>

  drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshotReadonly, GentRpcError>

  getQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshotReadonly, GentRpcError>

  respondQuestions: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, GentRpcError>

  respondPermission: (
    requestId: string,
    decision: PermissionDecision,
    persist?: boolean,
  ) => Effect.Effect<void, GentRpcError>

  respondPrompt: (
    requestId: string,
    decision: PromptDecision,
    content?: string,
  ) => Effect.Effect<void, GentRpcError>

  respondHandoff: (
    requestId: string,
    decision: HandoffDecision,
    reason?: string,
  ) => Effect.Effect<{ childSessionId?: SessionId; childBranchId?: BranchId }, GentRpcError>

  updateSessionBypass: (
    sessionId: SessionId,
    bypass: boolean,
  ) => Effect.Effect<{ bypass: boolean }, GentRpcError>

  updateSessionReasoningLevel: (
    sessionId: SessionId,
    reasoningLevel: ReasoningEffort | undefined,
  ) => Effect.Effect<{ reasoningLevel: ReasoningEffort | undefined }, GentRpcError>

  getPermissionRules: () => Effect.Effect<readonly PermissionRule[], GentRpcError>

  deletePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void, GentRpcError>

  listAuthProviders: () => Effect.Effect<readonly AuthProviderInfo[], GentRpcError>

  setAuthKey: (provider: string, key: string) => Effect.Effect<void, GentRpcError>

  deleteAuthKey: (provider: string) => Effect.Effect<void, GentRpcError>

  listAuthMethods: () => Effect.Effect<Record<string, ReadonlyArray<AuthMethod>>, GentRpcError>

  authorizeAuth: (
    sessionId: string,
    provider: string,
    method: number,
  ) => Effect.Effect<AuthAuthorization | null, GentRpcError>

  callbackAuth: (
    sessionId: string,
    provider: string,
    method: number,
    authorizationId: string,
    code?: string,
  ) => Effect.Effect<void, GentRpcError>

  listSkills: () => Effect.Effect<readonly SkillContent[], GentRpcError>

  getSkillContent: (name: string) => Effect.Effect<SkillContent | null, GentRpcError>

  services: ServiceMap.ServiceMap<unknown>
}
