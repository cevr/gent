import {
  Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import { EventId, EventStore, EventStoreError, makeEventStore } from "../domain/event.js"
import {
  type BranchStorage,
  EventStorage,
  type EventStorageError,
  RelationshipStorage,
  SessionStorage,
} from "../storage/storage.js"
import { omitUndefined } from "../domain/guards.js"
import { DEFAULT_MAX_AGENT_RUN_DEPTH, SessionDepthLimitError } from "../domain/agent.js"
import { NotFoundError } from "../domain/errors.js"
import {
  ActorCommandId,
  type BranchId,
  type ExtensionId,
  type InteractionRequestId,
  type RequestId,
  type SessionId,
  CurrentWorkspaceId,
  type WorkspaceId,
} from "../domain/ids.js"
import { Actor } from "effect-encore"
import { isSpawnedSession, type QueueSnapshot, type SteerCommand } from "../domain/message.js"
import { AgentLoopSessionGovernance } from "./agent-loop.js"
import {
  AgentLoopError,
  FollowUpQueueFull,
  entityIdOf,
  listWorkspaceLoops,
  type SendUserMessagePayload,
  type SessionRuntimeState,
  steerLoop,
  submitUserMessage,
  type AgentLoopClientServices,
  AgentLoop as AgentLoopActor,
} from "../domain/agent-loop.js"
import { resolveExistingSessionBranch } from "./extension-host.js"
import { GentPlatform } from "./gent-platform.js"

// ── event-store-live ────────────────────────────────────────────────────────

const toEventStoreError =
  (message: string) =>
  (error: EventStorageError): EventStoreError =>
    new EventStoreError({ message, cause: error })

export const EventStoreLive: Layer.Layer<EventStore, never, EventStorage | SessionStorage> =
  Layer.unwrap(
    Effect.gen(function* () {
      const eventStorage = yield* EventStorage
      const sessionStorage = yield* SessionStorage
      const service = yield* makeEventStore({
        append: (event, traceId) =>
          eventStorage
            .appendEvent(event, omitUndefined({ traceId: Option.getOrUndefined(traceId) }))
            .pipe(Effect.mapError(toEventStoreError("Failed to append event"))),
        load: (sessionId, afterId) =>
          eventStorage
            .listEvents({ sessionId, afterId })
            .pipe(Effect.mapError(toEventStoreError("Failed to load session events"))),
        latest: (sessionId, branchId) =>
          eventStorage
            .getLatestEventId(
              Option.match(branchId, {
                onNone: () => ({ sessionId }),
                onSome: (branch) => ({ sessionId, branchId: branch }),
              }),
            )
            .pipe(
              Effect.map((id) => EventId.make(id ?? 0)),
              Effect.mapError(toEventStoreError("Failed to read the latest event id")),
            ),
        open: ({ sessionId, branchId, after }) =>
          Effect.gen(function* () {
            const session = yield* sessionStorage
              .getSession(sessionId)
              .pipe(Effect.mapError(toEventStoreError("Failed to validate session")))
            if (Predicate.isUndefined(session)) {
              return yield* new EventStoreError({ message: `Session not found: ${sessionId}` })
            }
            yield* Effect.logInfo("EventStore.subscribe.open").pipe(
              Effect.annotateLogs({ sessionId, branchId: branchId ?? "all", afterId: after ?? 0 }),
            )
            yield* Effect.addFinalizer(() =>
              Effect.logInfo("EventStore.subscribe.close").pipe(
                Effect.annotateLogs({ sessionId, branchId: branchId ?? "all" }),
              ),
            )
          }),
      })
      return Layer.succeed(EventStore, service)
    }),
  )

// ── request-dedup ───────────────────────────────────────────────────────────

/** A call's place in the in-flight table: it runs the body, or it waits on the call that does. */
interface DedupClaim<A, E> {
  readonly outcome: Deferred.Deferred<A, E>
  readonly runs: boolean
}

/**
 * Collapses concurrent calls with one `requestId` onto one body run: the
 * first call runs the body, and each call that arrives while it runs awaits
 * its outcome. The entry goes when the body ends, so nothing is kept after
 * it. A sequential retry converges on the durable seam its body reads: the
 * operation row of `session.create` and the branch mutations, or, for
 * `message.send`, the user message id its `requestId` names (decided by
 * make-operations-idempotent: a process-local window cannot answer a
 * retry after a restart, and the durable seam answers every retry).
 *
 * If the running call is interrupted, the calls waiting on it end
 * interrupted too, and the client retries.
 */
export const makeRequestDeduper = <In, A, E>(opts: {
  readonly body: (input: In) => Effect.Effect<A, E>
  readonly keyOf: (input: In) => Option.Option<string>
}): Effect.Effect<(input: In) => Effect.Effect<A, E>> =>
  Effect.gen(function* () {
    const inFlight = yield* Ref.make(new Map<string, Deferred.Deferred<A, E>>())
    const run = (input: In) => {
      const key = opts.keyOf(input)
      if (Option.isNone(key)) return opts.body(input)
      const keyValue = key.value
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const own = yield* Deferred.make<A, E>()
          const claim = yield* Ref.modify(
            inFlight,
            (running): readonly [DedupClaim<A, E>, Map<string, Deferred.Deferred<A, E>>] => {
              const current = Option.fromUndefinedOr(running.get(keyValue))
              if (Option.isSome(current)) return [{ outcome: current.value, runs: false }, running]
              const next = new Map(running)
              next.set(keyValue, own)
              return [{ outcome: own, runs: true }, next]
            },
          )
          if (!claim.runs) return yield* restore(Deferred.await(claim.outcome))
          const exit = yield* Effect.exit(restore(opts.body(input)))
          yield* Ref.update(inFlight, (running) => {
            const next = new Map(running)
            next.delete(keyValue)
            return next
          })
          yield* Deferred.done(own, exit)
          return yield* exit
        }),
      )
    }
    return run
  })

// ── session-depth ───────────────────────────────────────────────────────────

/*
 * Session nesting depth: one computation and one admission rule for every
 * child-session writer. `SessionMutations.createSession` spawns a session under
 * a parent (a delegate child, a `/btw` fork) and runs `admitChildSessionDepth`.
 * A handoff (`continueThread`) is not a spawn and is not admitted.
 */

/**
 * Spawn depth of a session: the spawned sessions on its persisted parent
 * chain (`isSpawnedSession`). Root sessions have depth 0. A handoff joins its
 * parent's thread and does not count.
 */
const getSessionDepth = Effect.fn("SessionDepth.getSessionDepth")(function* (sessionId: SessionId) {
  const relationshipStorage = yield* RelationshipStorage
  // Fail closed: an unreadable ancestry is a failure, never a root-level grant.
  const ancestors = yield* relationshipStorage.getSessionAncestors(sessionId)
  const root = ancestors.at(-1)
  if (
    ancestors[0]?.id !== sessionId ||
    Predicate.isUndefined(root) ||
    Predicate.isNotUndefined(root.parentSessionId)
  ) {
    return yield* new NotFoundError({
      message: `Cannot determine session depth for "${sessionId}" — ancestry is missing or incomplete.`,
    })
  }
  return ancestors.filter(isSpawnedSession).length
})

/**
 * Admit one more child under `parentSessionId`. Fails with
 * `SessionDepthLimitError` when the parent already sits at the cap.
 */
export const admitChildSessionDepth = Effect.fn("SessionDepth.admitChildSessionDepth")(function* (
  parentSessionId: SessionId,
) {
  const depth = yield* getSessionDepth(parentSessionId)
  if (depth >= DEFAULT_MAX_AGENT_RUN_DEPTH) {
    return yield* new SessionDepthLimitError({
      message: `Agent run depth limit reached (max ${DEFAULT_MAX_AGENT_RUN_DEPTH}) — parent session "${parentSessionId}" is already at depth ${depth}.`,
      parentSessionId,
      depth,
      max: DEFAULT_MAX_AGENT_RUN_DEPTH,
    })
  }
  return depth
})

// ── session-runtime ─────────────────────────────────────────────────────────

const SESSION_TERMINATION_CONCURRENCY = 16

export class SessionRuntimeError extends Schema.TaggedError<SessionRuntimeError>()(
  "SessionRuntimeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface SessionRuntimeTarget {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

interface ExtensionRequestPayload extends SessionRuntimeTarget {
  readonly extensionId: ExtensionId
  readonly capabilityId: string
  readonly input: unknown
}

interface DrainQueuedMessagesPayload extends SessionRuntimeTarget {
  readonly requestId: RequestId
}

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly steer: (command: SteerCommand) => Effect.Effect<void, SessionRuntimeError>
  readonly respondInteraction: (
    input: SessionRuntimeTarget & { readonly requestId: InteractionRequestId },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly requestExtension: (
    input: ExtensionRequestPayload,
  ) => Effect.Effect<unknown, SessionRuntimeError>
  readonly drainQueuedMessages: (
    input: DrainQueuedMessagesPayload,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getQueuedMessages: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeState, SessionRuntimeError>
  readonly watchState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState, SessionRuntimeError>, SessionRuntimeError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
}

const wrapError = (message: string, cause: Cause.Cause<unknown>) => {
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionBranch`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  // The loop already names the concrete failure (an extension refusal, a
  // missing capability, a full queue); the user needs that text, not the
  // operation name.
  if (Schema.is(AgentLoopError)(inner) || Schema.is(FollowUpQueueFull)(inner)) {
    return new SessionRuntimeError({ message: `${message}: ${inner.message}`, cause })
  }
  return new SessionRuntimeError({ message, cause })
}

const makeLiveSessionRuntime = Effect.gen(function* () {
  // Resolve the actor client factory once at construction time. Per-method
  // dispatch uses `ActorRef.execute(op)`, which carries no requirement,
  // instead of the `OperationHandle.execute(payload)` form (which would
  // re-introduce the actor client requirement at each call site).
  const actorClientFactory = yield* AgentLoopActor.Context
  const actorState = yield* AgentLoopActor.State
  const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
    })
  const agentLoopSessionGovernance = yield* AgentLoopSessionGovernance
  const platform = yield* GentPlatform
  const loopClientServices = yield* Effect.context<AgentLoopClientServices>()
  const storageContext = yield* Effect.context<SessionStorage | BranchStorage>()
  // Every public session-scoped boundary (writes + reads) MUST validate the
  // durable `(sessionId, branchId)` target before proceeding. In-memory
  // tombstones do not survive restart, and branch ids are globally addressable
  // enough that session-only checks hide cross-session mistakes.
  const requireSessionBranch = (target: SessionRuntimeTarget) =>
    resolveExistingSessionBranch(target).pipe(
      Effect.mapError(
        (cause) =>
          new SessionRuntimeError({
            message: cause.message,
            cause,
          }),
      ),
      Effect.provideContext(storageContext),
    )

  const watchRuntimeState = Effect.fn("SessionRuntime.watchRuntimeState")(function* (
    input: SessionRuntimeTarget,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    return actorState.watch(entityIdOf(workspaceId, input.sessionId, input.branchId)).pipe(
      Stream.mapError(
        (cause) =>
          new SessionRuntimeError({
            message: "watchState failed: the loop state is unavailable",
            cause,
          }),
      ),
    )
  })

  const terminateRuntimeSession = Effect.fn("SessionRuntime.terminateRuntimeSession")(function* (
    sessionId: SessionId,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    const branchIds = yield* listWorkspaceLoops({
      workspaceId,
      entityIds: yield* actorState.listEntityIds,
      concurrency: SESSION_TERMINATION_CONCURRENCY,
    }).pipe(
      Effect.map((loops) =>
        loops.filter((loop) => loop.sessionId === sessionId).map((loop) => loop.branchId),
      ),
    )
    yield* Effect.forEach(
      branchIds,
      (branchId) =>
        Effect.gen(function* () {
          const ref = yield* agentLoopActorRefFor(sessionId, branchId)
          yield* ref.execute(
            AgentLoopActor.TerminateBranch.make({
              workspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make(yield* platform.randomId),
            }),
          )
        }).pipe(Effect.ignore),
      { concurrency: SESSION_TERMINATION_CONCURRENCY, discard: true },
    )
  })

  /** One actor command: check the target, address the loop, run, wrap any failure. */
  const actorCommand = <A, E, R>(
    name: string,
    target: SessionRuntimeTarget,
    run: (
      ref: Effect.Success<ReturnType<typeof agentLoopActorRefFor>>,
      ids: { readonly workspaceId: WorkspaceId; readonly commandId: ActorCommandId },
    ) => Effect.Effect<A, E, R>,
  ) =>
    requireSessionBranch(target).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const ref = yield* agentLoopActorRefFor(target.sessionId, target.branchId)
          const workspaceId = yield* CurrentWorkspaceId
          const commandId = ActorCommandId.make(yield* platform.randomId)
          return yield* run(ref, { workspaceId, commandId })
        }),
      ),
      Effect.catchCause((cause) => Effect.fail(wrapError(`${name} failed`, cause))),
    )

  const sendUserMessage = Effect.fn("SessionRuntime.sendUserMessage")(function* (
    input: SendUserMessagePayload,
  ) {
    yield* requireSessionBranch(input)
    yield* submitUserMessage(input).pipe(Effect.provideContext(loopClientServices))
  })

  return {
    sendUserMessage: (input) =>
      sendUserMessage(input).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
      ),

    steer: (command) =>
      requireSessionBranch(command).pipe(
        Effect.andThen(steerLoop(command).pipe(Effect.provideContext(loopClientServices))),
        Effect.catchCause((cause) => Effect.fail(wrapError("steer failed", cause))),
      ),

    respondInteraction: (input) =>
      actorCommand("respondInteraction", input, (ref, { workspaceId }) =>
        ref.execute(AgentLoopActor.RespondInteraction.make({ ...input, workspaceId })),
      ),

    requestExtension: (input) =>
      actorCommand("requestExtension", input, (ref, ids) =>
        ref.execute(
          AgentLoopActor.RequestExtension.make({
            sessionId: input.sessionId,
            branchId: input.branchId,
            extensionId: input.extensionId,
            capabilityId: input.capabilityId,
            input: Option.match(Option.fromUndefinedOr(input.input), {
              onNone: () => ({ _tag: "Missing" }),
              onSome: (value) => ({ _tag: "Present", value }),
            }),
            ...ids,
          }),
        ),
      ),

    // DrainQueue opens the loop itself (`ensureStarted` in its handler),
    // so no priming read is needed first.
    drainQueuedMessages: (input) =>
      actorCommand("drainQueuedMessages", input, (ref, ids) =>
        ref.execute(
          AgentLoopActor.DrainQueue.make({
            ...input,
            workspaceId: ids.workspaceId,
            commandId: ActorCommandId.make(input.requestId),
          }),
        ),
      ),

    getQueuedMessages: (input) =>
      actorCommand("getQueuedMessages", input, (ref, ids) =>
        ref.execute(AgentLoopActor.GetQueue.make({ ...input, ...ids })),
      ),

    getState: (input) =>
      actorCommand("getState", input, (ref, ids) =>
        ref.execute(AgentLoopActor.GetState.make({ ...input, ...ids })),
      ),

    watchState: (input) =>
      Effect.gen(function* () {
        yield* requireSessionBranch(input)
        return yield* watchRuntimeState(input)
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("watchState failed", cause)))),

    terminateSession: (sessionId) =>
      Effect.gen(function* () {
        const workspaceId = yield* CurrentWorkspaceId
        yield* agentLoopSessionGovernance.markTerminated(workspaceId, sessionId)
        yield* terminateRuntimeSession(sessionId)
      }).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("terminateSession failed", cause))),
      ),
  } satisfies SessionRuntimeService
})

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session/SessionRuntime",
) {
  /** Client-only composition: the session runtime exists before actor handlers capture services. */
  static readonly Client = Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
    Layer.provideMerge(Actor.toLayer(AgentLoopActor)),
  )
}
