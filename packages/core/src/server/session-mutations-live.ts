import { Predicate, DateTime, Effect, Layer, Option } from "effect"
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
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import {
  SessionRuntime,
  type SendUserMessagePayload,
  type SessionRuntimeError,
} from "../runtime/session-runtime.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import {
  SessionOperationStorage,
  type StoredBranchResult,
  type StoredCreateSessionResult,
  type StoredSwitchBranchResult,
} from "../storage/session-operation-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { type StorageError, makeStorageTransaction } from "../storage/sqlite-storage.js"
import { NotFoundError } from "./errors.js"
import type { CreateSessionInput } from "./transport-contract.js"
import { CurrentWorkspaceId } from "./workspace-rpc.js"

interface CreateBranchResult {
  readonly branchId: BranchId
}

interface CreateSessionResult {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchInput = Parameters<SessionMutationsService["createSessionBranch"]>[0]
type ForkBranchInput = Parameters<SessionMutationsService["forkSessionBranch"]>[0]
type SwitchBranchInput = Parameters<SessionMutationsService["switchActiveBranch"]>[0]
type SessionMutationError = Effect.Error<ReturnType<SessionMutationsService["switchActiveBranch"]>>

const createBranchResult = (operation: StoredBranchResult): CreateBranchResult => ({
  branchId: operation.branchId,
})

const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
  sessionId: operation.sessionId,
  branchId: operation.branchId,
  name: operation.name,
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
  const sessionRuntime = yield* SessionRuntime
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
      if (Predicate.isUndefined(sessionId) || seen.has(sessionId)) continue
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

  const sendInitialPrompt = Effect.fn("SessionMutations.sendInitialPrompt")(function* (
    operation: StoredCreateSessionResult,
    requestId: Option.Option<string>,
  ) {
    if (Predicate.isUndefined(operation.initialPrompt) || operation.initialPrompt.length === 0)
      return
    let message: SendUserMessagePayload = {
      sessionId: operation.sessionId,
      branchId: operation.branchId,
      content: operation.initialPrompt,
    }
    if (Predicate.isNotUndefined(operation.agentOverride)) {
      message = { ...message, agentOverride: operation.agentOverride }
    }
    if (Option.isSome(requestId)) {
      message = { ...message, requestId: `session.create:${requestId.value}:initial` }
    }
    yield* sessionRuntime.sendUserMessage(message)
  })

  const createSession = Effect.fn("SessionMutations.createSession")(function* (
    input: CreateSessionInput,
  ) {
    if (!Predicate.isUndefined(input.requestId)) {
      const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
      if (!Predicate.isUndefined(existing)) {
        yield* sendInitialPrompt(existing, Option.fromUndefinedOr(input.requestId))
        return createSessionResult(existing)
      }
    }

    const sessionId = SessionId.make(yield* platform.randomId)
    if (
      !Predicate.isUndefined(input.parentBranchId) &&
      Predicate.isUndefined(input.parentSessionId)
    ) {
      return yield* new NotFoundError({
        message: "parentBranchId requires parentSessionId",
        entity: "session",
      })
    }
    if (!Predicate.isUndefined(input.parentSessionId)) {
      const parent = yield* sessionStorage.getSession(input.parentSessionId)
      if (Predicate.isUndefined(parent)) {
        return yield* new NotFoundError({
          message: `Parent session not found: ${input.parentSessionId}`,
          entity: "session",
        })
      }
    }
    if (
      !Predicate.isUndefined(input.parentBranchId) &&
      !Predicate.isUndefined(input.parentSessionId)
    ) {
      const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
      if (Predicate.isUndefined(parentBranch) || parentBranch.sessionId !== input.parentSessionId) {
        return yield* new NotFoundError({
          message: `Parent branch not found in parent session: ${input.parentBranchId}`,
          entity: "branch",
        })
      }
    }

    const branchId = BranchId.make(yield* platform.randomId)
    const now = yield* DateTime.nowAsDate
    const name = input.name ?? "New Chat"
    const session = new Session({
      id: sessionId,
      name,
      cwd: input.cwd,
      activeBranchId: branchId,
      parentSessionId: input.parentSessionId,
      parentBranchId: input.parentBranchId,
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
        if (!Predicate.isUndefined(input.requestId)) {
          const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
          if (!Predicate.isUndefined(existing)) return { result: existing }
        }
        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        const envelope = yield* eventPublisher.append(SessionStarted.make({ sessionId, branchId }))
        const result: StoredCreateSessionResult = {
          sessionId,
          branchId,
          name,
          initialPrompt: input.initialPrompt,
          agentOverride: input.agentOverride,
        }
        if (!Predicate.isUndefined(input.requestId)) {
          yield* sessionOperationStorage.saveCreateSession(input.requestId, result)
        }
        return { envelope, result }
      }),
    )
    if (!Predicate.isUndefined(committed.envelope)) {
      yield* eventPublisher.deliver(committed.envelope)
      yield* Effect.logInfo("session.created").pipe(
        Effect.annotateLogs({
          sessionId: committed.result.sessionId,
          branchId: committed.result.branchId,
          requestId: input.requestId,
        }),
      )
    }

    yield* sendInitialPrompt(committed.result, Option.fromUndefinedOr(input.requestId))
    return createSessionResult(committed.result)
  })

  const createSessionBranch = Effect.fn("SessionMutations.createSessionBranch")(function* (
    input: CreateBranchInput,
  ) {
    if (!Predicate.isUndefined(input.requestId)) {
      const existing = yield* sessionOperationStorage.getCreateBranch(input.requestId)
      if (!Predicate.isUndefined(existing)) return createBranchResult(existing)
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
        if (!Predicate.isUndefined(input.requestId)) {
          const existing = yield* sessionOperationStorage.getCreateBranch(input.requestId)
          if (!Predicate.isUndefined(existing)) return { result: existing }
        }
        yield* branchStorage.createBranch(branch)
        const envelope = yield* eventPublisher.append(
          BranchCreated.make({
            sessionId: branch.sessionId,
            branchId: branch.id,
            parentBranchId: branch.parentBranchId,
          }),
        )
        const result: StoredBranchResult = { branchId: branch.id }
        if (!Predicate.isUndefined(input.requestId)) {
          yield* sessionOperationStorage.saveCreateBranch(input.requestId, result)
        }
        return { envelope, result }
      }),
    )
    if (!Predicate.isUndefined(committed.envelope)) {
      yield* eventPublisher.deliver(committed.envelope)
    }
    return createBranchResult(committed.result)
  })

  const forkSessionBranch = Effect.fn("SessionMutations.forkSessionBranch")(function* (
    input: ForkBranchInput,
  ) {
    if (!Predicate.isUndefined(input.requestId)) {
      const existing = yield* sessionOperationStorage.getForkBranch(input.requestId)
      if (!Predicate.isUndefined(existing)) return createBranchResult(existing)
    }

    const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
    if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
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
        if (!Predicate.isUndefined(input.requestId)) {
          const existing = yield* sessionOperationStorage.getForkBranch(input.requestId)
          if (!Predicate.isUndefined(existing)) return { result: existing }
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
            parentBranchId: branch.parentBranchId,
            parentMessageId: branch.parentMessageId,
          }),
        )
        const result: StoredBranchResult = { branchId: branch.id }
        if (!Predicate.isUndefined(input.requestId)) {
          yield* sessionOperationStorage.saveForkBranch(input.requestId, result)
        }
        return { envelope, result }
      }),
    )
    if (!Predicate.isUndefined(committed.envelope)) {
      yield* eventPublisher.deliver(committed.envelope)
    }
    return createBranchResult(committed.result)
  })

  const switchActiveBranch = Effect.fn("SessionMutations.switchActiveBranch")(function* (
    input: SwitchBranchInput,
  ) {
    if (!Predicate.isUndefined(input.requestId)) {
      const existing = yield* sessionOperationStorage.getSwitchBranch(input.requestId)
      if (!Predicate.isUndefined(existing)) return
    }

    const session = yield* sessionStorage.getSession(input.sessionId)
    if (Predicate.isUndefined(session)) {
      return yield* new NotFoundError({
        message: "Current session not found",
        entity: "session",
      })
    }
    const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
    if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
      return yield* new NotFoundError({
        message: `Branch "${input.fromBranchId}" not found in current session`,
        entity: "branch",
      })
    }
    const toBranch = yield* branchStorage.getBranch(input.toBranchId)
    if (Predicate.isUndefined(toBranch) || toBranch.sessionId !== input.sessionId) {
      return yield* new NotFoundError({
        message: `Branch "${input.toBranchId}" not found in current session`,
        entity: "branch",
      })
    }
    const committed = yield* storageTransaction(
      Effect.gen(function* () {
        if (!Predicate.isUndefined(input.requestId)) {
          const existing = yield* sessionOperationStorage.getSwitchBranch(input.requestId)
          if (!Predicate.isUndefined(existing)) return { result: existing }
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
        if (!Predicate.isUndefined(input.requestId)) {
          yield* sessionOperationStorage.saveSwitchBranch(input.requestId, result)
        }
        return { envelope, result }
      }),
    )
    if (!Predicate.isUndefined(committed.envelope)) {
      yield* eventPublisher.deliver(committed.envelope)
    }
  })

  // ── requestId dedup ──
  //
  // Clients generate a `requestId` per mutation so a WS-level retry after an
  // ambiguous failure converges on one durable outcome. Each body also checks
  // the durable operation row, which owns restart/retry correctness; the
  // in-memory cache only collapses concurrent same-process fibers.
  //
  // Dedup is *concurrency-safe*: `RpcServer.layerHttp` runs with
  // `concurrency: "unbounded"` and the client has `retryTransientErrors: true`,
  // so the same requestId can land on two fibers in parallel. `Cache`
  // collapses concurrent same-key lookups via an internal Deferred so the
  // second fiber awaits the first's outcome.
  const keyOf = (input: { readonly requestId?: string }) => Option.fromUndefinedOr(input.requestId)
  const dedupCreateSession = yield* makeRequestDeduper<
    CreateSessionInput,
    CreateSessionResult,
    SessionMutationError | SessionRuntimeError
  >({ body: createSession, keyOf })
  const dedupCreateSessionBranch = yield* makeRequestDeduper<
    CreateBranchInput,
    CreateBranchResult,
    SessionMutationError
  >({ body: createSessionBranch, keyOf })
  const dedupForkSessionBranch = yield* makeRequestDeduper<
    ForkBranchInput,
    CreateBranchResult,
    SessionMutationError
  >({ body: forkSessionBranch, keyOf })
  const dedupSwitchActiveBranch = yield* makeRequestDeduper<
    SwitchBranchInput,
    void,
    SessionMutationError
  >({ body: switchActiveBranch, keyOf })

  return {
    createSession: dedupCreateSession,
    createSessionBranch: dedupCreateSessionBranch,
    forkSessionBranch: dedupForkSessionBranch,
    switchActiveBranch: dedupSwitchActiveBranch,

    renameSession: Effect.fn("SessionMutations.renameSession")(function* (input) {
      const trimmed = input.name.trim().slice(0, 80)
      if (trimmed.length === 0) return { renamed: false }
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) return { renamed: false }
      if (session.name === trimmed) return { renamed: false }
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
      return { renamed: true, name: trimmed }
    }),

    deleteSession: Effect.fn("SessionMutations.deleteSession")(function* (sessionId) {
      yield* deleteSessionCascade(sessionId)
    }),

    updateReasoningLevel: Effect.fn("SessionMutations.updateReasoningLevel")(function* (input) {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) {
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
