import { Effect, Layer, Option, ServiceMap } from "effect"
import type { BranchId, SessionId } from "../domain/ids.js"
import type { Session, SessionTreeNode } from "../domain/message.js"
import type { Task } from "../domain/task.js"
import type { QueueSnapshot } from "../domain/queue.js"
import { Storage } from "../storage/sqlite-storage.js"
import { TaskStorage } from "../storage/task-storage.js"
import { InteractionStorage } from "../storage/interaction-storage.js"
import { ActorProcess } from "../runtime/actor-process.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { NotFoundError, type AppServiceError } from "./errors.js"
import { buildBranchTree, branchToInfo, messageToInfo, sessionToInfo } from "./session-utils.js"
import type {
  BranchInfo,
  BranchTreeNode,
  GetSessionSnapshotInput,
  MessageInfoReadonly,
  SessionInfo,
  SessionSnapshot,
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
  readonly listTasks: (
    sessionId: SessionId,
    branchId?: BranchId,
  ) => Effect.Effect<ReadonlyArray<Task>, AppServiceError>
  readonly getQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly getSessionSnapshot: (
    input: GetSessionSnapshotInput,
  ) => Effect.Effect<SessionSnapshot, AppServiceError>
}

export class SessionQueries extends ServiceMap.Service<SessionQueries, SessionQueriesService>()(
  "@gent/core/src/server/session-queries/SessionQueries",
) {
  static Live = Layer.effect(
    SessionQueries,
    Effect.gen(function* () {
      const storage = yield* Storage
      const interactionStore = yield* InteractionStorage
      const actorProcess = yield* ActorProcess
      const extensionStateRuntime = yield* ExtensionStateRuntime

      const listSessions = Effect.fn("SessionQueries.listSessions")(function* () {
        const sessions = yield* storage.listSessions()
        const firstBranches = yield* storage.listFirstBranches()
        const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
        return sessions.map((session) => sessionToInfo(session, branchMap.get(session.id)))
      })

      const getSession = Effect.fn("SessionQueries.getSession")(function* (sessionId: SessionId) {
        const session = yield* storage.getSession(sessionId)
        if (session === undefined) return null
        const branches = yield* storage.listBranches(sessionId)
        return sessionToInfo(session, branches[0]?.id)
      })

      const getLastSessionByCwd = Effect.fn("SessionQueries.getLastSessionByCwd")(function* (
        cwd: string,
      ) {
        const session = yield* storage.getLastSessionByCwd(cwd)
        if (session === undefined) return null
        const branches = yield* storage.listBranches(session.id)
        return sessionToInfo(session, branches[0]?.id)
      })

      const getChildSessions = Effect.fn("SessionQueries.getChildSessions")(function* (
        parentSessionId: SessionId,
      ) {
        const children = yield* storage.getChildSessions(parentSessionId)
        const firstBranches = yield* storage.listFirstBranches()
        const branchMap = new Map(firstBranches.map((row) => [row.sessionId, row.branchId]))
        return children.map((session) => sessionToInfo(session, branchMap.get(session.id)))
      })

      const buildSessionTreeNode = (
        session: Session,
      ): Effect.Effect<SessionTreeNode, AppServiceError> =>
        Effect.gen(function* () {
          const children = yield* storage.getChildSessions(session.id)
          return {
            session,
            children: yield* Effect.forEach(children, buildSessionTreeNode, { concurrency: 5 }),
          }
        })

      const getSessionTree = Effect.fn("SessionQueries.getSessionTree")(function* (
        rootSessionId: SessionId,
      ) {
        const rootSession = yield* storage.getSession(rootSessionId)
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
        const branches = yield* storage.listBranches(sessionId)
        const messageCounts = yield* storage.countMessagesByBranches(
          branches.map((branch) => branch.id),
        )
        return buildBranchTree(branches, messageCounts)
      })

      const getSessionSnapshot = Effect.fn("SessionQueries.getSessionSnapshot")(function* (
        input: GetSessionSnapshotInput,
      ) {
        const session = yield* storage.getSession(input.sessionId)
        if (session === undefined) {
          return yield* new NotFoundError({ message: "Session not found", entity: "session" })
        }
        const branch = yield* storage.getBranch(input.branchId)
        if (branch === undefined || branch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
        }

        const messages = yield* storage.listMessages(input.branchId)
        const lastEventId = yield* storage.getLatestEventId({
          sessionId: input.sessionId,
          branchId: input.branchId,
        })

        // Fetch current runtime state — idle sessions return idle runtime
        const idleRuntime = {
          phase: "idle" as const,
          status: "idle" as const,
          agent: "cowork" as const,
          queue: { steering: [], followUp: [] },
        }
        const runtime = yield* actorProcess
          .getState({ sessionId: input.sessionId, branchId: input.branchId })
          .pipe(
            Effect.map((state) => ({
              phase: state.phase,
              status: state.status,
              agent: state.agent ?? "cowork",
              queue: state.queue,
            })),
            Effect.catchEager(() => Effect.succeed(idleRuntime)),
          )

        // Extension UI snapshots for cold-start hydration
        const extensionSnapshots = yield* extensionStateRuntime
          .getUiSnapshots(input.sessionId, input.branchId)
          .pipe(
            Effect.map((snapshots) =>
              snapshots.map((s) => ({
                extensionId: s.extensionId,
                epoch: s.epoch,
                model: s.model,
              })),
            ),
            Effect.catchEager(() => Effect.succeed([] as const)),
          )

        // Active interaction — find pending request for this session+branch
        const activeInteraction = yield* interactionStore.listPending().pipe(
          Effect.map((requests) => {
            const match = requests.find(
              (r) => r.sessionId === input.sessionId && r.branchId === input.branchId,
            )
            if (match === undefined) return undefined
            return {
              requestId: match.requestId,
              tag: match.type,
              event: JSON.parse(match.paramsJson) as unknown,
            }
          }),
          Effect.option,
          Effect.map((opt) => (opt._tag === "Some" ? opt.value : undefined)),
        )

        return {
          sessionId: input.sessionId,
          branchId: input.branchId,
          name: session.name,
          messages: messages.map(messageToInfo),
          lastEventId: lastEventId ?? null,
          reasoningLevel: session.reasoningLevel,
          activeBranchId: session.activeBranchId,
          runtime,
          extensionSnapshots: extensionSnapshots.length > 0 ? [...extensionSnapshots] : undefined,
          activeInteraction,
        }
      })

      return {
        listSessions,
        getSession,
        getLastSessionByCwd,
        getChildSessions,
        getSessionTree,
        listBranches: (sessionId) =>
          storage.listBranches(sessionId).pipe(Effect.map((xs) => xs.map(branchToInfo))),
        getBranchTree,
        listMessages: (branchId) =>
          storage.listMessages(branchId).pipe(Effect.map((xs) => xs.map(messageToInfo))),
        listTasks: (sessionId, branchId) =>
          Effect.serviceOption(TaskStorage).pipe(
            Effect.flatMap((opt) =>
              Option.match(opt, {
                onNone: () => Effect.succeed([] as ReadonlyArray<Task>),
                onSome: (ts) => ts.listTasks(sessionId, branchId).pipe(Effect.orDie),
              }),
            ),
            Effect.withSpan("SessionQueries.listTasks"),
          ),
        getQueuedMessages: ({ sessionId, branchId }) =>
          actorProcess
            .getQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionQueries.getQueuedMessages")),
        getSessionSnapshot,
      } satisfies SessionQueriesService
    }),
  )
}
