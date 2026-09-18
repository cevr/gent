import { Predicate, DateTime, Effect, Layer, Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type { SqlClient } from "effect/unstable/sql"
import {
  type AgentEvent,
  BranchCreated,
  BranchSwitched,
  type EventEnvelope,
  EventPublisher,
  EventStore,
  type EventStoreError,
  MessageReceived,
  SessionNameUpdated,
  SessionSettingsUpdated,
  SessionStarted,
} from "../domain/event.js"
import { BranchId, MessageId, type RequestId, SessionId } from "../domain/ids.js"
import {
  Branch,
  Message,
  type RuntimeUserMessageType,
  Session,
  copyMessageToBranch,
} from "../domain/message.js"
import { SessionMutations, type SessionMutationsService } from "../domain/extension.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { AgentLoopSessionGovernance } from "../runtime/agent/agent-loop.session-governance.js"
import { makeRequestDeduper } from "../runtime/request-dedup.js"
import { admitChildSessionDepth } from "../runtime/session-depth.js"
import {
  SessionRuntime,
  type SendUserMessagePayload,
  type SessionRuntimeError,
} from "../runtime/session-runtime.js"
import {
  BranchStorage,
  type DurableOperation,
  DurableOperations,
  makeStorageTransaction,
  MessageStorage,
  RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  type StorageError,
  type StoredBranchResult,
  type StoredCreateSessionResult,
  type StoredSwitchBranchResult,
} from "../storage/storage.js"
import { NotFoundError } from "./errors.js"
import type { CreateSessionInput } from "./transport-contract.js"
import { CurrentWorkspaceId } from "./workspace-rpc.js"

interface CreateSessionResult {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchInput = Parameters<SessionMutationsService["createSessionBranch"]>[0]
type ForkBranchInput = Parameters<SessionMutationsService["forkSessionBranch"]>[0]
type SwitchBranchInput = Parameters<SessionMutationsService["switchActiveBranch"]>[0]
type SessionMutationError = Effect.Error<ReturnType<SessionMutationsService["switchActiveBranch"]>>

const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
  sessionId: operation.sessionId,
  branchId: operation.branchId,
  name: operation.name,
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

  /**
   * Run one mutation once per request id. A retry replays the receipt; the
   * receipt is written in the same transaction as the work, and checked again
   * inside it so two concurrent retries cannot both do the work.
   */
  const eventPublisher = yield* EventPublisher
  const once = <A, E, R>(
    operation: DurableOperation<A>,
    { requestId }: { readonly requestId?: RequestId },
    subject: (result: A) => { readonly sessionId: SessionId; readonly branchId: BranchId },
    work: Effect.Effect<{ readonly envelope: EventEnvelope; readonly result: A }, E, R>,
  ): Effect.Effect<{ readonly result: A; readonly fresh: boolean }, E | StorageError, R> =>
    Effect.gen(function* () {
      if (!Predicate.isUndefined(requestId)) {
        const existing = yield* sessionOperationStorage.getReceipt(operation, requestId)
        if (!Predicate.isUndefined(existing)) return { result: existing, fresh: false }
      }
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          if (!Predicate.isUndefined(requestId)) {
            const existing = yield* sessionOperationStorage.getReceipt(operation, requestId)
            if (!Predicate.isUndefined(existing)) {
              return { result: existing, envelope: Option.none<EventEnvelope>() }
            }
          }
          const committed = yield* work
          if (!Predicate.isUndefined(requestId)) {
            yield* sessionOperationStorage.saveReceipt(
              operation,
              requestId,
              committed.result,
              subject(committed.result),
            )
          }
          return { result: committed.result, envelope: Option.some(committed.envelope) }
        }),
      )
      if (Option.isNone(committed.envelope)) return { result: committed.result, fresh: false }
      yield* eventPublisher.deliver(committed.envelope.value)
      return { result: committed.result, fresh: true }
    })
  const platform = yield* GentPlatform
  const sessionRuntime = yield* SessionRuntime
  const governance = yield* AgentLoopSessionGovernance
  const eventStore = yield* EventStore

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    ...events: ReadonlyArray<AgentEvent>
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storageTransaction(
        Effect.gen(function* () {
          const result = yield* mutation
          const envelopes: Array<EventEnvelope> = []
          for (const event of events) envelopes.push(yield* eventPublisher.append(event))
          return { result, envelopes }
        }),
      )
      for (const envelope of committed.envelopes) yield* eventPublisher.deliver(envelope)
      return committed.result
    })

  const MODEL_CHANGE_MESSAGE_TYPE: RuntimeUserMessageType = "model-change"

  /**
   * A durable user-role line the model reads on its next turn when the
   * session's model changes, so attribution of the turns above stays honest.
   * An effort-only change writes nothing; the TUI keeps the line out of the
   * feed by its `customType`.
   */
  const modelChangeNotice = Effect.fn("SessionMutations.modelChangeNotice")(function* (
    session: Session,
    nextModelId: Option.Option<string>,
  ) {
    const previous = Option.fromUndefinedOr(session.modelId)
    if (Option.getOrUndefined(previous) === Option.getOrUndefined(nextModelId)) {
      return Option.none<Message>()
    }
    if (Predicate.isUndefined(session.activeBranchId)) return Option.none<Message>()
    const name = (model: Option.Option<string>) =>
      Option.getOrElse(model, () => "the default model")
    return Option.some(
      Message.cases.regular.make({
        id: MessageId.make(yield* platform.randomId),
        sessionId: session.id,
        branchId: session.activeBranchId,
        role: "user",
        parts: [
          Prompt.textPart({
            text: `[model changed: the turns above were generated by ${name(previous)}; the session continues with ${name(nextModelId)}]`,
          }),
        ],
        createdAt: yield* DateTime.nowAsDate,
        metadata: { customType: MODEL_CHANGE_MESSAGE_TYPE },
      }),
    )
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

  const cleanupSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    sessionRuntime.terminateSession(sessionId).pipe(Effect.orDie)
  const restoreSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    CurrentWorkspaceId.pipe(
      Effect.flatMap((workspaceId) => governance.clearTerminated(workspaceId, sessionId)),
      Effect.orDie,
    )
  const forgetDeletedSessionRuntimeStateForMutation = (sessionId: SessionId) =>
    eventStore.removeSession(sessionId)

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
    if (Option.isSome(requestId)) {
      message = { ...message, requestId: `session.create:${requestId.value}:initial` }
    }
    yield* sessionRuntime.sendUserMessage(message)
  })

  const createSession = Effect.fn("SessionMutations.createSession")(function* (
    input: CreateSessionInput,
  ) {
    const committed = yield* once(
      DurableOperations.createSession,
      input,
      (result) => result,
      Effect.gen(function* () {
        const sessionId = SessionId.make(yield* platform.randomId)
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          Predicate.isUndefined(input.parentSessionId)
        ) {
          return yield* new NotFoundError({
            message: "parentBranchId requires parentSessionId",
          })
        }
        let parentThread = Option.none<SessionId>()
        if (!Predicate.isUndefined(input.parentSessionId)) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (Predicate.isUndefined(parent)) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
            })
          }
          parentThread = Option.fromNullishOr(parent.threadId)
          yield* admitChildSessionDepth(input.parentSessionId).pipe(
            Effect.provideService(RelationshipStorage, relationshipStorage),
          )
        }
        if (
          !Predicate.isUndefined(input.parentBranchId) &&
          !Predicate.isUndefined(input.parentSessionId)
        ) {
          const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
          if (
            Predicate.isUndefined(parentBranch) ||
            parentBranch.sessionId !== input.parentSessionId
          ) {
            return yield* new NotFoundError({
              message: `Parent branch not found in parent session: ${input.parentBranchId}`,
            })
          }
        }

        const branchId = BranchId.make(yield* platform.randomId)
        const now = yield* DateTime.nowAsDate
        const name = input.name ?? "New Chat"
        // A handoff continues the parent's work, so it stays in the parent's
        // thread. Every other create — including a spawn — starts its own,
        // which storage supplies by defaulting the thread to the session id.
        const session = new Session({
          id: sessionId,
          name,
          cwd: input.cwd,
          activeBranchId: branchId,
          parentSessionId: input.parentSessionId,
          parentBranchId: input.parentBranchId,
          threadId: Option.getOrUndefined(parentThread),
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: branchId,
          sessionId,
          createdAt: now,
        })

        yield* sessionStorage.createSession(session)
        yield* branchStorage.createBranch(branch)
        const envelope = yield* eventPublisher.append(SessionStarted.make({ sessionId, branchId }))
        const result: StoredCreateSessionResult = {
          sessionId,
          branchId,
          name,
          initialPrompt: input.initialPrompt,
        }
        return { envelope, result }
      }),
    )
    if (committed.fresh) {
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
    const committed = yield* once(
      DurableOperations.createBranch,
      input,
      (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
      Effect.gen(function* () {
        const branch = new Branch({
          id: BranchId.make(yield* platform.randomId),
          sessionId: input.sessionId,
          name: input.name,
          createdAt: yield* DateTime.nowAsDate,
        })
        yield* branchStorage.createBranch(branch)
        const envelope = yield* eventPublisher.append(
          BranchCreated.make({
            sessionId: branch.sessionId,
            branchId: branch.id,
            parentBranchId: branch.parentBranchId,
          }),
        )
        const result: StoredBranchResult = { branchId: branch.id }
        return { envelope, result }
      }),
    )
    return committed.result
  })

  const forkSessionBranch = Effect.fn("SessionMutations.forkSessionBranch")(function* (
    input: ForkBranchInput,
  ) {
    const committed = yield* once(
      DurableOperations.forkBranch,
      input,
      (result) => ({ sessionId: input.sessionId, branchId: result.branchId }),
      Effect.gen(function* () {
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({ message: "Branch not found" })
        }

        const messages = yield* messageStorage.listMessages(input.fromBranchId)
        const targetIndex = messages.findIndex((message) => message.id === input.atMessageId)
        if (targetIndex === -1) {
          return yield* new NotFoundError({
            message: "Message not found in branch",
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
        return { envelope, result }
      }),
    )
    return committed.result
  })

  const switchActiveBranch = Effect.fn("SessionMutations.switchActiveBranch")(function* (
    input: SwitchBranchInput,
  ) {
    yield* once(
      DurableOperations.switchBranch,
      input,
      (result) => ({ sessionId: result.sessionId, branchId: result.toBranchId }),
      Effect.gen(function* () {
        const session = yield* sessionStorage.getSession(input.sessionId)
        if (Predicate.isUndefined(session)) {
          return yield* new NotFoundError({
            message: "Current session not found",
          })
        }
        const fromBranch = yield* branchStorage.getBranch(input.fromBranchId)
        if (Predicate.isUndefined(fromBranch) || fromBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({
            message: `Branch "${input.fromBranchId}" not found in current session`,
          })
        }
        const toBranch = yield* branchStorage.getBranch(input.toBranchId)
        if (Predicate.isUndefined(toBranch) || toBranch.sessionId !== input.sessionId) {
          return yield* new NotFoundError({
            message: `Branch "${input.toBranchId}" not found in current session`,
          })
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
        return { envelope, result }
      }),
    )
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
    StoredBranchResult,
    SessionMutationError
  >({ body: createSessionBranch, keyOf })
  const dedupForkSessionBranch = yield* makeRequestDeduper<
    ForkBranchInput,
    StoredBranchResult,
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

    updateSettings: Effect.fn("SessionMutations.updateSettings")(function* (input) {
      const session = yield* sessionStorage.getSession(input.sessionId)
      if (Predicate.isUndefined(session)) {
        return yield* new NotFoundError({ message: "Session not found" })
      }
      const settings = { modelId: input.modelId, reasoningLevel: input.reasoningLevel }
      const notice = yield* modelChangeNotice(session, Option.fromUndefinedOr(input.modelId))
      const updated = new Session({ ...session, ...settings, updatedAt: yield* DateTime.nowAsDate })
      yield* transactWithEvent(
        Effect.gen(function* () {
          yield* sessionStorage.updateSession(updated)
          if (Option.isSome(notice)) yield* messageStorage.createMessage(notice.value)
        }),
        SessionSettingsUpdated.make({ sessionId: input.sessionId, ...settings }),
        ...Option.match(notice, {
          onNone: () => [],
          onSome: (message) => [MessageReceived.make({ message })],
        }),
      )
      return settings
    }),
  } satisfies SessionMutationsService
})

export const SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)
