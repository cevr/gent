import { DateTime, Deferred, Duration, Effect, Layer, Context, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session, copyMessageToBranch } from "../domain/message.js"
import { messagePartsTextLines } from "../domain/message-part-projection.js"
import type { QueueSnapshot } from "../domain/queue.js"
import type { SteerCommand } from "../domain/steer.js"
import {
  EventStore,
  BranchSwitched,
  BranchCreated,
  BranchSummarized,
  SessionStarted,
  SessionNameUpdated,
  SessionSettingsUpdated,
  type AgentEvent,
  type EventStoreError,
  type EventStoreService,
} from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import {
  SessionOperationStorage,
  type StoredCreateSessionResult,
} from "../storage/session-operation-storage.js"
import type { StorageError } from "../storage/sqlite-storage.js"
import { StorageTransaction } from "../storage/storage-transaction.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { toPrompt } from "../providers/ai-transcript.js"
import * as AiError from "effect/unstable/ai/AiError"
import { ProviderError } from "../domain/provider-error.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { SessionRuntime, type SessionRuntimeService } from "../runtime/session-runtime.js"
import { InvalidStateError, NotFoundError, type AppServiceError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionReasoningLevelInput,
} from "./transport-contract.js"

const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

type CreateSessionResult = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
}

type CreateBranchResult = {
  readonly branchId: BranchId
}

type UpdateSessionReasoningLevelResult = {
  readonly reasoningLevel: UpdateSessionReasoningLevelInput["reasoningLevel"]
}

// Dedup cache: bound success entries by both time and count so a
// long-running shared server does not accumulate one Map entry per user
// prompt + per session create indefinitely.
const DEDUP_SUCCESS_TTL_MS = Duration.seconds(60)
const DEDUP_MAX_ENTRIES = 1024

export const dedupRequest = <A, E>(input: {
  readonly cache: Ref.Ref<Map<string, Deferred.Deferred<A, E>>>
  readonly requestId: string | undefined
  readonly body: Effect.Effect<A, E>
  readonly maxEntries?: number
  readonly successTtl?: Duration.Input
}): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const requestId = input.requestId
    if (requestId === undefined) return yield* input.body
    const maxEntries = input.maxEntries ?? DEDUP_MAX_ENTRIES
    const successTtl = input.successTtl ?? DEDUP_SUCCESS_TTL_MS
    const fresh = yield* Deferred.make<A, E>()
    const claimed = yield* Ref.modify(input.cache, (m) => {
      const existing = m.get(requestId)
      if (existing !== undefined) return [existing, m] as const
      const next = new Map(m)
      // Hard cap: evict oldest insertion-ordered entry once full.
      if (next.size >= maxEntries) {
        const oldest = next.keys().next().value
        if (oldest !== undefined) next.delete(oldest)
      }
      next.set(requestId, fresh)
      return [fresh, next] as const
    })
    if (claimed !== fresh) return yield* Deferred.await(claimed)
    const evictAfterTtl = Effect.gen(function* () {
      yield* Effect.sleep(successTtl)
      yield* Ref.update(input.cache, (m) => {
        if (m.get(requestId) !== fresh) return m
        const next = new Map(m)
        next.delete(requestId)
        return next
      })
    })
    return yield* input.body.pipe(
      Effect.tap((result) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(fresh, result)
          // Detached so retries inside the window can still collapse onto the
          // cached outcome after the request fiber completes.
          yield* Effect.forkDetach(evictAfterTtl)
        }),
      ),
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          yield* Ref.update(input.cache, (m) => {
            const next = new Map(m)
            next.delete(requestId)
            return next
          })
          yield* Deferred.failCause(fresh, cause)
        }),
      ),
    )
  })

const cleanupSessionRuntimeState = Effect.fn("SessionCommands.cleanupSessionRuntimeState")(
  function* (input: {
    readonly sessionId: SessionId
    readonly sessionRuntime: SessionRuntimeService
  }) {
    yield* input.sessionRuntime.terminateSession(input.sessionId).pipe(Effect.orDie)
  },
)

const restoreSessionRuntimeState = Effect.fn("SessionCommands.restoreSessionRuntimeState")(
  function* (input: {
    readonly sessionId: SessionId
    readonly sessionRuntime: SessionRuntimeService
  }) {
    yield* input.sessionRuntime.restoreSession(input.sessionId).pipe(Effect.orDie)
  },
)

const forgetDeletedSessionRuntimeState = Effect.fn(
  "SessionCommands.forgetDeletedSessionRuntimeState",
)(function* (input: { readonly sessionId: SessionId; readonly eventStore: EventStoreService }) {
  yield* input.eventStore.removeSession(input.sessionId)
})

// Common error union for SessionCommands mutations: storage/event errors plus
// the typed business errors surfaced from validation paths.
export type SessionCommandError = StorageError | EventStoreError | NotFoundError | InvalidStateError

// SessionCommands is the RPC-facing surface: dedup-wrapped session creates,
// branch operations with summarization, and session runtime commands. Bodies
// that mutate purely-durable state (rename, child-session create,
// branch/message delete) live on `SessionMutations` (extension surface), so
// there is exactly one implementation of each durable mutation.
export interface SessionCommandsService {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<CreateSessionResult, AppServiceError>
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, SessionCommandError>
  readonly createBranch: (
    input: CreateBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError>
  readonly forkBranch: (
    input: ForkBranchInput,
  ) => Effect.Effect<CreateBranchResult, AppServiceError>
  readonly sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, AppServiceError>
  readonly drainQueuedMessages: (input: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, AppServiceError>
}

const makeSessionMutationsService: Effect.Effect<
  SessionMutationsService,
  never,
  | StorageTransaction
  | EventStore
  | EventPublisher
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | RelationshipStorage
  | SessionRuntime
  | GentPlatform
> = Effect.gen(function* () {
  const storageTransaction = yield* StorageTransaction
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const relationshipStorage = yield* RelationshipStorage
  const eventStore = yield* EventStore
  const eventPublisher = yield* EventPublisher
  const sessionRuntime = yield* SessionRuntime
  const platform = yield* GentPlatform

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    event: AgentEvent,
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storageTransaction.withTransaction(
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
    yield* cleanupSessionRuntimeState({ sessionId, sessionRuntime })
  })

  const restoreSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.restoreSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* restoreSessionRuntimeState({ sessionId, sessionRuntime })
  })

  const forgetDeletedSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.forgetDeletedSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* forgetDeletedSessionRuntimeState({ sessionId, eventStore })
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
      const branch = new Branch({
        id: BranchId.make(yield* platform.randomId),
        sessionId: input.sessionId,
        parentBranchId: input.parentBranchId,
        name: input.name,
        createdAt: yield* DateTime.nowAsDate,
      })
      yield* transactWithEvent(
        branchStorage.createBranch(branch),
        BranchCreated.make({
          sessionId: branch.sessionId,
          branchId: branch.id,
          ...(branch.parentBranchId !== undefined ? { parentBranchId: branch.parentBranchId } : {}),
        }),
      )
      return { branchId: branch.id }
    }),

    forkSessionBranch: Effect.fn("SessionMutations.forkSessionBranch")(function* (input) {
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
      yield* transactWithEvent(
        Effect.gen(function* () {
          yield* branchStorage.createBranch(branch)
          for (const message of messages.slice(0, targetIndex + 1)) {
            yield* messageStorage.createMessage(
              copyMessageToBranch(message, {
                id: MessageId.make(yield* platform.randomId),
                branchId: branch.id,
              }),
            )
          }
        }),
        BranchCreated.make({
          sessionId: branch.sessionId,
          branchId: branch.id,
          ...(branch.parentBranchId !== undefined ? { parentBranchId: branch.parentBranchId } : {}),
          ...(branch.parentMessageId !== undefined
            ? { parentMessageId: branch.parentMessageId }
            : {}),
        }),
      )
      return { branchId: branch.id }
    }),

    switchActiveBranch: Effect.fn("SessionMutations.switchActiveBranch")(function* (input) {
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
      yield* transactWithEvent(
        sessionStorage.updateSession(
          new Session({
            ...session,
            activeBranchId: input.toBranchId,
            updatedAt: yield* DateTime.nowAsDate,
          }),
        ),
        BranchSwitched.make({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
        }),
      )
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
      const committed = yield* storageTransaction.withTransaction(
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

export class SessionCommands extends Context.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
      const storageTransaction = yield* StorageTransaction
      const sessionOperationStorage = yield* SessionOperationStorage
      const sessionRuntime = yield* SessionRuntime
      const eventPublisher = yield* EventPublisher
      const modelResolver = yield* ModelResolver
      const platform = yield* GentPlatform
      // SessionCommands delegates pure-mutation bodies (branch create, branch
      // fork, switch active branch, session/branch/message delete) to
      // SessionMutations so there is exactly one implementation of each. The
      // dedup wrappers below sit *above* the delegation, so retried RPCs still
      // collapse onto a single mutation invocation.
      const mutations = yield* SessionMutations

      // ── requestId dedup ──
      //
      // Clients generate a `requestId` per mutation so a WS-level retry after
      // an ambiguous failure converges on one durable outcome. Session create
      // additionally stores its result in SQLite; the in-memory cache only
      // collapses concurrent same-process fibers while the durable operation
      // table owns restart/retry correctness.
      //
      // Dedup is *concurrency-safe*: `RpcServer.layerHttp` runs with
      // `concurrency: "unbounded"` and the client has
      // `retryTransientErrors: true`, so the same requestId can land on two
      // fibers in parallel. Storing in-flight Deferreds (not completed
      // results) + atomic Ref.modify claim ensures the second fiber waits on
      // the first's outcome instead of racing it.
      //
      const createRequestCache = yield* Ref.make(
        new Map<string, Deferred.Deferred<CreateSessionResult, AppServiceError>>(),
      )
      const sendRequestCache = yield* Ref.make(
        new Map<string, Deferred.Deferred<void, AppServiceError>>(),
      )
      const createBranchRequestCache = yield* Ref.make(
        new Map<string, Deferred.Deferred<CreateBranchResult, AppServiceError>>(),
      )
      const forkBranchRequestCache = yield* Ref.make(
        new Map<string, Deferred.Deferred<CreateBranchResult, AppServiceError>>(),
      )
      const switchBranchRequestCache = yield* Ref.make(
        new Map<string, Deferred.Deferred<void, AppServiceError>>(),
      )

      /**
       * Atomic-claim dedup helper. Concurrent callers with the same
       * `requestId` collapse onto the first caller's outcome.
       *
       * Eviction:
       * - On failure: evict immediately so retries can re-attempt the same
       *   `requestId` under fresh state.
       * - On success: schedule a delayed eviction after `DEDUP_SUCCESS_TTL_MS`.
       *   The window matches the transport retry window — long enough to
       *   collapse a retried RPC, short enough that a long-running server
       *   does not accumulate one entry per user prompt indefinitely.
       * - Hard cap: when the cache exceeds `DEDUP_MAX_ENTRIES`, the
       *   oldest-inserted entry is evicted before insert. JS `Map` preserves
       *   insertion order, so the first key returned by the iterator is the
       *   oldest. This guarantees bounded memory regardless of TTL.
       */
      const summarizeBranch = Effect.fn("SessionCommands.summarizeBranch")(function* (
        branchId: BranchId,
      ) {
        const messages = yield* messageStorage.listMessages(branchId)
        if (messages.length === 0) return ""
        const firstMessage = messages[0]
        if (firstMessage === undefined) return ""

        const conversation = messages
          .slice(-50)
          .map((message) => {
            const text = messagePartsTextLines(message.parts).join("\n")
            return text !== "" ? `${message.role}: ${text}` : ""
          })
          .filter((line) => line.trim().length > 0)
          .join("\n\n")

        if (conversation === "") return ""

        const summaryMessage = Message.Regular.make({
          id: MessageId.make(yield* platform.randomId),
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [
            Prompt.textPart({
              text: `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.\n\nBranch conversation (recent):\n${conversation}`,
            }),
          ],
          createdAt: yield* DateTime.nowAsDate,
        })

        const parts: string[] = []
        yield* Effect.scoped(
          Effect.gen(function* () {
            const model = yield* modelResolver.resolve({
              modelId: NAME_GEN_MODEL,
              hints: { maxTokens: 400 },
            })
            const stream = model.streamText({ prompt: toPrompt([summaryMessage]) }).pipe(
              Stream.mapError(
                (error: unknown) =>
                  new ProviderError({
                    message: AiError.isAiError(error) ? error.message : String(error),
                    model: NAME_GEN_MODEL,
                    cause: error,
                  }),
              ),
            )
            yield* Stream.runForEach(stream, (part) =>
              Effect.sync(() => {
                if (part.type === "text-delta") parts.push(part.delta)
              }),
            )
          }),
        )
        return parts.join("").trim()
      })

      const createSession: (
        input: CreateSessionInput,
      ) => Effect.Effect<CreateSessionResult, AppServiceError> = Effect.fn(
        "SessionCommands.createSession",
      )(function* (input: CreateSessionInput) {
        return yield* dedupRequest({
          cache: createRequestCache,
          requestId: input.requestId,
          body: doCreateSession(input),
        })
      })

      const sendInitialPrompt = Effect.fn("SessionCommands.sendInitialPrompt")(function* (
        operation: StoredCreateSessionResult,
        requestId: string | undefined,
      ) {
        if (operation.initialPrompt === undefined || operation.initialPrompt.length === 0) return
        yield* sessionRuntime.sendUserMessage({
          sessionId: operation.sessionId,
          branchId: operation.branchId,
          content: operation.initialPrompt,
          ...(operation.agentOverride !== undefined
            ? { agentOverride: operation.agentOverride }
            : {}),
          ...(requestId !== undefined ? { requestId: `session.create:${requestId}:initial` } : {}),
        })
      })

      const createSessionResult = (operation: StoredCreateSessionResult): CreateSessionResult => ({
        sessionId: operation.sessionId,
        branchId: operation.branchId,
        name: operation.name,
      })

      const doCreateSession = Effect.fn("SessionCommands.doCreateSession")(function* (
        input: CreateSessionInput,
      ) {
        if (input.requestId !== undefined) {
          const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
          if (existing !== undefined) {
            yield* sendInitialPrompt(existing, input.requestId)
            return createSessionResult(existing)
          }
        }

        const sessionId = SessionId.make(yield* platform.randomId)
        if (input.parentBranchId !== undefined && input.parentSessionId === undefined) {
          return yield* new NotFoundError({
            message: "parentBranchId requires parentSessionId",
            entity: "session",
          })
        }
        if (input.parentSessionId !== undefined) {
          const parent = yield* sessionStorage.getSession(input.parentSessionId)
          if (parent === undefined) {
            return yield* new NotFoundError({
              message: `Parent session not found: ${input.parentSessionId}`,
              entity: "session",
            })
          }
        }
        if (input.parentBranchId !== undefined && input.parentSessionId !== undefined) {
          const parentBranch = yield* branchStorage.getBranch(input.parentBranchId)
          if (parentBranch === undefined || parentBranch.sessionId !== input.parentSessionId) {
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

        const committed = yield* storageTransaction.withTransaction(
          Effect.gen(function* () {
            if (input.requestId !== undefined) {
              const existing = yield* sessionOperationStorage.getCreateSession(input.requestId)
              if (existing !== undefined) return { result: existing }
            }
            yield* sessionStorage.createSession(session)
            yield* branchStorage.createBranch(branch)
            const envelope = yield* eventPublisher.append(
              SessionStarted.make({ sessionId, branchId }),
            )
            const result: StoredCreateSessionResult = {
              sessionId,
              branchId,
              name,
              ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
              ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            }
            if (input.requestId !== undefined) {
              yield* sessionOperationStorage.saveCreateSession(input.requestId, result)
            }
            return { envelope, result }
          }),
        )
        if (committed.envelope !== undefined) {
          yield* eventPublisher.deliver(committed.envelope)
          yield* Effect.logInfo("session.created").pipe(
            Effect.annotateLogs({
              sessionId: committed.result.sessionId,
              branchId: committed.result.branchId,
              ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            }),
          )
        }

        yield* sendInitialPrompt(committed.result, input.requestId)
        return createSessionResult(committed.result)
      })

      const createBranch = Effect.fn("SessionCommands.createBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* dedupRequest({
          cache: createBranchRequestCache,
          requestId: input.requestId,
          body: mutations.createSessionBranch({
            sessionId: input.sessionId,
            ...(input.name !== undefined ? { name: input.name } : {}),
          }),
        })
      })

      const switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.switchBranch")(function* (input: SwitchBranchInput) {
          yield* dedupRequest({
            cache: switchBranchRequestCache,
            requestId: input.requestId,
            body: doSwitchBranch(input),
          })
        })

      const doSwitchBranch = Effect.fn("SessionCommands.doSwitchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        // The summarize side-effect lives on SessionCommands because it
        // depends on model resolution and is intentionally outside the durable
        // mutation tx. Once the (best-effort) summary is published, delegate
        // the actual switch to SessionMutations so there is exactly one
        // implementation of "validate branches + update activeBranchId".
        if (input.summarize !== false && input.fromBranchId !== input.toBranchId) {
          const summary = yield* summarizeBranch(input.fromBranchId).pipe(
            Effect.catchEager(() => Effect.succeed("")),
          )
          if (summary !== "") {
            yield* branchStorage.updateBranchSummary(input.fromBranchId, summary)
            yield* eventPublisher.publish(
              BranchSummarized.make({
                sessionId: input.sessionId,
                branchId: input.fromBranchId,
                summary,
              }),
            )
          }
        }

        yield* mutations.switchActiveBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          toBranchId: input.toBranchId,
        })
      })

      const forkBranch: (
        input: ForkBranchInput,
      ) => Effect.Effect<CreateBranchResult, AppServiceError> = Effect.fn(
        "SessionCommands.forkBranch",
      )(function* (input: ForkBranchInput) {
        return yield* dedupRequest({
          cache: forkBranchRequestCache,
          requestId: input.requestId,
          body: doForkBranch(input),
        })
      })

      const doForkBranch = Effect.fn("SessionCommands.doForkBranch")(function* (
        input: ForkBranchInput,
      ) {
        return yield* mutations.forkSessionBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          ...(input.name !== undefined ? { name: input.name } : {}),
        })
      })

      const sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.sendMessage")(function* (input: SendMessageInput) {
          yield* dedupRequest({
            cache: sendRequestCache,
            requestId: input.requestId,
            body: doSendMessage(input),
          })
        })

      const doSendMessage = Effect.fn("SessionCommands.doSendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* sessionRuntime.sendUserMessage({
          sessionId: input.sessionId,
          branchId: input.branchId,
          content: input.content,
          ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
          ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
        yield* Effect.logInfo("session.messageSent").pipe(
          Effect.annotateLogs({
            sessionId: input.sessionId,
            branchId: input.branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )
      })

      return {
        createSession,
        // SessionEnded is not emitted on delete — FK cascade would immediately
        // remove the persisted event. Delete is destructive and rare. The
        // cascade + runtime-state cleanup live on SessionMutations; this is a
        // thin delegation.
        deleteSession: (sessionId) => mutations.deleteSession(sessionId),
        createBranch,
        switchBranch,
        forkBranch,
        sendMessage,
        steer: (command) => sessionRuntime.steer(command),
        drainQueuedMessages: ({ sessionId, branchId }) =>
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionReasoningLevel: mutations.updateReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)
}
