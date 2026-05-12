import { DateTime, Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import {
  BranchCreated,
  BranchSwitched,
  EventStore,
  SessionNameUpdated,
  SessionSettingsUpdated,
  SessionStarted,
  type AgentEvent,
  type EventStoreError,
} from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Session, copyMessageToBranch } from "../domain/message.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import {
  SessionOperationStorage,
  type StoredBranchResult,
  type StoredSwitchBranchResult,
} from "../storage/session-operation-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { type StorageError, makeStorageTransaction } from "../storage/sqlite-storage.js"
import { InvalidStateError, NotFoundError } from "./errors.js"
import { CurrentWorkspaceId } from "./workspace-rpc.js"

const createBranchResult = (operation: StoredBranchResult): { readonly branchId: BranchId } => ({
  branchId: operation.branchId,
})

const cleanupSessionRuntimeState = Effect.fn("SessionMutations.cleanupSessionRuntimeState")(
  function* (sessionId: SessionId) {
    const sessionRuntime = yield* SessionRuntime
    yield* sessionRuntime.terminateSession(sessionId).pipe(Effect.orDie)
  },
)

const restoreSessionRuntimeState = Effect.fn("SessionMutations.restoreSessionRuntimeState")(
  function* (sessionId: SessionId) {
    const governance = yield* AgentLoopSessionGovernance
    const workspaceId = yield* CurrentWorkspaceId
    yield* governance.clearTerminated(workspaceId, sessionId).pipe(Effect.orDie)
  },
)

const forgetDeletedSessionRuntimeState = Effect.fn(
  "SessionMutations.forgetDeletedSessionRuntimeState",
)(function* (sessionId: SessionId) {
  const eventStore = yield* EventStore
  yield* eventStore.removeSession(sessionId)
})

const makeSessionMutationsService: Effect.Effect<
  SessionMutationsService,
  never,
  | SqlClient.SqlClient
  | EventStore
  | EventPublisher
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | RelationshipStorage
  | SessionOperationStorage
  | SessionRuntime
  | AgentLoopSessionGovernance
  | GentPlatform
> = Effect.gen(function* () {
  const storageTransaction = yield* makeStorageTransaction
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const relationshipStorage = yield* RelationshipStorage
  const sessionOperationStorage = yield* SessionOperationStorage
  const eventPublisher = yield* EventPublisher
  const platform = yield* GentPlatform
  const sessionRuntimeContext = yield* Effect.context<
    SessionRuntime | EventStore | AgentLoopSessionGovernance
  >()

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    event: AgentEvent,
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          const result = yield* mutation
          const envelope = yield* eventPublisher.append(event)
          return { result, envelope }
        }),
      )
      yield* eventPublisher.deliver(committed.envelope)
      return committed.result
    })

  const validateMessageCursor = Effect.fn("SessionMutations.validateMessageCursor")(
    function* (input: {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly afterMessageId?: MessageId
    }) {
      if (input.afterMessageId === undefined) return
      const cursor = yield* messageStorage.getMessage(input.afterMessageId)
      if (
        cursor === undefined ||
        cursor.sessionId !== input.sessionId ||
        cursor.branchId !== input.branchId
      ) {
        return yield* new NotFoundError({
          message: `Message "${input.afterMessageId}" not found in current branch`,
          entity: "message",
        })
      }
    },
  )

  const validateBranchDeletion = Effect.fn("SessionMutations.validateBranchDeletion")(
    function* (input: { readonly sessionId: SessionId; readonly branchId: BranchId }) {
      const branches = yield* branchStorage.listBranches(input.sessionId)
      if (branches.some((branch) => branch.parentBranchId === input.branchId)) {
        return yield* new InvalidStateError({
          message: `Cannot delete branch "${input.branchId}" with child branches`,
          operation: "deleteBranch",
        })
      }
      const childSessions = yield* relationshipStorage.getChildSessions(input.sessionId)
      if (childSessions.some((session) => session.parentBranchId === input.branchId)) {
        return yield* new InvalidStateError({
          message: `Cannot delete branch "${input.branchId}" with child sessions`,
          operation: "deleteBranch",
        })
      }
    },
  )

  const collectSessionTreeIds = Effect.fn("SessionMutations.collectSessionTreeIds")(function* (
    rootSessionId: SessionId,
  ) {
    const sessionIds: SessionId[] = []
    const queue: SessionId[] = [rootSessionId]
    const seen = new Set<SessionId>()
    let index = 0

    while (index < queue.length) {
      const sessionId = queue[index]
      index += 1
      if (sessionId === undefined || seen.has(sessionId)) continue
      seen.add(sessionId)
      sessionIds.push(sessionId)
      const children = yield* relationshipStorage.getChildSessions(sessionId)
      for (const child of children) {
        queue.push(child.id)
      }
    }

    return sessionIds
  })

  const cleanupSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.cleanupSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* cleanupSessionRuntimeState(sessionId).pipe(Effect.provideContext(sessionRuntimeContext))
  })

  const restoreSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.restoreSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* restoreSessionRuntimeState(sessionId).pipe(Effect.provideContext(sessionRuntimeContext))
  })

  const forgetDeletedSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.forgetDeletedSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* forgetDeletedSessionRuntimeState(sessionId).pipe(
      Effect.provideContext(sessionRuntimeContext),
    )
  })

  const deleteSessionCascade = Effect.fn("SessionMutations.deleteSessionCascade")(function* (
    sessionId: SessionId,
  ) {
    // Pre-collect is the best effort set we can tombstone BEFORE the durable
    // delete — so their runtimes stop accepting work while the tx runs. The
    // durable delete returns the authoritative set (the same rows the cascade
    // touched, collected inside its own tx) which we then use for the final
    // cleanup pass. Any descendant created between pre-collect and the tx is
    // included in the authoritative set and cleaned up here too.
    const preTombstoned = yield* collectSessionTreeIds(sessionId)
    yield* Effect.forEach(preTombstoned, cleanupSessionRuntimeStateForMutation, { discard: true })
    const cascadedIds = yield* sessionStorage.deleteSession(sessionId).pipe(
      // On failure we only restore `preTombstoned`: descendants created after pre-collect
      // were never tombstoned here, so there's no runtime state for them to "restore" to.
      Effect.onError(() =>
        Effect.forEach(preTombstoned, restoreSessionRuntimeStateForMutation, { discard: true }),
      ),
    )
    const preSet = new Set(preTombstoned)
    const postDeleteOnly = cascadedIds.filter((id) => !preSet.has(id))
    yield* Effect.forEach(postDeleteOnly, cleanupSessionRuntimeStateForMutation, { discard: true })
    yield* Effect.forEach(cascadedIds, forgetDeletedSessionRuntimeStateForMutation, {
      discard: true,
    })
    yield* Effect.forEach(
      cascadedIds,
      (deletedSessionId) =>
        Effect.logInfo("session.deleted").pipe(
          Effect.annotateLogs({ sessionId: deletedSessionId }),
        ),
      { discard: true },
    )
  })

  return {
    renameSession: Effect.fn("SessionMutations.renameSession")(function* (input) {
      const trimmed = input.name.trim().slice(0, 80)
      if (trimmed.length === 0) return { renamed: false as const }
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) return { renamed: false as const }
      if (session.name === trimmed) return { renamed: false as const }
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            name: trimmed,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        SessionNameUpdated.make({ sessionId: input.sessionId, name: trimmed }),
      )
      return { renamed: true as const, name: trimmed }
    }),

    createSessionBranch: Effect.fn("SessionMutations.createSessionBranch")(function* (input) {
      if (input.requestId !== undefined) {
        const existing = yield* sessionOperationStorage.getCreateBranch(input.requestId)
        if (existing !== undefined) return createBranchResult(existing)
      }

      const branch = new Branch({
        id: BranchId.make(yield* platform.randomId),
        sessionId: input.sessionId,
        parentBranchId: input.parentBranchId,
        name: input.name,
        createdAt: yield* DateTime.nowAsDate,
      })
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (input.requestId !== undefined) {
            const existing = yield* sessionOperationStorage.getCreateBranch(input.requestId)
            if (existing !== undefined) return { result: existing }
          }
          yield* branchStorage.createBranch(branch)
          const envelope = yield* eventPublisher.append(
            BranchCreated.make({
              sessionId: branch.sessionId,
              branchId: branch.id,
              ...(branch.parentBranchId !== undefined
                ? { parentBranchId: branch.parentBranchId }
                : {}),
            }),
          )
          const result: StoredBranchResult = { branchId: branch.id }
          if (input.requestId !== undefined) {
            yield* sessionOperationStorage.saveCreateBranch(input.requestId, result)
          }
          return { envelope, result }
        }),
      )
      if (committed.envelope !== undefined) {
        yield* eventPublisher.deliver(committed.envelope)
      }
      return createBranchResult(committed.result)
    }),

    forkSessionBranch: Effect.fn("SessionMutations.forkSessionBranch")(function* (input) {
      if (input.requestId !== undefined) {
        const existing = yield* sessionOperationStorage.getForkBranch(input.requestId)
        if (existing !== undefined) return createBranchResult(existing)
      }

      const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
      if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({ message: "Branch not found", entity: "branch" })
      }

      const messages = yield* messageStorage.listMessages(input.fromBranchId)
      const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
      if (targetIndex === -1) {
        return yield* new NotFoundError({
          message: "Message not found in branch",
          entity: "message",
        })
      }

      const branch = new Branch({
        id: BranchId.make(yield* platform.randomId),
        sessionId: input.sessionId,
        parentBranchId: input.fromBranchId,
        parentMessageId: input.atMessageId,
        name: input.name,
        createdAt: yield* DateTime.nowAsDate,
      })
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (input.requestId !== undefined) {
            const existing = yield* sessionOperationStorage.getForkBranch(input.requestId)
            if (existing !== undefined) return { result: existing }
          }
          yield* branchStorage.createBranch(branch)
          for (const message of messages.slice(0, targetIndex + 1)) {
            yield* messageStorage.createMessage(
              copyMessageToBranch(message, {
                id: MessageId.make(yield* platform.randomId),
                branchId: branch.id,
              }),
            )
          }
          const envelope = yield* eventPublisher.append(
            BranchCreated.make({
              sessionId: branch.sessionId,
              branchId: branch.id,
              ...(branch.parentBranchId !== undefined
                ? { parentBranchId: branch.parentBranchId }
                : {}),
              ...(branch.parentMessageId !== undefined
                ? { parentMessageId: branch.parentMessageId }
                : {}),
            }),
          )
          const result: StoredBranchResult = { branchId: branch.id }
          if (input.requestId !== undefined) {
            yield* sessionOperationStorage.saveForkBranch(input.requestId, result)
          }
          return { envelope, result }
        }),
      )
      if (committed.envelope !== undefined) {
        yield* eventPublisher.deliver(committed.envelope)
      }
      return createBranchResult(committed.result)
    }),

    switchActiveBranch: Effect.fn("SessionMutations.switchActiveBranch")(function* (input) {
      if (input.requestId !== undefined) {
        const existing = yield* sessionOperationStorage.getSwitchBranch(input.requestId)
        if (existing !== undefined) return
      }

      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) {
        return yield* new NotFoundError({
          message: "Current session not found",
          entity: "session",
        })
      }
      const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
      if (fromBranch === undefined || fromBranch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({
          message: `Branch "${input.fromBranchId}" not found in current session`,
          entity: "branch",
        })
      }
      const toBranch = yield* branchStorage.getBranch(input.toBranchId)
      if (toBranch === undefined || toBranch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({
          message: `Branch "${input.toBranchId}" not found in current session`,
          entity: "branch",
        })
      }
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (input.requestId !== undefined) {
            const existing = yield* sessionOperationStorage.getSwitchBranch(input.requestId)
            if (existing !== undefined) return { result: existing }
          }
          yield* sessionStorage.updateSession(
            new Session({
              ...session,
              activeBranchId: input.toBranchId,
              updatedAt: yield* DateTime.nowAsDate,
            }),
          )
          const envelope = yield* eventPublisher.append(
            BranchSwitched.make({
              sessionId: input.sessionId,
              fromBranchId: input.fromBranchId,
              toBranchId: input.toBranchId,
            }),
          )
          const result: StoredSwitchBranchResult = {
            sessionId: input.sessionId,
            fromBranchId: input.fromBranchId,
            toBranchId: input.toBranchId,
          }
          if (input.requestId !== undefined) {
            yield* sessionOperationStorage.saveSwitchBranch(input.requestId, result)
          }
          return { envelope, result }
        }),
      )
      if (committed.envelope !== undefined) {
        yield* eventPublisher.deliver(committed.envelope)
      }
    }),

    createChildSession: Effect.fn("SessionMutations.createChildSession")(function* (input) {
      const sessionId = SessionId.make(yield* platform.randomId)
      const branchId = BranchId.make(yield* platform.randomId)
      const now = yield* DateTime.nowAsDate
      const session = new Session({
        id: sessionId,
        name: input.name ?? "child session",
        cwd: input.cwd,
        parentSessionId: input.parentSessionId,
        parentBranchId: input.parentBranchId,
        activeBranchId: branchId,
        createdAt: now,
        updatedAt: now,
      })
      const branch = new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      })
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          yield* sessionStorage.createSession(session)
          yield* branchStorage.createBranch(branch)
          const envelope = yield* eventPublisher.append(
            SessionStarted.make({ sessionId, branchId }),
          )
          return { envelope }
        }),
      )
      yield* eventPublisher.deliver(committed.envelope)
      return { sessionId, branchId }
    }),

    deleteSession: Effect.fn("SessionMutations.deleteSession")(function* (sessionId) {
      yield* deleteSessionCascade(sessionId)
    }),

    deleteBranch: Effect.fn("SessionMutations.deleteBranch")(function* (input) {
      if (input.branchId === input.currentBranchId) {
        return yield* new InvalidStateError({
          message: "Cannot delete the current branch",
          operation: "deleteBranch",
        })
      }
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) {
        return yield* new NotFoundError({
          message: "Current session not found",
          entity: "session",
        })
      }
      if (session.activeBranchId === input.branchId) {
        return yield* new InvalidStateError({
          message: "Cannot delete the active branch",
          operation: "deleteBranch",
        })
      }
      const branch = yield* branchStorage.getBranch(input.branchId)
      if (branch === undefined || branch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({
          message: `Branch "${input.branchId}" not found in current session`,
          entity: "branch",
        })
      }
      yield* validateBranchDeletion(input)
      yield* branchStorage.deleteBranch(input.branchId)
    }),

    deleteMessages: Effect.fn("SessionMutations.deleteMessages")(function* (input) {
      const branch = yield* branchStorage.getBranch(input.branchId)
      if (branch === undefined || branch.sessionId !== input.sessionId) {
        return yield* new NotFoundError({
          message: `Branch "${input.branchId}" not found in current session`,
          entity: "branch",
        })
      }
      yield* validateMessageCursor(input)
      yield* messageStorage.deleteMessages(input.branchId, input.afterMessageId)
    }),

    updateReasoningLevel: Effect.fn("SessionMutations.updateReasoningLevel")(function* (input) {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (session === undefined) {
        return yield* new NotFoundError({ message: "Session not found", entity: "session" })
      }
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            reasoningLevel: input.reasoningLevel,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        SessionSettingsUpdated.make({
          sessionId: input.sessionId,
          reasoningLevel: input.reasoningLevel,
        }),
      )
      return { reasoningLevel: input.reasoningLevel }
    }),
  } satisfies SessionMutationsService
})

export const SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)
