import { Effect, Layer, Context } from "effect"
import { DEFAULT_AGENT_NAME } from "../domain/agent.js"
import type { SessionId } from "../domain/ids.js"
import type { Session, SessionTreeNode } from "../domain/message.js"
import { projectMessagesWithToolInteractions } from "../domain/message-part-projection.js"
import { emptyQueueSnapshot } from "../domain/queue.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import { NotFoundError, type GentRpcError } from "./errors.js"
import { SessionRuntime, SessionRuntimeStateSchema } from "../runtime/session-runtime.js"
import { SessionSnapshot } from "./transport-contract.js"
import type { GetSessionSnapshotInput } from "./transport-contract.js"

export interface SessionQueriesService {
  readonly getSessionTree: (
    rootSessionId: SessionId,
  ) => Effect.Effect<SessionTreeNode, GentRpcError>
  readonly getSessionSnapshot: (
    input: GetSessionSnapshotInput,
  ) => Effect.Effect<SessionSnapshot, GentRpcError>
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
      const storageTransaction = yield* makeStorageTransaction
      const sessionRuntime = yield* SessionRuntime

      const buildSessionTreeNode = (
        session: Session,
      ): Effect.Effect<SessionTreeNode, GentRpcError> =>
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

        const snapshotState = yield* storageTransaction(
          Effect.gen(function* () {
            const messages = yield* messageStorage.listMessages(input.branchId)
            const lastEventId = yield* eventStorage.getLatestEventId({
              sessionId: input.sessionId,
              branchId: input.branchId,
            })
            return {
              projectedMessages: projectMessagesWithToolInteractions(messages),
              lastEventId,
            }
          }),
        )

        // Fetch current runtime state — idle sessions return Idle runtime
        const idleRuntime = SessionRuntimeStateSchema.cases.Idle.make({
          agent: DEFAULT_AGENT_NAME,
          queue: emptyQueueSnapshot(),
        })
        const runtime = yield* sessionRuntime
          .getState({ sessionId: input.sessionId, branchId: input.branchId })
          .pipe(Effect.catchEager(() => Effect.succeed(idleRuntime)))

        // Cumulative metrics (turns, cost, last-model) are the authority for
        // client HUD displays. Keeping them on the snapshot means the TUI
        // hydrates cost/tokens from here instead of re-deriving by joining
        // streamed events against a client-side model registry.
        const metrics = yield* sessionRuntime
          .getMetrics({ sessionId: input.sessionId, branchId: input.branchId })
          .pipe(
            Effect.catchEager(() =>
              Effect.succeed({
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              }),
            ),
          )

        // Extension state is no longer hydrated through the session snapshot —
        // clients call the extension's typed `client.extension.request(...)` on
        // mount and subscribe to `ExtensionStateChanged` events for refetch
        // signals. The privileged out-of-band UI snapshot channel is gone.

        return new SessionSnapshot({
          sessionId: input.sessionId,
          branchId: input.branchId,
          name: session.name,
          messages: snapshotState.projectedMessages,
          lastEventId: snapshotState.lastEventId ?? null,
          reasoningLevel: session.reasoningLevel,
          activeBranchId: session.activeBranchId,
          runtime,
          metrics,
        })
      })

      return {
        getSessionTree,
        getSessionSnapshot,
      } satisfies SessionQueriesService
    }),
  )
}
