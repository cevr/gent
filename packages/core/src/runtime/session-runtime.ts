import {
  Predicate,
  Cause,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  type FileSystem,
  type Path,
  type Scope,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Actor } from "effect-encore"
import type { MessageStorage as ClusterMessageStorage, Sharding } from "effect/unstable/cluster"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { SqlClient } from "effect/unstable/sql"
import { AgentName, RunSpecSchema, type SteerCommand as SteerCommandType } from "../domain/agent.js"
import { Message, MessageMetadata, type QueueSnapshot } from "../domain/message.js"
import type { EventPublisher, EventStore } from "../domain/event.js"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  MessageId,
  RequestId,
  SessionId,
  type InteractionRequestId,
} from "../domain/ids.js"
import type { PromptSection } from "../domain/capability.js"
import type {
  AgentLoopQueueStorage,
  BranchStorage,
  EventStorage,
  InteractionStorage,
  MessageStorage,
  SessionOperationStorage,
  SessionStorage,
  ToolCallBindingStorage,
  TurnRecordStorage,
} from "../storage/storage.js"
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
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
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
