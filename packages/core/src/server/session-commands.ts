import { Cache, DateTime, Duration, Effect, Exit, Layer, Context, Ref, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SqlClient } from "effect/unstable/sql"
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
} from "../domain/event.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import {
  SessionOperationStorage,
  type StoredBranchResult,
  type StoredCreateSessionResult,
  type StoredSwitchBranchResult,
} from "../storage/session-operation-storage.js"
import { type StorageError, withStorageTransaction } from "../storage/sqlite-storage.js"
import { ModelResolver } from "../providers/model-resolver.js"
import { toPrompt } from "../providers/ai-transcript.js"
import * as AiError from "effect/unstable/ai/AiError"
import { ProviderError } from "../domain/provider-error.js"
import { GentPlatform } from "../runtime/gent-platform.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
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

const createBranchResult = (operation: StoredBranchResult): CreateBranchResult => ({
  branchId: operation.branchId,
})

type UpdateSessionReasoningLevelResult = {
  readonly reasoningLevel: UpdateSessionReasoningLevelInput["reasoningLevel"]
}

// Dedup cache: bound success entries by both time and count so a
// long-running shared server does not accumulate one entry per user
// prompt + per session create indefinitely.
const DEDUP_SUCCESS_TTL: Duration.Input = Duration.seconds(60)
const DEDUP_MAX_ENTRIES = 1024

/**
 * Atomic-claim dedup helper backed by `Cache.makeWith`. Concurrent callers
 * with the same `requestId` collapse onto a single body execution via the
 * Cache's internal `Deferred`.
 *
 * Eviction:
 * - On failure: `timeToLive: Duration.zero` removes the entry immediately so
 *   retries can re-attempt the same `requestId` under fresh state
 *   (Cache.ts:707-710).
 * - On success: TTL window keeps the result available for retries
 *   (Cache.ts:705-708).
 * - Hard cap (LRU): `Cache` re-inserts on read (Cache.ts:524-526) and evicts
 *   the oldest-touched entry past `capacity` (Cache.ts:724-733). Under the
 *   retry-heavy workload this dedup serves, LRU is safe: a fresh same-key
 *   retry observes a still-fresh cache entry; an unrelated stale entry is the
 *   one evicted to make room.
 */
export const makeRequestDeduper = <In, A, E>(opts: {
  readonly body: (input: In) => Effect.Effect<A, E>
  readonly keyOf: (input: In) => string | undefined
  readonly maxEntries?: number
  readonly successTtl?: Duration.Input
}): Effect.Effect<(input: In) => Effect.Effect<A, E>> =>
  Effect.gen(function* () {
    // Body bridge: `Cache.lookup` takes only the key, but each call has a
    // distinct body Effect. Pending stores the body keyed by `requestId`; the
    // running lookup pulls it out on miss. Every caller registers its body
    // and removes it on exit via `Effect.ensuring`, which keeps `pending`
    // free of stale-body leaks under interruption and same-key races.
    const pending = yield* Ref.make(new Map<string, Effect.Effect<A, E>>())
    const successTtl = Duration.fromInputUnsafe(opts.successTtl ?? DEDUP_SUCCESS_TTL)
    const cache = yield* Cache.makeWith<string, A, E>(
      (key) =>
        Effect.gen(function* () {
          const body = (yield* Ref.get(pending)).get(key)
          return yield* body ?? Effect.die("makeRequestDeduper: missing pending body")
        }),
      {
        capacity: opts.maxEntries ?? DEDUP_MAX_ENTRIES,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? successTtl : Duration.zero),
      },
    )
    return (input) => {
      const key = opts.keyOf(input)
      if (key === undefined) return opts.body(input)
      const body = opts.body(input)
      const remove = Ref.update(pending, (m) => {
        // Only delete if we are still the registered body — a later caller
        // may have already overwritten us, in which case our entry is gone
        // (or about to be removed by that caller's `ensuring`).
        if (m.get(key) !== body) return m
        const next = new Map(m)
        next.delete(key)
        return next
      })
      return Effect.gen(function* () {
        // Always overwrite: same-key concurrent fibers all register their
        // bodies; whichever wins the lookup race determines the outcome that
        // every caller awaits via `Cache.get`. The `requestId` dedup contract
        // assumes idempotency, so any caller's body produces the same result.
        yield* Ref.update(pending, (m) => {
          const next = new Map(m)
          next.set(key, body)
          return next
        })
        return yield* Cache.get(cache, key)
      }).pipe(Effect.ensuring(remove))
    }
  })

const cleanupSessionRuntimeState = Effect.fn("SessionCommands.cleanupSessionRuntimeState")(
  function* (sessionId: SessionId) {
    const sessionRuntime = yield* SessionRuntime
    yield* sessionRuntime.terminateSession(sessionId).pipe(Effect.orDie)
  },
)

const restoreSessionRuntimeState = Effect.fn("SessionCommands.restoreSessionRuntimeState")(
  function* (sessionId: SessionId) {
    const sessionRuntime = yield* SessionRuntime
    yield* sessionRuntime.restoreSession(sessionId).pipe(Effect.orDie)
  },
)

const forgetDeletedSessionRuntimeState = Effect.fn(
  "SessionCommands.forgetDeletedSessionRuntimeState",
)(function* (sessionId: SessionId) {
  const eventStore = yield* EventStore
  yield* eventStore.removeSession(sessionId)
})

// Common error union for SessionCommands mutations: storage/event errors plus
// the typed business errors surfaced from validation paths.
export type SessionCommandError = StorageError | EventStoreError | NotFoundError | InvalidStateError

// SessionCommands is the RPC-facing surface: dedup-wrapped session creates,
// branch operations with summarization, and session runtime commands. Bodies
// that mutate purely-durable state (rename, child-session create,
// branch/message delete) live on `SessionMutations`, an internal RPC-facing
// service shared with this module so there is exactly one implementation of
// each durable mutation. Extensions do not see this surface.
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
    requestId: string
  }) => Effect.Effect<QueueSnapshot, AppServiceError>
  readonly updateSessionReasoningLevel: (
    input: UpdateSessionReasoningLevelInput,
  ) => Effect.Effect<UpdateSessionReasoningLevelResult, AppServiceError>
}

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
  | GentPlatform
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const storageTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withStorageTransaction(sql, effect)
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const relationshipStorage = yield* RelationshipStorage
  const sessionOperationStorage = yield* SessionOperationStorage
  const eventPublisher = yield* EventPublisher
  const platform = yield* GentPlatform
  const sessionRuntimeContext = yield* Effect.context<SessionRuntime | EventStore>()

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

export class SessionCommands extends Context.Service<SessionCommands, SessionCommandsService>()(
  "@gent/core/src/server/session-commands/SessionCommands",
) {
  static Live = Layer.effect(
    SessionCommands,
    Effect.gen(function* () {
      const sessionStorage = yield* SessionStorage
      const branchStorage = yield* BranchStorage
      const messageStorage = yield* MessageStorage
      const sql = yield* SqlClient.SqlClient
      const storageTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        withStorageTransaction(sql, effect)
      const sessionOperationStorage = yield* SessionOperationStorage
      const sessionRuntime = yield* SessionRuntime
      const eventPublisher = yield* EventPublisher
      const modelResolver = yield* ModelResolver
      const platform = yield* GentPlatform
      // SessionCommands delegates pure-mutation bodies that do not carry RPC
      // request IDs to SessionMutations. Request-id-bearing branch operations
      // stay here so their durable operation row can be written in the same
      // transaction as the branch/session mutation and appended event.
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
      // fibers in parallel. `Cache` collapses concurrent same-key lookups via
      // an internal Deferred so the second fiber awaits the first's outcome.
      //
      const dedupCreateSession = yield* makeRequestDeduper<
        CreateSessionInput,
        CreateSessionResult,
        AppServiceError
      >({ body: (input) => doCreateSession(input), keyOf: (input) => input.requestId })
      const dedupSendMessage = yield* makeRequestDeduper<SendMessageInput, void, AppServiceError>({
        body: (input) => doSendMessage(input),
        keyOf: (input) => input.requestId,
      })
      const dedupCreateBranch = yield* makeRequestDeduper<
        CreateBranchInput,
        CreateBranchResult,
        AppServiceError
      >({ body: (input) => doCreateBranch(input), keyOf: (input) => input.requestId })
      const dedupForkBranch = yield* makeRequestDeduper<
        ForkBranchInput,
        CreateBranchResult,
        AppServiceError
      >({ body: (input) => doForkBranch(input), keyOf: (input) => input.requestId })
      const dedupSwitchBranch = yield* makeRequestDeduper<SwitchBranchInput, void, AppServiceError>(
        { body: (input) => doSwitchBranch(input), keyOf: (input) => input.requestId },
      )

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
        return yield* dedupCreateSession(input)
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

        const committed = yield* storageTransaction(
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
        return yield* dedupCreateBranch(input)
      })

      const doCreateBranch = Effect.fn("SessionCommands.doCreateBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* mutations.createSessionBranch({
          sessionId: input.sessionId,
          name: input.name,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.switchBranch")(function* (input: SwitchBranchInput) {
          yield* dedupSwitchBranch(input)
        })

      const doSwitchBranch = Effect.fn("SessionCommands.doSwitchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        // The summarize side-effect lives on SessionCommands because it
        // depends on model resolution and is intentionally outside the durable
        // mutation tx.
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
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const forkBranch: (
        input: ForkBranchInput,
      ) => Effect.Effect<CreateBranchResult, AppServiceError> = Effect.fn(
        "SessionCommands.forkBranch",
      )(function* (input: ForkBranchInput) {
        return yield* dedupForkBranch(input)
      })

      const doForkBranch = Effect.fn("SessionCommands.doForkBranch")(function* (
        input: ForkBranchInput,
      ) {
        return yield* mutations.forkSessionBranch({
          sessionId: input.sessionId,
          fromBranchId: input.fromBranchId,
          atMessageId: input.atMessageId,
          name: input.name,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        })
      })

      const sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.sendMessage")(function* (input: SendMessageInput) {
          yield* dedupSendMessage(input)
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
        drainQueuedMessages: ({ sessionId, branchId, requestId }) =>
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId, requestId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionReasoningLevel: mutations.updateReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)
}
