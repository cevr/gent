import { Effect, Layer, ServiceMap } from "effect"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { SessionTreeNode } from "../domain/message.js"
import type { Task } from "../domain/task.js"
import type { QueueSnapshot } from "../domain/queue.js"
import { GentCore, type GentCoreError } from "./core.js"
import type {
  BranchInfo,
  BranchTreeNode,
  GetSessionStateInput,
  MessageInfoReadonly,
  SessionInfo,
  SessionState,
} from "./transport-contract.js"

export interface SessionQueriesService {
  readonly listSessions: () => Effect.Effect<SessionInfo[], GentCoreError>
  readonly getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, GentCoreError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<SessionInfo | null, GentCoreError>
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<SessionInfo[], GentCoreError>
  readonly getSessionTree: (
    rootSessionId: SessionId,
  ) => Effect.Effect<SessionTreeNode, GentCoreError>
  readonly listBranches: (sessionId: SessionId) => Effect.Effect<BranchInfo[], GentCoreError>
  readonly getBranchTree: (sessionId: SessionId) => Effect.Effect<BranchTreeNode[], GentCoreError>
  readonly listMessages: (branchId: BranchId) => Effect.Effect<MessageInfoReadonly[], GentCoreError>
  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, GentCoreError>
  readonly getQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, GentCoreError>
  readonly getSessionState: (
    input: GetSessionStateInput,
  ) => Effect.Effect<SessionState, GentCoreError>
}

export class SessionQueries extends ServiceMap.Service<SessionQueries, SessionQueriesService>()(
  "@gent/core/src/server/session-queries/SessionQueries",
) {
  static Live = Layer.effect(
    SessionQueries,
    Effect.gen(function* () {
      const core = yield* GentCore
      return {
        listSessions: core.listSessions,
        getSession: core.getSession,
        getLastSessionByCwd: core.getLastSessionByCwd,
        getChildSessions: core.getChildSessions,
        getSessionTree: core.getSessionTree,
        listBranches: core.listBranches,
        getBranchTree: core.getBranchTree,
        listMessages: core.listMessages,
        listTasks: core.listTasks,
        getQueuedMessages: core.getQueuedMessages,
        getSessionState: core.getSessionState,
      } satisfies SessionQueriesService
    }),
  )
}
