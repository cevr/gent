import { DateTime, Deferred, Duration, Effect, Layer, Context, Ref, Stream } from "effect"
import { EventPublisher, type EventPublisherService } from "../domain/event-publisher.js"
import { SessionMutations, type SessionMutationsService } from "../domain/session-mutations.js"
import {
  SessionCwdRegistry,
  type SessionCwdRegistryService,
} from "../runtime/session-cwd-registry.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { Branch, Message, Session, TextPart, copyMessageToBranch } from "../domain/message.js"
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
import { SessionStorage, type SessionStorageService } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { Storage, type StorageError } from "../storage/sqlite-storage.js"
import { Provider, providerRequestFromMessages } from "../providers/provider.js"
import {
  MachineEngine,
  type MachineEngineService,
} from "../runtime/extensions/resource-host/machine-engine.js"
import { SessionProfileCache, type SessionProfileCacheService } from "../runtime/session-profile.js"
import {
  SessionRuntime,
  type SessionRuntimeService,
  applySteerCommand,
  sendUserMessageCommand,
} from "../runtime/session-runtime.js"
import { InvalidStateError, NotFoundError, type AppServiceError } from "./errors.js"
import type {
  CreateBranchInput,
  CreateBranchResult,
  CreateSessionInput,
  CreateSessionResult,
  ForkBranchInput,
  SendMessageInput,
  SwitchBranchInput,
  UpdateSessionReasoningLevelInput,
  UpdateSessionReasoningLevelResult,
} from "./transport-contract.js"

const NAME_GEN_MODEL = "anthropic/claude-haiku-4-5-20251001"

// Dedup cache (W6-29): bound success entries by both time and count so a
// long-running shared server does not accumulate one Map entry per user
// prompt + per session create indefinitely.
const DEDUP_SUCCESS_TTL_MS = Duration.seconds(60)
const DEDUP_MAX_ENTRIES = 1024

interface SessionRuntimeTerminatorService {
  readonly register: (runtime: SessionRuntimeService) => Effect.Effect<void>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void>
}

class SessionRuntimeTerminator extends Context.Service<
  SessionRuntimeTerminator,
  SessionRuntimeTerminatorService
>()("@gent/core/src/server/session-commands/SessionRuntimeTerminator") {
  static Live = Layer.effect(
    SessionRuntimeTerminator,
    Effect.gen(function* () {
      const runtimeRef = yield* Ref.make<SessionRuntimeService | undefined>(undefined)
      const withRuntime = <A>(f: (runtime: SessionRuntimeService) => Effect.Effect<A>) =>
        Effect.gen(function* () {
          const runtime = yield* Ref.get(runtimeRef)
          if (runtime === undefined) return
          yield* f(runtime)
        })

      return {
        register: (runtime) => Ref.set(runtimeRef, runtime),
        terminateSession: (sessionId) =>
          withRuntime((runtime) => runtime.terminateSession(sessionId)),
        restoreSession: (sessionId) => withRuntime((runtime) => runtime.restoreSession(sessionId)),
      } satisfies SessionRuntimeTerminatorService
    }),
  )
}

const terminateSessionMachineRuntime = Effect.fn("SessionCommands.terminateSessionMachineRuntime")(
  function* (input: {
    readonly sessionId: SessionId
    readonly sessionStorage: SessionStorageService
    readonly sessionCwdRegistry: SessionCwdRegistryService
    readonly ambientRuntime: MachineEngineService
    readonly profileCache?: SessionProfileCacheService
  }) {
    // Prefer the in-memory cwd registry: descendants caught by the post-delete
    // cleanup have no durable row to read from, but the registry still holds
    // their cwd until forgetDeletedSessionRuntimeState runs. Per the registry's
    // own contract (session-cwd-registry.ts), `lookup` propagates StorageError
    // on transient failures (fail-closed) — so the caller distinguishes
    // "not found" from "storage failed" and avoids wrong-runtime delivery.
    const cachedCwd = yield* input.sessionCwdRegistry.lookup(input.sessionId)
    const cwd = cachedCwd ?? (yield* input.sessionStorage.getSession(input.sessionId))?.cwd

    const runtime =
      cwd !== undefined && input.profileCache !== undefined
        ? yield* input.profileCache.resolve(cwd).pipe(
            Effect.map((profile) => profile.extensionStateRuntime),
            Effect.catchCause((cause) =>
              Effect.logWarning("session.delete.profileRuntimeLookupFailed").pipe(
                Effect.annotateLogs({
                  sessionId: input.sessionId,
                  cwd,
                  error: String(cause),
                }),
                Effect.as(undefined),
              ),
            ),
          )
        : input.ambientRuntime

    if (runtime === undefined) return

    yield* runtime.terminateAll(input.sessionId).pipe(
      // Session deletion owns cleanup best-effort actor termination, then
      // propagates durable store failures below.
      Effect.catchDefect(() => Effect.void),
    )
  },
)

const cleanupSessionRuntimeState = Effect.fn("SessionCommands.cleanupSessionRuntimeState")(
  function* (input: {
    readonly sessionId: SessionId
    readonly sessionStorage: SessionStorageService
    readonly ambientRuntime: MachineEngineService
    readonly profileCache?: SessionProfileCacheService
    readonly sessionRuntimeTerminator: SessionRuntimeTerminatorService
    readonly eventPublisher: EventPublisherService
    readonly eventStore: EventStoreService
    readonly sessionCwdRegistry: SessionCwdRegistryService
  }) {
    yield* input.sessionRuntimeTerminator.terminateSession(input.sessionId)
    yield* terminateSessionMachineRuntime(input)
  },
)

const restoreSessionRuntimeState = Effect.fn("SessionCommands.restoreSessionRuntimeState")(
  function* (input: {
    readonly sessionId: SessionId
    readonly sessionRuntimeTerminator: SessionRuntimeTerminatorService
  }) {
    yield* input.sessionRuntimeTerminator.restoreSession(input.sessionId)
  },
)

const forgetDeletedSessionRuntimeState = Effect.fn(
  "SessionCommands.forgetDeletedSessionRuntimeState",
)(function* (input: {
  readonly sessionId: SessionId
  readonly eventPublisher: EventPublisherService
  readonly eventStore: EventStoreService
  readonly sessionCwdRegistry: SessionCwdRegistryService
}) {
  yield* input.eventPublisher.terminateSession(input.sessionId)
  yield* input.eventStore.removeSession(input.sessionId)
  yield* input.sessionCwdRegistry.forget(input.sessionId)
})

// Common error union for SessionCommands mutations: storage/event errors plus
// the typed business errors surfaced from validation paths.
export type SessionCommandError = StorageError | EventStoreError | NotFoundError | InvalidStateError

// SessionCommands is the RPC-facing surface: dedup-wrapped session creates,
// branch operations with summarization, and turn-control. Bodies that mutate
// purely-durable state (rename, child-session create, branch/message delete)
// live on `SessionMutations` (extension surface) and SessionCommands delegates
// to it via `mutations.*` so there is exactly one implementation of each
// mutation. The previous "parallel surface" — duplicated handlers on both
// services — was deleted in W7-C5; tests calling `commands.renameSession`
// were migrated to `mutations.renameSession`.
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
  | Storage
  | EventStore
  | EventPublisher
  | SessionStorage
  | BranchStorage
  | MessageStorage
  | MachineEngine
  | SessionCwdRegistry
  | SessionRuntimeTerminator
> = Effect.gen(function* () {
  const storage = yield* Storage
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStore = yield* EventStore
  const eventPublisher = yield* EventPublisher
  const extensionStateRuntime = yield* MachineEngine
  const sessionCwdRegistry = yield* SessionCwdRegistry
  const sessionRuntimeTerminator = yield* SessionRuntimeTerminator
  const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
  const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined

  const transactWithEvent = <A, E, R>(
    mutation: Effect.Effect<A, E, R>,
    event: AgentEvent,
  ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
    Effect.gen(function* () {
      const committed = yield* storage.withTransaction(
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
      const childSessions = yield* storage.getChildSessions(input.sessionId)
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
      const children = yield* storage.getChildSessions(sessionId)
      for (const child of children) {
        queue.push(child.id)
      }
    }

    return sessionIds
  })

  const cleanupSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.cleanupSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* cleanupSessionRuntimeState({
      sessionId,
      sessionStorage,
      ambientRuntime: extensionStateRuntime,
      ...(profileCache !== undefined ? { profileCache } : {}),
      sessionRuntimeTerminator,
      eventPublisher,
      eventStore,
      sessionCwdRegistry,
    })
  })

  const restoreSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.restoreSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* restoreSessionRuntimeState({ sessionId, sessionRuntimeTerminator })
  })

  const forgetDeletedSessionRuntimeStateForMutation = Effect.fn(
    "SessionMutations.forgetDeletedSessionRuntimeState",
  )(function* (sessionId: SessionId) {
    yield* forgetDeletedSessionRuntimeState({
      sessionId,
      eventPublisher,
      eventStore,
      sessionCwdRegistry,
    })
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
        id: BranchId.make(Bun.randomUUIDv7()),
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
        id: BranchId.make(Bun.randomUUIDv7()),
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
                id: MessageId.make(Bun.randomUUIDv7()),
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
      const sessionId = SessionId.make(Bun.randomUUIDv7())
      const branchId = BranchId.make(Bun.randomUUIDv7())
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
      const committed = yield* storage
        .withTransaction(
          Effect.gen(function* () {
            yield* sessionStorage.createSession(session)
            yield* branchStorage.createBranch(branch)
            if (input.cwd !== undefined) {
              yield* sessionCwdRegistry.record(sessionId, input.cwd)
            }
            const envelope = yield* eventPublisher.append(
              SessionStarted.make({ sessionId, branchId }),
            )
            return { envelope }
          }),
        )
        .pipe(Effect.onError(() => sessionCwdRegistry.forget(sessionId)))
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
      const storage = yield* Storage
      const sessionRuntime = yield* SessionRuntime
      const sessionRuntimeTerminator = yield* SessionRuntimeTerminator
      yield* sessionRuntimeTerminator.register(sessionRuntime)
      const eventPublisher = yield* EventPublisher
      const provider = yield* Provider
      const sessionCwdRegistry = yield* SessionCwdRegistry
      // SessionCommands delegates pure-mutation bodies (branch create, branch
      // fork, switch active branch, session/branch/message delete) to
      // SessionMutations so there is exactly one implementation of each. The
      // dedup wrappers below sit *above* the delegation, so retried RPCs still
      // collapse onto a single mutation invocation. The createSession
      // happy-path stays in this module because it co-owns the per-cwd
      // registry pre-record + dedup-cache lifecycle.
      const mutations = yield* SessionMutations

      // ── requestId dedup ──
      //
      // Clients generate a `requestId` per create/send so a WS-level retry
      // after an ambiguous failure converges on a single session/message id
      // instead of forking state. Cache is per-server, in-memory only: the
      // window of ambiguity is the transport retry window (seconds), not
      // cross-process. If the server crashes, the client learns on reconnect.
      //
      // Dedup is *concurrency-safe*: `RpcServer.layerHttp` runs with
      // `concurrency: "unbounded"` and the client has
      // `retryTransientErrors: true`, so the same requestId can land on two
      // fibers in parallel. Storing in-flight Deferreds (not completed
      // results) + atomic Ref.modify claim ensures the second fiber waits on
      // the first's outcome instead of racing it.
      //
      // Note on initialPrompt: the cache only remembers the
      // createSession *outcome*. If createSession returns successfully and
      // the follow-up `sessionRuntime.dispatch(sendUserMessageCommand)`
      // fails asynchronously inside the runtime, a retried create with the
      // same requestId short-circuits to the cached result and does NOT
      // re-send the prompt. The TUI does not pass initialPrompt on create
      // (it sends separately via a dedicated send with its own requestId),
      // so this is an advisory, not an active failure mode.
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
       * Eviction (W6-29):
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
      const dedupRequest = <A, E>(
        cache: Ref.Ref<Map<string, Deferred.Deferred<A, E>>>,
        requestId: string | undefined,
        body: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          if (requestId === undefined) return yield* body
          const fresh = yield* Deferred.make<A, E>()
          const claimed = yield* Ref.modify(cache, (m) => {
            const existing = m.get(requestId)
            if (existing !== undefined) return [existing, m] as const
            const next = new Map(m)
            // Hard cap: evict oldest insertion-ordered entry once full.
            if (next.size >= DEDUP_MAX_ENTRIES) {
              const oldest = next.keys().next().value
              if (oldest !== undefined) next.delete(oldest)
            }
            next.set(requestId, fresh)
            return [fresh, next] as const
          })
          if (claimed !== fresh) return yield* Deferred.await(claimed)
          const evictAfterTtl = Effect.gen(function* () {
            yield* Effect.sleep(DEDUP_SUCCESS_TTL_MS)
            yield* Ref.update(cache, (m) => {
              if (m.get(requestId) !== fresh) return m
              const next = new Map(m)
              next.delete(requestId)
              return next
            })
          })
          return yield* body.pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(fresh, result)
                // Schedule delayed eviction so retries inside the window still
                // collapse onto the cached outcome, but the entry does not
                // survive indefinitely. Detached fork — outlives this call.
                yield* Effect.forkDetach(evictAfterTtl)
              }),
            ),
            Effect.tapCause((cause) =>
              Effect.gen(function* () {
                yield* Ref.update(cache, (m) => {
                  const next = new Map(m)
                  next.delete(requestId)
                  return next
                })
                yield* Deferred.failCause(fresh, cause)
              }),
            ),
          )
        })

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
            const text = message.parts
              .filter((part): part is TextPart => part.type === "text")
              .map((part) => part.text)
              .join("\n")
            return text !== "" ? `${message.role}: ${text}` : ""
          })
          .filter((line) => line.trim().length > 0)
          .join("\n\n")

        if (conversation === "") return ""

        const summaryMessage = Message.Regular.make({
          id: MessageId.make(Bun.randomUUIDv7()),
          sessionId: firstMessage.sessionId,
          branchId,
          role: "user",
          parts: [
            new TextPart({
              type: "text",
              text: `Summarize this branch concisely. Focus on decisions, open questions, and current state. Keep it short and actionable.\n\nBranch conversation (recent):\n${conversation}`,
            }),
          ],
          createdAt: yield* DateTime.nowAsDate,
        })

        const streamEffect = yield* provider.stream(
          providerRequestFromMessages({
            model: NAME_GEN_MODEL,
            messages: [summaryMessage],
            maxTokens: 400,
          }),
        )

        const parts: string[] = []
        yield* Stream.runForEach(streamEffect, (part) =>
          Effect.sync(() => {
            if (part.type === "text-delta") parts.push(part.delta)
          }),
        )
        return parts.join("").trim()
      })

      const transactWithEvent = <A, E, R>(
        mutation: Effect.Effect<A, E, R>,
        event: AgentEvent,
      ): Effect.Effect<A, E | EventStoreError | StorageError, R> =>
        Effect.gen(function* () {
          const committed = yield* storage.withTransaction(
            Effect.gen(function* () {
              const result = yield* mutation
              const envelope = yield* eventPublisher.append(event)
              return { result, envelope }
            }),
          )
          yield* eventPublisher.deliver(committed.envelope)
          return committed.result
        })

      const createSession: (
        input: CreateSessionInput,
      ) => Effect.Effect<CreateSessionResult, AppServiceError> = Effect.fn(
        "SessionCommands.createSession",
      )(function* (input: CreateSessionInput) {
        return yield* dedupRequest(createRequestCache, input.requestId, doCreateSession(input))
      })

      const doCreateSession = Effect.fn("SessionCommands.doCreateSession")(function* (
        input: CreateSessionInput,
      ) {
        const sessionId = SessionId.make(Bun.randomUUIDv7())
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

        const branchId = BranchId.make(Bun.randomUUIDv7())
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

        const committed = yield* storage
          .withTransaction(
            Effect.gen(function* () {
              yield* sessionStorage.createSession(session)
              yield* branchStorage.createBranch(branch)
              // Pre-record the (sessionId → cwd) binding BEFORE the first event
              // publish so the per-cwd EventPublisher router can dispatch the
              // SessionStarted pulse to the right SessionProfile without falling
              // back to a storage read. `input.cwd` is optional in the schema for
              // legacy callers; sessions without a cwd fall through to the
              // server's primary cwd routing in the publisher.
              if (input.cwd !== undefined) {
                yield* sessionCwdRegistry.record(sessionId, input.cwd)
              }
              const envelope = yield* eventPublisher.append(
                SessionStarted.make({ sessionId, branchId }),
              )
              return { envelope }
            }),
          )
          .pipe(Effect.onError(() => sessionCwdRegistry.forget(sessionId)))
        yield* eventPublisher.deliver(committed.envelope)
        yield* Effect.logInfo("session.created").pipe(
          Effect.annotateLogs({
            sessionId,
            branchId,
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )

        // Optional initial prompt — sends immediately after creation
        if (input.initialPrompt !== undefined && input.initialPrompt.length > 0) {
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({
              sessionId,
              branchId,
              content: input.initialPrompt,
              ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
              ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            }),
          )
        }

        const result: CreateSessionResult = { sessionId, branchId, name }
        return result
      })

      const createBranch = Effect.fn("SessionCommands.createBranch")(function* (
        input: CreateBranchInput,
      ) {
        return yield* dedupRequest(
          createBranchRequestCache,
          input.requestId,
          mutations.createSessionBranch({
            sessionId: input.sessionId,
            ...(input.name !== undefined ? { name: input.name } : {}),
          }),
        )
      })

      const switchBranch: (input: SwitchBranchInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.switchBranch")(function* (input: SwitchBranchInput) {
          yield* dedupRequest(switchBranchRequestCache, input.requestId, doSwitchBranch(input))
        })

      const doSwitchBranch = Effect.fn("SessionCommands.doSwitchBranch")(function* (
        input: SwitchBranchInput,
      ) {
        // The summarize side-effect lives on SessionCommands because it
        // depends on `Provider` and is intentionally outside the durable
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
        return yield* dedupRequest(forkBranchRequestCache, input.requestId, doForkBranch(input))
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

      const updateReasoningLevel = Effect.fn("SessionCommands.updateReasoningLevel")(function* (
        input: UpdateSessionReasoningLevelInput,
      ) {
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
      })

      const sendMessage: (input: SendMessageInput) => Effect.Effect<void, AppServiceError> =
        Effect.fn("SessionCommands.sendMessage")(function* (input: SendMessageInput) {
          yield* dedupRequest(sendRequestCache, input.requestId, doSendMessage(input))
        })

      const doSendMessage = Effect.fn("SessionCommands.doSendMessage")(function* (
        input: SendMessageInput,
      ) {
        yield* sessionRuntime.dispatch(
          sendUserMessageCommand({
            sessionId: input.sessionId,
            branchId: input.branchId,
            content: input.content,
            ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
            ...(input.runSpec !== undefined ? { runSpec: input.runSpec } : {}),
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          }),
        )
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
        steer: (command) => sessionRuntime.dispatch(applySteerCommand(command)),
        drainQueuedMessages: ({ sessionId, branchId }) =>
          sessionRuntime
            .drainQueuedMessages({ sessionId, branchId })
            .pipe(Effect.withSpan("SessionCommands.drainQueuedMessages")),
        updateSessionReasoningLevel: updateReasoningLevel,
      } satisfies SessionCommandsService
    }),
  )

  static SessionMutationsLive = Layer.effect(SessionMutations, makeSessionMutationsService)

  static SessionRuntimeTerminatorLive = SessionRuntimeTerminator.Live

  static RegisterSessionRuntimeTerminatorLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const terminator = yield* SessionRuntimeTerminator
      const runtime = yield* SessionRuntime
      yield* terminator.register(runtime)
    }),
  )
}
