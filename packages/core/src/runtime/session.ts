import {
  Cache,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  Option,
  type Path,
  Predicate,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import {
  type EventPublisher,
  EventStore,
  EventStoreError,
  makeEventStore,
} from "../domain/event.js"
import {
  type AgentLoopQueueStorage,
  type BranchStorage,
  EventStorage,
  type EventStorageError,
  type InteractionStorage,
  type MessageStorage,
  RelationshipStorage,
  type SessionOperationStorage,
  SessionStorage,
  type ToolCallBindingStorage,
  type TurnRecordStorage,
} from "../storage/storage.js"
import { omitUndefined } from "../domain/guards.js"
import {
  AgentName,
  DEFAULT_MAX_AGENT_RUN_DEPTH,
  RunSpecSchema,
  SessionDepthLimitError,
  type SteerCommand as SteerCommandType,
} from "../domain/agent.js"
import { NotFoundError } from "../domain/errors.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  type InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
} from "../domain/ids.js"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor } from "effect-encore"
import type { MessageStorage as ClusterMessageStorage, Sharding } from "effect/unstable/cluster"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { SqlClient } from "effect/unstable/sql"
import { Message, MessageMetadata, type QueueSnapshot } from "../domain/message.js"
import type { PromptSection } from "../domain/capability.js"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopLiveActor,
  AgentLoopSessionGovernance,
} from "./agent-loop.js"
import {
  AgentLoopError,
  entityIdOf,
  followUpMessageIdForSource,
  listWorkspaceLoops,
  type SessionRuntimeState,
} from "../domain/agent-loop.js"
import {
  type ApprovalService,
  type DriverRegistry,
  type ExtensionRegistry,
  resolveExistingSessionBranch,
} from "./extension-host.js"
import type { ModelRegistry, ModelResolver } from "./provider.js"
import { GentPlatform } from "./gent-platform.js"
import type { ToolRunner } from "./tools.js"
import type { ConfigService } from "./config.js"
import { CurrentWorkspaceId, type WorkspaceId } from "../server/workspace-rpc.js"

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
  readonly keyOf: (input: In) => Option.Option<string>
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
    const successTtl = Duration.fromInputUnsafe(
      Option.getOrElse(Option.fromUndefinedOr(opts.successTtl), () => DEDUP_SUCCESS_TTL),
    )
    const cache = yield* Cache.makeWith<string, A, E>(
      (key) =>
        Effect.gen(function* () {
          const body = Option.fromUndefinedOr((yield* Ref.get(pending)).get(key))
          if (Option.isNone(body))
            return yield* Effect.die("makeRequestDeduper: missing pending body")
          return yield* body.value
        }),
      {
        capacity: Option.getOrElse(
          Option.fromUndefinedOr(opts.maxEntries),
          () => DEDUP_MAX_ENTRIES,
        ),
        timeToLive: (exit) => {
          if (Exit.isSuccess(exit)) {
            return successTtl
          }
          return Duration.zero
        },
      },
    )
    const run = (input: In) => {
      const key = opts.keyOf(input)
      if (Option.isNone(key)) return opts.body(input)
      const keyValue = key.value
      const body = opts.body(input)
      const remove = Ref.update(pending, (m) => {
        // Only delete if we are still the registered body — a later caller
        // may have already overwritten us, in which case our entry is gone
        // (or about to be removed by that caller's `ensuring`).
        if (m.get(keyValue) !== body) return m
        const next = new Map(m)
        next.delete(keyValue)
        return next
      })
      return Effect.gen(function* () {
        // Always overwrite: same-key concurrent fibers all register their
        // bodies; whichever wins the lookup race determines the outcome that
        // every caller awaits via `Cache.get`. The `requestId` dedup contract
        // assumes idempotency, so any caller's body produces the same result.
        yield* Ref.update(pending, (m) => {
          const next = new Map(m)
          next.set(keyValue, body)
          return next
        })
        return yield* Cache.get(cache, keyValue)
      }).pipe(Effect.ensuring(remove))
    }
    return run
  })

// ── session-depth ───────────────────────────────────────────────────────────

/**
 * Session nesting depth: one computation and one admission rule for every
 * child-session writer. Delegate spawns and compaction handoffs both nest a
 * session under a parent; both go through `admitChildSessionDepth`.
 *
 * @module
 */

/** Compute nesting depth of a session from its persisted parent chain. Root sessions have depth 0. */
export const getSessionDepth = Effect.fn("SessionDepth.getSessionDepth")(function* (
  sessionId: SessionId,
) {
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
  return ancestors.length - 1
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

const SessionRuntimeTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
type SessionRuntimeTarget = typeof SessionRuntimeTarget.Type

/**
 * Client-generated request ID for end-to-end correlation + transport-retry
 * dedup. Bounded so a malicious/buggy client cannot bloat per-server
 * dedup caches keyed on it. Callers in this repo use `crypto.randomUUID()`.
 */
const FollowUpSourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const SendUserMessagePayload = Schema.Struct({
  /**
   * `"admission"` returns once the turn is durably enqueued, without waiting
   * for it to run. Omitted, the call waits for the turn when the caller gave a
   * `requestId`/`commandId` to correlate on, and is fire-and-forget otherwise.
   */
  completion: Schema.optional(Schema.Literals(["admission"])),
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  agentOverride: Schema.optional(AgentName),
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
  /** Client-generated correlation id for end-to-end observability. */
  requestId: Schema.optional(RequestId),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

const QueueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
  /** Start a turn for the item even on a branch with no prior history. */
  wake: Schema.optional(Schema.Boolean),
})
type QueueFollowUpPayload = typeof QueueFollowUpPayload.Type

const DequeueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
})
type DequeueFollowUpPayload = typeof DequeueFollowUpPayload.Type

const ExtensionRequestPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  extensionId: ExtensionId,
  capabilityId: Schema.String,
  input: Schema.Unknown,
})
type ExtensionRequestPayload = typeof ExtensionRequestPayload.Type

const DrainQueuedMessagesPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
type DrainQueuedMessagesPayload = typeof DrainQueuedMessagesPayload.Type

type SessionRuntimeLayerRequirements =
  | ApprovalService
  | Sharding.Sharding
  | ClusterMessageStorage.MessageStorage
  | EventStorage
  | EventStore
  | EventPublisher
  | ExtensionRegistry
  | DriverRegistry
  | ModelRegistry
  | GentPlatform
  | SessionStorage
  | SessionOperationStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | BranchStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ToolRunner
  | ToolCallBindingStorage
  | TurnRecordStorage
  | InteractionStorage
  | ConfigService
  | AgentLoopSessionGovernance
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly steer: (command: SteerCommandType) => Effect.Effect<void, SessionRuntimeError>
  readonly respondInteraction: (
    input: SessionRuntimeTarget & { readonly requestId: InteractionRequestId },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly queueFollowUp: (input: QueueFollowUpPayload) => Effect.Effect<void, SessionRuntimeError>
  /** True when the follow-up left the queue; false when it was absent or already running. */
  readonly dequeueFollowUp: (
    input: DequeueFollowUpPayload,
  ) => Effect.Effect<boolean, SessionRuntimeError>
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
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionExists`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  // The loop already names the concrete failure (an extension refusal, a
  // missing capability); the user needs that text, not the operation name.
  if (Schema.is(AgentLoopError)(inner)) {
    return new SessionRuntimeError({ message: `${message}: ${inner.message}`, cause })
  }
  return new SessionRuntimeError({ message, cause })
}

const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)
const commandIdForRequestId = (requestId: string) => ActorCommandId.make(`message:${requestId}`)

const wrapStreamSessionRuntimeError = (
  operation: string,
  error: Schema.Schema.Type<typeof Schema.Unknown>,
) => {
  if (Schema.is(SessionRuntimeError)(error)) return error
  return new SessionRuntimeError({
    message: `${operation} failed`,
    cause: error,
  })
}

const makeLiveSessionRuntime = Effect.gen(function* () {
  // Resolve the actor client factory once at construction time. Per-method
  // dispatch uses `ActorRef.execute(op)`, which carries no requirement,
  // instead of the `OperationHandle.execute(payload)` form (which would
  // re-introduce the actor client requirement at each call site).
  const actorClientFactory = yield* AgentLoopActor.Context
  const actorControl = yield* AgentLoopActor.Control
  const actorState = yield* AgentLoopActor.State
  const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
    })
  const agentLoopSessionGovernance = yield* AgentLoopSessionGovernance
  const platform = yield* GentPlatform
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

  const toAgentLoopError = (error: Schema.Schema.Type<typeof Schema.Unknown>) => {
    if (Schema.is(AgentLoopError)(error)) return error
    return new AgentLoopError({
      message: "AgentLoop state unavailable",
      cause: error,
    })
  }
  const watchRuntimeState = Effect.fn("SessionRuntime.watchRuntimeState")(function* (
    input: SessionRuntimeTarget,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    return actorState
      .watch(entityIdOf(workspaceId, input.sessionId, input.branchId))
      .pipe(Stream.mapError(toAgentLoopError))
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

  const queueFollowUpThroughActor = Effect.fn("SessionRuntime.queueFollowUpThroughActor")(
    function* (input: QueueFollowUpPayload) {
      const workspaceId = yield* CurrentWorkspaceId
      const message = Message.cases.regular.make({
        id: followUpMessageIdForSource({ workspaceId, ...input }),
        sessionId: input.sessionId,
        branchId: input.branchId,
        role: "user",
        parts: [Prompt.textPart({ text: input.content })],
        createdAt: yield* DateTime.nowAsDate,
        metadata: input.metadata,
      })
      const payload = {
        workspaceId,
        message,
        wake: input.wake,
      }
      const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
      yield* ref.execute(AgentLoopActor.QueueFollowUp.make(payload)).pipe(
        Effect.mapError(
          (cause) =>
            new SessionRuntimeError({
              message: `Failed to queue follow-up ${message.id}`,
              cause,
            }),
        ),
      )
    },
  )

  const redeliverPendingActorMessages = (target: SessionRuntimeTarget) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      yield* actorControl.redeliver(entityIdOf(workspaceId, target.sessionId, target.branchId))
    }).pipe(Effect.ignore)

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
    let commandId: ActorCommandId
    if (Predicate.isNotUndefined(input.commandId)) {
      commandId = input.commandId
    } else if (Predicate.isNotUndefined(input.requestId)) {
      commandId = commandIdForRequestId(input.requestId)
    } else {
      commandId = ActorCommandId.make(yield* platform.randomId)
    }
    const shouldHoldCompletion =
      !Predicate.isUndefined(input.requestId) || !Predicate.isUndefined(input.commandId)
    const messageId = userMessageIdForCommand(commandId)
    const message = Message.cases.regular.make({
      id: messageId,
      sessionId: input.sessionId,
      branchId: input.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: input.content })],
      createdAt: yield* DateTime.nowAsDate,
    })

    const payload = {
      workspaceId: yield* CurrentWorkspaceId,
      message,
      // Actor operation payloads require optional fields explicitly.
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      agentOverride: input.agentOverride,
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      interactive: input.interactive,
      // oxlint-disable-next-line effect/noNullish -- Actor operation payload requires this optional field explicitly.
      runSpec: input.runSpec,
    }
    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    if (input.completion === "admission") {
      yield* ref.execute(AgentLoopActor.SubmitDurable.make(payload))
    } else if (shouldHoldCompletion) {
      yield* ref.execute(AgentLoopActor.SubmitAndWait.make(payload))
    } else {
      yield* ref.execute(AgentLoopActor.Submit.make(payload))
    }
    yield* Effect.logInfo("session-runtime.message.submitted").pipe(
      Effect.annotateLogs({
        sessionId: input.sessionId,
        branchId: input.branchId,
      }),
    )
  })

  return {
    sendUserMessage: (input) =>
      sendUserMessage(input).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("sendUserMessage failed", cause))),
      ),

    // `ref.send` is fire-forget at the handler level — INTENTIONAL.
    // `Steer.Interject` semantics: caller needs to know the steering item
    // is registered (handler enqueue complete), not that the interjected
    // turn ran. Switching to `ref.execute` (or `send + waitFor`) deadlocks
    // because `applySteer` itself yields `ensureStarted` while the gated
    // in-flight turn holds the actor; the persisted reply can't drain.
    // Empirically validated twice: W35-C7.3 (commit `a8b084bc`),
    // re-derived W37-S4-C10 (2026-05-11) — both produced 4s timeout on
    // `tests/runtime/session-runtime.test.ts` ("steer interject interrupts
    // the active turn ahead of queued follow-ups"). Note: `ref.send` does
    // NOT silently drop runtime delivery errors — the discardCall Effect
    // propagates; only statically typed `never`. `Steer.persisted: true`
    // is the durability guarantee (Steer survives crash + redeliver) and
    // is NOT what's being relaxed here.
    steer: (command) =>
      requireSessionBranch(command).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = ActorCommandId.make(command.requestId)
            const payload = {
              workspaceId: yield* CurrentWorkspaceId,
              commandId,
              command,
            }
            const ref = yield* agentLoopActorRefFor(command.sessionId, command.branchId)
            yield* ref.send(AgentLoopActor.Steer.make(payload))
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("steer failed", cause))),
      ),

    respondInteraction: (input) =>
      actorCommand("respondInteraction", input, (ref, { workspaceId }) =>
        ref.execute(AgentLoopActor.RespondInteraction.make({ ...input, workspaceId })),
      ),

    queueFollowUp: (input) =>
      actorCommand("queueFollowUp", input, () => queueFollowUpThroughActor(input)),

    dequeueFollowUp: (input) =>
      actorCommand("dequeueFollowUp", input, (ref, { workspaceId, commandId }) =>
        ref.execute(
          AgentLoopActor.RemoveFollowUp.make({
            workspaceId,
            sessionId: input.sessionId,
            branchId: input.branchId,
            commandId,
            messageId: followUpMessageIdForSource({ workspaceId, ...input }),
          }),
        ),
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
        redeliverPendingActorMessages(input).pipe(
          Effect.andThen(ref.execute(AgentLoopActor.GetQueue.make({ ...input, ...ids }))),
        ),
      ),

    getState: (input) =>
      actorCommand("getState", input, (ref, ids) =>
        ref.execute(AgentLoopActor.GetState.make({ ...input, ...ids })),
      ),

    watchState: (input) =>
      Effect.gen(function* () {
        yield* requireSessionBranch(input)
        return (yield* watchRuntimeState(input)).pipe(
          Stream.mapError((error) => wrapStreamSessionRuntimeError("watchState", error)),
        )
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
  /** Client-only composition lets child runners exist before actor handlers capture services. */
  static readonly Client = Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
    Layer.provideMerge(Actor.toLayer(AgentLoopActor)),
  )
  static Live = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<SessionRuntime, never, SessionRuntimeLayerRequirements> =>
    Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
      // Keep actor support services in the live context. `SessionRuntime`
      // captures actor clients, but the AgentLoop entity manager must remain
      // scoped for those clients to make progress.
      Layer.provideMerge(AgentLoopLiveActor(config)),
    )
}
