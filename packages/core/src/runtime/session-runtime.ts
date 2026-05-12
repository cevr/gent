import { Cause, Context, DateTime, Effect, Layer, Option, Schema, Stream, type Scope } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { MessageStorage as ClusterMessageStorage, Sharding } from "effect/unstable/cluster"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { SqlClient } from "effect/unstable/sql"
import { ActorAddressResolver, ActorStateRegistry } from "effect-encore"
import { AgentRunError, RunSpecSchema, type RunSpec, AgentName } from "../domain/agent.js"
import type { QueueSnapshot } from "../domain/queue.js"
import { AgentRestarted, ErrorOccurred, EventStore } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  ActorCommandId,
  BranchId,
  MessageId,
  RequestId,
  SessionId,
  type InteractionRequestId,
} from "../domain/ids.js"
import { Message, MessageMetadata } from "../domain/message.js"
import type { PromptSection } from "../domain/prompt.js"
import type { AgentLoopQueueStorage } from "../storage/agent-loop-queue-storage.js"
import type { BranchStorage } from "../storage/branch-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import type { MessageStorage } from "../storage/message-storage.js"
import type { SessionStorage } from "../storage/session-storage.js"
import { ModelId } from "../domain/model.js"
import { AgentLoop as AgentLoopActor, AgentLoopLiveActor } from "./agent/agent-loop.actor.js"
import { entityIdOf, parseEntityId } from "./agent/agent-loop.entity-id.js"
import { AgentLoopSessionGovernance } from "./agent/agent-loop.session-governance.js"
import type { ExtensionRegistry } from "./extensions/registry.js"
import type { DriverRegistry } from "./extensions/driver-registry.js"
import type { ModelRegistry } from "./model-registry.js"
import type { ModelResolver } from "../providers/model-resolver.js"
import { GentPlatform } from "./gent-platform.js"
import type { ToolRunner } from "./agent/tool-runner.js"
import type { ResourceManager } from "./resource-manager.js"
import type { ConfigService } from "./config-service.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"
import type { SteerCommand as SteerCommandType } from "../domain/steer.js"
import { resolveExistingSessionBranch } from "./session-runtime-context.js"
import {
  AgentLoopError,
  SessionRuntimeStateSchema,
  type SessionRuntimeState,
} from "./agent/agent-loop.state.js"
export { SessionRuntimeStateSchema, type SessionRuntimeState }

export class SessionRuntimeError extends Schema.TaggedErrorClass<SessionRuntimeError>()(
  "SessionRuntimeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const SessionRuntimeErrorSchema = SessionRuntimeError

export const SessionRuntimeTarget = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
})
export type SessionRuntimeTarget = typeof SessionRuntimeTarget.Type

/**
 * Client-generated request ID for end-to-end correlation + transport-retry
 * dedup. Bounded so a malicious/buggy client cannot bloat per-server
 * dedup caches keyed on it. Callers in this repo use `crypto.randomUUID()`.
 */
const FollowUpSourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const SendUserMessagePayload = Schema.Struct({
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

export const CancelInterruptPayload = Schema.TaggedStruct("Cancel", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type CancelInterruptPayload = typeof CancelInterruptPayload.Type

export const InterruptTurnPayload = Schema.TaggedStruct("Interrupt", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type InterruptTurnPayload = typeof InterruptTurnPayload.Type

export const InterjectPayload = Schema.TaggedStruct("Interject", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
  message: Schema.String,
})
export type InterjectPayload = typeof InterjectPayload.Type

export const InterruptPayload = Schema.Union([
  CancelInterruptPayload,
  InterruptTurnPayload,
  InterjectPayload,
]).pipe(Schema.toTaggedUnion("_tag"))
export type InterruptPayload = typeof InterruptPayload.Type

export const RunPromptPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  agentName: AgentName,
  prompt: Schema.String,
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
})
export type RunPromptPayload = typeof RunPromptPayload.Type

export const QueueFollowUpPayload = Schema.Struct({
  sourceId: FollowUpSourceIdSchema,
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
})
export type QueueFollowUpPayload = typeof QueueFollowUpPayload.Type

export const DrainQueuedMessagesPayload = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  requestId: RequestId,
})
export type DrainQueuedMessagesPayload = typeof DrainQueuedMessagesPayload.Type

export const SessionRuntimeSessionTarget = Schema.Struct({
  sessionId: SessionId,
})
export type SessionRuntimeSessionTarget = typeof SessionRuntimeSessionTarget.Type

export const SessionRuntimeMetrics = Schema.Struct({
  turns: Schema.Number,
  tokens: Schema.Number,
  toolCalls: Schema.Number,
  retries: Schema.Number,
  durationMs: Schema.Number,
  /** Cumulative USD cost: sum of `StreamEnded.costUsd` across the session's
   * event log. Cost is frozen into each event at emit time against the
   * pricing snapshot available then, so replays always sum to the same
   * total regardless of later registry refreshes. */
  costUsd: Schema.Number,
  /** Input-tokens reported by the most recent `StreamEnded` (for "how close
   * to the context window are we right now" — sums don't answer that). */
  lastInputTokens: Schema.Number,
  /** Model id reported by the most recent `StreamEnded` (drives the model
   * name label in the TUI). `undefined` until the first stream ends. */
  lastModelId: Schema.optional(ModelId),
})
export type SessionRuntimeMetrics = typeof SessionRuntimeMetrics.Type

type SessionRuntimeLayerRequirements =
  | Sharding.Sharding
  | ClusterMessageStorage.MessageStorage
  | ActorStateRegistry
  | EventStorage
  | EventStore
  | EventPublisher
  | ExtensionRegistry
  | DriverRegistry
  | ModelRegistry
  | GentPlatform
  | SessionStorage
  | MessageStorage
  | AgentLoopQueueStorage
  | BranchStorage
  | SqlClient.SqlClient
  | ModelResolver
  | ToolRunner
  | ResourceManager
  | ConfigService
  | ChildProcessSpawner
  | Scope.Scope

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly steer: (command: SteerCommandType) => Effect.Effect<void, SessionRuntimeError>
  readonly respondInteraction: (
    input: SessionRuntimeTarget & { readonly requestId: InteractionRequestId },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly runPrompt: (input: RunPromptPayload) => Effect.Effect<void, AgentRunError>
  readonly queueFollowUp: (input: QueueFollowUpPayload) => Effect.Effect<void, SessionRuntimeError>
  readonly drainQueuedMessages: (
    input: DrainQueuedMessagesPayload,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getQueuedMessages: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getMetrics: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeMetrics, SessionRuntimeError>
  readonly watchState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState, SessionRuntimeError>, SessionRuntimeError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
}

const wrapError = (message: string, cause: Cause.Cause<unknown>) => {
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionExists`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  return new SessionRuntimeError({ message, cause })
}

const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)
const followUpMessageIdForSource = (input: {
  readonly workspaceId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly sourceId: string
}) =>
  MessageId.make(
    `follow-up:${input.workspaceId}:${input.sessionId}:${input.branchId}:${input.sourceId}`,
  )
const commandIdForRequestId = (requestId: string) => ActorCommandId.make(`message:${requestId}`)

const wrapStreamSessionRuntimeError = (operation: string, error: unknown) =>
  Schema.is(SessionRuntimeError)(error)
    ? error
    : new SessionRuntimeError({
        message: `${operation} failed`,
        cause: error,
      })

interface RunPromptInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName: AgentName
  readonly prompt: string
  readonly interactive?: boolean
  readonly runSpec?: RunSpec
}

const makeLiveSessionRuntime = Effect.gen(function* () {
  // Resolve the actor client factory once at construction time. Per-method
  // dispatch uses `ActorRef.execute(op)`, which carries no requirement,
  // instead of the `OperationHandle.execute(payload)` form (which would
  // re-introduce the actor client requirement at each call site).
  const actorClientFactory = yield* AgentLoopActor.Context
  const actorAddressResolver = yield* ActorAddressResolver
  const actorStateRegistry = yield* ActorStateRegistry
  const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
    })
  const sharding = yield* Sharding.Sharding
  const clusterMessageStorage = yield* ClusterMessageStorage.MessageStorage
  const eventStorage = yield* EventStorage
  const eventStore = yield* EventStore
  const eventPublisher = yield* EventPublisher
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

  const actorContext = Context.empty().pipe(
    Context.add(ActorAddressResolver, actorAddressResolver),
    Context.add(ActorStateRegistry, actorStateRegistry),
    Context.add(AgentLoopActor.Context, actorClientFactory),
    Context.add(ClusterMessageStorage.MessageStorage, clusterMessageStorage),
    Context.add(Sharding.Sharding, sharding),
  )
  const provideActorStateServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, actorContext)
  const provideActorStateServicesToStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    Stream.provideContext(stream, actorContext)
  const toAgentLoopError = (error: unknown) =>
    Schema.is(AgentLoopError)(error)
      ? error
      : new AgentLoopError({
          message: "AgentLoop state unavailable",
          cause: error,
        })
  const waitForTurnCompleted = (target: SessionRuntimeTarget & { readonly messageId: MessageId }) =>
    eventStore.subscribe({ sessionId: target.sessionId, branchId: target.branchId }).pipe(
      Stream.filter(
        (envelope) =>
          envelope.event._tag === "TurnCompleted" && envelope.event.messageId === target.messageId,
      ),
      Stream.runHead,
      Effect.flatMap((completed) =>
        Option.isSome(completed)
          ? Effect.void
          : Effect.fail(
              new SessionRuntimeError({
                message: `Turn completion stream ended: ${target.sessionId}/${target.branchId}/${target.messageId}`,
              }),
            ),
      ),
      Effect.mapError((cause) =>
        Schema.is(SessionRuntimeError)(cause)
          ? cause
          : new SessionRuntimeError({
              message: "Failed to wait for turn completion",
              cause,
            }),
      ),
    )
  const runPromptThroughActor = Effect.fn("SessionRuntime.runPromptThroughActor")(function* (
    input: RunPromptInput,
  ) {
    const userMessage = Message.cases.regular.make({
      id: MessageId.make(yield* platform.randomId),
      sessionId: input.sessionId,
      branchId: input.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: input.prompt })],
      createdAt: yield* DateTime.nowAsDate,
    })

    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    return yield* ref
      .execute(
        AgentLoopActor.Run.make({
          workspaceId: yield* CurrentWorkspaceId,
          message: userMessage,
          agentOverride: input.agentName,
          runSpec: input.runSpec,
          interactive: input.interactive,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AgentRunError({
              message: cause.message,
              cause,
            }),
        ),
      )
  })

  const watchRuntimeState = Effect.fn("SessionRuntime.watchRuntimeState")(function* (
    input: SessionRuntimeTarget,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    return provideActorStateServicesToStream(
      AgentLoopActor.watchState(entityIdOf(workspaceId, input.sessionId, input.branchId)).pipe(
        Stream.mapError(toAgentLoopError),
      ),
    )
  })

  const terminateRuntimeSession = Effect.fn("SessionRuntime.terminateRuntimeSession")(function* (
    sessionId: SessionId,
  ) {
    const workspaceId = yield* CurrentWorkspaceId
    const branchIds = yield* provideActorStateServices(
      AgentLoopActor.listStateEntityIds().pipe(
        Effect.flatMap((entityIds) =>
          Effect.forEach(entityIds, (entityId) => parseEntityId(entityId).pipe(Effect.option), {
            concurrency: "unbounded",
          }),
        ),
        Effect.map((targets) =>
          targets.flatMap((target) =>
            Option.isSome(target) &&
            target.value.workspaceId === workspaceId &&
            target.value.sessionId === sessionId
              ? [target.value.branchId]
              : [],
          ),
        ),
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
      { concurrency: "unbounded", discard: true },
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
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })
      const payload = {
        workspaceId,
        message,
        agentOverride: undefined,
        runSpec: undefined,
        interactive: undefined,
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
      yield* AgentLoopActor.redeliver(entityIdOf(workspaceId, target.sessionId, target.branchId))
    }).pipe(provideActorStateServices, Effect.ignore)

  const sendUserMessage = Effect.fn("SessionRuntime.sendUserMessage")(function* (
    input: SendUserMessagePayload,
  ) {
    yield* requireSessionBranch(input)
    const commandId =
      input.commandId ??
      (input.requestId !== undefined
        ? commandIdForRequestId(input.requestId)
        : ActorCommandId.make(yield* platform.randomId))
    const shouldHoldCompletion = input.requestId !== undefined || input.commandId !== undefined
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
      agentOverride: input.agentOverride,
      interactive: input.interactive,
      runSpec: input.runSpec,
    }
    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    const reportSubmissionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      return Effect.gen(function* () {
        if (Cause.hasDies(cause)) {
          yield* eventPublisher.publish(
            AgentRestarted.make({
              sessionId: input.sessionId,
              branchId: input.branchId,
              attempt: 0,
              error: Cause.pretty(cause),
            }),
          )
        }
        yield* eventPublisher.publish(
          ErrorOccurred.make({
            sessionId: input.sessionId,
            branchId: input.branchId,
            error: Cause.pretty(cause),
          }),
        )
        yield* Effect.logWarning("agent loop submission failed").pipe(
          Effect.annotateLogs({ error: Cause.pretty(cause) }),
        )
      }).pipe(
        Effect.catchCause((diagnosticCause) =>
          Effect.logWarning("agent loop submission failure diagnostics failed").pipe(
            Effect.annotateLogs({
              error: Cause.pretty(diagnosticCause),
              originalError: Cause.pretty(cause),
            }),
            Effect.catchEager(() => Effect.void),
          ),
        ),
      )
    }
    if (shouldHoldCompletion) {
      yield* provideActorStateServices(
        ref.execute(AgentLoopActor.SubmitDurable.make(payload)).pipe(
          Effect.andThen(
            waitForTurnCompleted({
              sessionId: input.sessionId,
              branchId: input.branchId,
              messageId,
            }),
          ),
          Effect.tapCause(reportSubmissionFailure),
        ),
      )
    } else {
      yield* provideActorStateServices(
        ref
          .execute(AgentLoopActor.Submit.make(payload))
          .pipe(Effect.tapCause(reportSubmissionFailure)),
      )
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
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            const payload = AgentLoopActor.RespondInteraction.make({
              ...input,
              workspaceId: yield* CurrentWorkspaceId,
            })
            yield* ref.send(payload)
            yield* redeliverPendingActorMessages(input)
            yield* provideActorStateServices(AgentLoopActor.RespondInteraction.waitFor(payload))
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("respondInteraction failed", cause))),
      ),

    runPrompt: (input: RunPromptInput) =>
      runPromptThroughActor(input).pipe(
        Effect.mapError(
          (cause) =>
            new AgentRunError({
              message: cause.message,
              cause,
            }),
        ),
      ),

    queueFollowUp: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() => queueFollowUpThroughActor(input)),
        Effect.catchCause((cause) => Effect.fail(wrapError("queueFollowUp failed", cause))),
      ),

    drainQueuedMessages: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = ActorCommandId.make(input.requestId)
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.DrainQueue.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
                commandId,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("drainQueuedMessages failed", cause))),
      ),

    getQueuedMessages: (input) =>
      requireSessionBranch(input).pipe(
        Effect.andThen(redeliverPendingActorMessages(input)),
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            return yield* ref.execute(
              AgentLoopActor.GetQueue.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
                commandId: ActorCommandId.make(yield* platform.randomId),
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("getQueuedMessages failed", cause))),
      ),

    getMetrics: (input) =>
      Effect.gen(function* () {
        yield* requireSessionBranch(input)
        const envelopes = yield* eventStorage
          .listEvents({ sessionId: input.sessionId, branchId: input.branchId })
          .pipe(Effect.catchEager(() => Effect.succeed([])))
        let turns = 0
        let tokens = 0
        let toolCalls = 0
        let retries = 0
        let durationMs = 0
        let costUsd = 0
        let lastInputTokens = 0
        let lastModelId: ModelId | undefined
        for (const { event } of envelopes) {
          switch (event._tag) {
            case "TurnCompleted":
              turns++
              durationMs += event.durationMs
              break
            case "StreamEnded":
              if (event.usage !== undefined) {
                tokens += event.usage.inputTokens + event.usage.outputTokens
                lastInputTokens = event.usage.inputTokens
              }
              if (event.costUsd !== undefined) {
                costUsd += event.costUsd
              }
              if (event.model !== undefined) {
                lastModelId = event.model
              }
              break
            case "ToolCallStarted":
              toolCalls++
              break
            case "ProviderRetrying":
              retries++
              break
          }
        }
        return {
          turns,
          tokens,
          toolCalls,
          retries,
          durationMs,
          costUsd,
          lastInputTokens,
          ...(lastModelId !== undefined ? { lastModelId } : {}),
        } satisfies SessionRuntimeMetrics
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getMetrics failed", cause)))),

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

    restoreSession: (sessionId) =>
      Effect.gen(function* () {
        const workspaceId = yield* CurrentWorkspaceId
        yield* agentLoopSessionGovernance.clearTerminated(workspaceId, sessionId)
      }),
  } satisfies SessionRuntimeService
})

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<SessionRuntime, never, SessionRuntimeLayerRequirements> => {
    const live = Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
      // Keep actor support services in the live context. `SessionRuntime`
      // captures actor clients, but the AgentLoop entity manager must remain
      // scoped for those clients to make progress.
      Layer.provideMerge(AgentLoopLiveActor(config)),
      // `AgentLoopSessionGovernance` is a runtime-internal shared service.
      // Encore owns actor state registration; session governance remains a
      // Gent policy boundary shared by the facade and actor handler.
      Layer.provideMerge(AgentLoopSessionGovernance.Live),
    )
    return live as Layer.Layer<SessionRuntime, never, SessionRuntimeLayerRequirements>
  }
}
