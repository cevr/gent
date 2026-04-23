import { Effect, Layer, Context } from "effect"
import { DEFAULT_AGENT_NAME } from "../domain/agent.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { Session, SessionTreeNode } from "../domain/message.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../domain/queue.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { NotFoundError, type AppServiceError } from "./errors.js"
import { SessionRuntime, SessionRuntimeStateSchema } from "../runtime/session-runtime.js"
import { buildBranchTree, branchToInfo, messageToInfo, sessionToInfo } from "./session-utils.js"
import { SessionSnapshot } from "./transport-contract.js"
import type {
  BranchInfo,
  BranchTreeNode,
  GetSessionSnapshotInput,
  MessageInfoReadonly,
  SessionInfo,
} from "./transport-contract.js"

export interface SessionQueriesService {
  readonly listSessions: () => Effect.Effect<SessionInfo[], AppServiceError>
  readonly getSession: (sessionId: SessionId) => Effect.Effect<SessionInfo | null, AppServiceError>
  readonly getLastSessionByCwd: (cwd: string) => Effect.Effect<SessionInfo | null, AppServiceError>
  readonly getChildSessions: (
    parentSessionId: SessionId,
  ) => Effect.Effect<SessionInfo[], AppServiceError>
  readonly getSessionTree: (
    rootSessionId: SessionId,
  ) => Effect.Effect<SessionTreeNode, AppServiceError>
  readonly listBranches: (sessionId: SessionId) => Effect.Effect<BranchInfo[], AppServiceError>
  readonly getBranchTree: (sessionId: SessionId) => Effect.Effect<BranchTreeNode[], AppServiceError>
  readonly listMessages: (
    branchId: BranchId,
  ) => Effect.Effect<MessageInfoReadonly[], AppServiceError>
  readonly getQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly getSessionSnapshot: (
    input: GetSessionSnapshotInput,
  ) => Effect.Effect<SessionSnapshot, AppServiceError>
}

export class SessionQueries extends Context.Service<SessionQueries, SessionQueriesService>()(
  "@gent/core/src/server/session-queries/SessionQueries",
) {
  static Live = Layer.effect(
    SessionQueries,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
      const eventStorage = yield* EventStorage
      const relationshipStorage = yield* RelationshipStorage
      const sessionRuntime = yield* SessionRuntime

      const listSessions = Effect.fn("SessionQueries.listSessions")(function* () {
        const sessions = yield* sessionStorage.listSessions()
        const firstBranches = yield* sessionStorage.listFirstBranches()
        const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
        return sessions.map((session) => sessionToInfo(session, branchMap.get(session.id)))
      })

      const getSession = Effect.fn("SessionQueries.getSession")(function* (sessionId: SessionId) {
        const session = yield* sessionStorage.getSession(sessionId)
        if (session === undefined) return null
        const branches = yield* branchStorage.listBranches(sessionId)
        return sessionToInfo(session, branches[0]?.id)
      })

      const getLastSessionByCwd = Effect.fn("SessionQueries.getLastSessionByCwd")(function* (
        cwd: string,
      ) {
        const session = yield* sessionStorage.getLastSessionByCwd(cwd)
        if (session === undefined) return null
        const branches = yield* branchStorage.listBranches(session.id)
        return sessionToInfo(session, branches[0]?.id)
      })

      const getChildSessions = Effect.fn("SessionQueries.getChildSessions")(function* (
        parentSessionId: SessionId,
      ) {
        const children = yield* relationshipStorage.getChildSessions(parentSessionId)
        const firstBranches = yield* sessionStorage.listFirstBranches()
        const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
        return children.map((session) => sessionToInfo(session, branchMap.get(session.id)))
      })

      const buildSessionTreeNode = (
        session: Session,
      ): Effect.Effect<SessionTreeNode, AppServiceError> =>
        Effect.gen(function* () {
          const children = yield* relationshipStorage.getChildSessions(session.id)
          return {
            session,
            children: yield* Effect.forEach(children, buildSessionTreeNode, { concurrency: 5 }),
          }
        })

      const getSessionTree = Effect.fn("SessionQueries.getSessionTree")(function* (
        rootSessionId: SessionId,
      ) {
        const rootSession = yield* sessionStorage.getSession(rootSessionId)
        if (rootSession === undefined) {
          return yield* new NotFoundError({
            message: `Session not found: ${rootSessionId}`,
            entity: "session",
          })
        }
        return yield* buildSessionTreeNode(rootSession)
      })

      const getBranchTree = Effect.fn("SessionQueries.getBranchTree")(function* (
        sessionId: SessionId,
      ) {
        const branches = yield* branchStorage.listBranches(sessionId)
        const messageCounts = yield* branchStorage.countMessagesByBranches(
          branches.map((branch) => branch.id),
        )
        return buildBranchTree(branches, messageCounts)
      })

      const getSessionSnapshot = Effect.fn("SessionQueries.getSessionSnapshot")(function* (
        input: GetSessionSnapshotInput,
      ) {
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (session === undefined) {
          return yield* new NotFoundError({ message: "Session not found", entity: "session" })
        }
        const branch = yield* branchStorage.getBranch(input.branchId)
        if (branch === undefined || branch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
        }

        const messages = yield* messageStorage.listMessages(input.branchId)
        const lastEventId = yield* eventStorage.getLatestEventId({
          sessionId: input.sessionId,
          branchId: input.branchId,
        })

        // Fetch current runtime state — idle sessions return Idle runtime
        const idleRuntime = SessionRuntimeStateSchema.cases.Idle.make({
          agent: DEFAULT_AGENT_NAME,
          queue: emptyQueueSnapshot(),
        })
        const runtime = yield* sessionRuntime
          .getState({ sessionId: input.sessionId, branchId: input.branchId })
          .pipe(Effect.catchEager(() => Effect.succeed(idleRuntime)))

        // Extension state is no longer hydrated through the session snapshot —
        // clients call the extension's typed `client.extension.request(...)` on
        // mount and subscribe to `ExtensionStateChanged` events for refetch
        // signals. The privileged out-of-band UI snapshot channel is gone.

        return new SessionSnapshot({
          sessionId: input.sessionId,
          branchId: input.branchId,
          name: session.name,
          messages: messages.map(messageToInfo),
          lastEventId: lastEventId ?? null,
          reasoningLevel: session.reasoningLevel,
          activeBranchId: session.activeBranchId,
          runtime,
        })
      })

      return {
        listSessions,
        getSession,
        getLastSessionByCwd,
        getChildSessions,
        getSessionTree,
        listBranches: (sessionId) =>
          branchStorage.listBranches(sessionId).pipe(Effect.map((xs) => xs.map(branchToInfo))),
        getBranchTree,
        listMessages: (branchId) =>
          messageStorage.listMessages(branchId).pipe(Effect.map((xs) => xs.map(messageToInfo))),
        getQueuedMessages: ({ sessionId, branchId }) =>
          sessionRuntime
            .getQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionQueries.getQueuedMessages")),
        getSessionSnapshot,
      } satisfies SessionQueriesService
    }),
  )
}
