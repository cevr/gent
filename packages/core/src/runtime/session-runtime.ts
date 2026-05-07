import { Cause, Clock, Context, DateTime, Effect, Layer, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Entity, MessageStorage as ClusterMessageStorage, Sharding } from "effect/unstable/cluster"
import type { RpcGroup } from "effect/unstable/rpc"
import { Rpc } from "effect/unstable/rpc"
import { ActorAddressResolver } from "effect-encore"
import {
  AgentRunError,
  DEFAULT_AGENT_NAME,
  RunSpecSchema,
  type RunSpec,
  AgentName,
} from "../domain/agent.js"
import { emptyQueueSnapshot, QueueSnapshot } from "../domain/queue.js"
import { Permission } from "../domain/permission.js"
import { AgentRestarted, ErrorOccurred } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../domain/ids.js"
import { Message, MessageMetadata } from "../domain/message.js"
import type { PromptSection } from "../domain/prompt.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { EventStorage } from "../storage/event-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { ModelId } from "../domain/model.js"
import { AgentLoop } from "./agent/agent-loop.js"
import { AgentLoop as AgentLoopActor, AgentLoopLiveActor } from "./agent/agent-loop.actor.js"
import { entityIdOf } from "./agent/agent-loop.entity-id.js"
import { AgentLoopStateRegistry } from "./agent/agent-loop.state-registry.js"
import { AgentLoopSessionGovernance } from "./agent/agent-loop.session-governance.js"
import { AgentLoopBehaviorDeps } from "./agent/agent-loop.behavior-deps.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import type { ModelRegistry } from "./model-registry.js"
import { GentPlatform } from "./gent-platform.js"
import { makeAmbientExtensionHostContextDeps } from "./make-extension-host-context.js"
import { SessionProfileCache } from "./session-profile.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"
import { SteerCommand as SteerCommandType } from "../domain/steer.js"
import {
  AllowAllPermission,
  resolveExistingSessionBranch,
  resolveSessionEnvironmentOrFail,
} from "./session-runtime-context.js"
import { SessionRuntimeStateSchema, type SessionRuntimeState } from "./agent/agent-loop.state.js"
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
const RequestIdSchema = Schema.String.check(Schema.isMaxLength(128))

export const SendUserMessagePayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  agentOverride: Schema.optional(AgentName),
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
  /** Client-generated correlation id for end-to-end observability. */
  requestId: Schema.optional(RequestIdSchema),
})
export type SendUserMessagePayload = typeof SendUserMessagePayload.Type

export const SendToolResultPayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
export type SendToolResultPayload = typeof SendToolResultPayload.Type

export const CancelInterruptPayload = Schema.TaggedStruct("Cancel", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
})
export type CancelInterruptPayload = typeof CancelInterruptPayload.Type

export const InterruptTurnPayload = Schema.TaggedStruct("Interrupt", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
})
export type InterruptTurnPayload = typeof InterruptTurnPayload.Type

export const InterjectPayload = Schema.TaggedStruct("Interject", {
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  message: Schema.String,
})
export type InterjectPayload = typeof InterjectPayload.Type

export const InterruptPayload = Schema.Union([
  CancelInterruptPayload,
  InterruptTurnPayload,
  InterjectPayload,
])
export type InterruptPayload = typeof InterruptPayload.Type

export const InvokeToolPayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  toolName: Schema.String,
  input: Schema.Unknown,
})
export type InvokeToolPayload = typeof InvokeToolPayload.Type

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
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  metadata: Schema.optional(MessageMetadata),
})
export type QueueFollowUpPayload = typeof QueueFollowUpPayload.Type

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

export const SessionRuntimeEntity = Entity.make("SessionRuntime", [
  Rpc.make("sendUserMessage", {
    payload: SendUserMessagePayload.fields,
    error: SessionRuntimeError,
  }),
  Rpc.make("recordToolResult", {
    payload: SendToolResultPayload.fields,
    error: SessionRuntimeError,
  }),
  Rpc.make("invokeTool", {
    payload: InvokeToolPayload.fields,
    error: SessionRuntimeError,
  }),
  Rpc.make("steer", {
    payload: SteerCommandType,
    error: SessionRuntimeError,
  }),
  Rpc.make("respondInteraction", {
    payload: {
      ...SessionRuntimeTarget.fields,
      requestId: InteractionRequestId,
    },
    error: SessionRuntimeError,
  }),
  Rpc.make("runPrompt", {
    payload: RunPromptPayload.fields,
    error: AgentRunError,
  }),
  Rpc.make("queueFollowUp", {
    payload: QueueFollowUpPayload.fields,
    error: SessionRuntimeError,
  }),
  Rpc.make("drainQueuedMessages", {
    payload: SessionRuntimeTarget.fields,
    success: QueueSnapshot,
    error: SessionRuntimeError,
  }),
  Rpc.make("getQueuedMessages", {
    payload: SessionRuntimeTarget.fields,
    success: QueueSnapshot,
    error: SessionRuntimeError,
  }),
  Rpc.make("getState", {
    payload: SessionRuntimeTarget.fields,
    success: SessionRuntimeStateSchema,
    error: SessionRuntimeError,
  }),
  Rpc.make("getMetrics", {
    payload: SessionRuntimeTarget.fields,
    success: SessionRuntimeMetrics,
    error: SessionRuntimeError,
  }),
  Rpc.make("watchState", {
    payload: SessionRuntimeTarget.fields,
    success: SessionRuntimeStateSchema,
    stream: true,
    error: SessionRuntimeError,
  }),
  Rpc.make("terminateSession", {
    payload: SessionRuntimeSessionTarget.fields,
    error: SessionRuntimeError,
  }),
  Rpc.make("restoreSession", {
    payload: SessionRuntimeSessionTarget.fields,
    error: SessionRuntimeError,
  }),
])

export type SessionRuntimeEntityRpcs = RpcGroup.Rpcs<typeof SessionRuntimeEntity.protocol>
export type SessionRuntimeEntityHandlers = Entity.HandlersFrom<SessionRuntimeEntityRpcs>

type LayerRequirements<T> = T extends Layer.Layer<infer _ROut, infer _E, infer RIn> ? RIn : never
type SessionRuntimeEntityLayerRequirements =
  | Sharding.Sharding
  | EventStorage
  | EventPublisher
  | ExtensionRegistry
  | DriverRegistry
  | ModelRegistry
  | GentPlatform
  | Exclude<
      LayerRequirements<ReturnType<typeof AgentLoop.Live>>,
      | AgentLoopStateRegistry
      | AgentLoopSessionGovernance
      | Context.Service.Identifier<typeof AgentLoopActor.Context>
    >
  | LayerRequirements<ReturnType<typeof AgentLoopBehaviorDeps.Live>>

export interface SessionRuntimeService {
  readonly sendUserMessage: (
    input: SendUserMessagePayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly recordToolResult: (
    input: SendToolResultPayload,
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly invokeTool: (input: InvokeToolPayload) => Effect.Effect<void, SessionRuntimeError>
  readonly steer: (command: SteerCommandType) => Effect.Effect<void, SessionRuntimeError>
  readonly respondInteraction: (
    input: SessionRuntimeTarget & { readonly requestId: InteractionRequestId },
  ) => Effect.Effect<void, SessionRuntimeError>
  readonly runPrompt: (input: RunPromptPayload) => Effect.Effect<void, AgentRunError>
  readonly queueFollowUp: (input: QueueFollowUpPayload) => Effect.Effect<void, SessionRuntimeError>
  readonly drainQueuedMessages: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getQueuedMessages: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<QueueSnapshot, SessionRuntimeError>
  readonly getState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeState, SessionRuntimeError>
  readonly getMetrics: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<SessionRuntimeMetrics, SessionRuntimeError>
  readonly watchState: (
    input: SessionRuntimeTarget,
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState, SessionRuntimeError>, SessionRuntimeError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void, SessionRuntimeError>
}

export const makeSessionRuntimeEntityHandlers = (
  service: SessionRuntimeService,
): SessionRuntimeEntityHandlers =>
  SessionRuntimeEntity.of({
    sendUserMessage: ({ payload }) => Rpc.uninterruptible(service.sendUserMessage(payload)),
    recordToolResult: ({ payload }) => Rpc.uninterruptible(service.recordToolResult(payload)),
    invokeTool: ({ payload }) => Rpc.uninterruptible(service.invokeTool(payload)),
    steer: ({ payload }) => Rpc.uninterruptible(service.steer(payload)),
    respondInteraction: ({ payload }) => Rpc.uninterruptible(service.respondInteraction(payload)),
    runPrompt: ({ payload }) => Rpc.uninterruptible(service.runPrompt(payload)),
    queueFollowUp: ({ payload }) => Rpc.uninterruptible(service.queueFollowUp(payload)),
    drainQueuedMessages: ({ payload }) => service.drainQueuedMessages(payload),
    getQueuedMessages: ({ payload }) => service.getQueuedMessages(payload),
    getState: ({ payload }) => service.getState(payload),
    getMetrics: ({ payload }) => service.getMetrics(payload),
    watchState: ({ payload }) => Stream.unwrap(service.watchState(payload)),
    terminateSession: ({ payload }) =>
      Rpc.uninterruptible(service.terminateSession(payload.sessionId)),
    restoreSession: ({ payload }) => Rpc.uninterruptible(service.restoreSession(payload.sessionId)),
  })

const wrapError = (message: string, cause: Cause.Cause<unknown>) => {
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionExists`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  return new SessionRuntimeError({ message, cause })
}

const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)

const wrapEntitySessionRuntimeError = (operation: string, error: unknown) =>
  Schema.is(SessionRuntimeError)(error)
    ? error
    : new SessionRuntimeError({
        message: `${operation} failed`,
        cause: error,
      })

const wrapEntityAgentRunError = (operation: string, error: unknown) =>
  Schema.is(AgentRunError)(error)
    ? error
    : new AgentRunError({
        message: `${operation} failed`,
        cause: error,
      })

export const interruptPayloadToSteerCommand = (input: InterruptPayload): SteerCommandType => {
  switch (input._tag) {
    case "Interject":
      return {
        _tag: "Interject",
        sessionId: input.sessionId,
        branchId: input.branchId,
        message: input.message,
      }
    case "Cancel":
      return {
        _tag: "Cancel",
        sessionId: input.sessionId,
        branchId: input.branchId,
      }
    case "Interrupt":
      return {
        _tag: "Interrupt",
        sessionId: input.sessionId,
        branchId: input.branchId,
      }
  }
}

interface RunPromptInput {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName: AgentName
  readonly prompt: string
  readonly interactive?: boolean
  readonly runSpec?: RunSpec
}

const makeLiveSessionRuntime = Effect.gen(function* () {
  const agentLoop = yield* AgentLoop
  // Resolve the actor client factory once at construction time. Per-method
  // dispatch uses `ActorRef.execute(op)`, which carries no requirement,
  // instead of the `OperationHandle.execute(payload)` form (which would
  // re-introduce the actor client requirement at each call site).
  const actorClientFactory = yield* AgentLoopActor.Context
  const actorAddressResolver = yield* ActorAddressResolver
  const agentLoopActorRefFor = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      return yield* actorClientFactory(entityIdOf(workspaceId, sessionId, branchId))
    })
  const sharding = yield* Sharding.Sharding
  const clusterMessageStorage = yield* ClusterMessageStorage.MessageStorage
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const messageStorage = yield* MessageStorage
  const eventStorage = yield* EventStorage
  const eventPublisher = yield* EventPublisher
  const agentLoopStateRegistry = yield* AgentLoopStateRegistry
  const agentLoopSessionGovernance = yield* AgentLoopSessionGovernance
  const extensionRegistry = yield* ExtensionRegistry
  const driverRegistry = yield* DriverRegistry
  const platform = yield* GentPlatform
  const permissionOpt = yield* Effect.serviceOption(Permission)
  const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
  const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
  const defaultPermission = permissionOpt._tag === "Some" ? permissionOpt.value : AllowAllPermission
  // Every public session-scoped boundary (writes + reads) MUST validate the
  // durable `(sessionId, branchId)` target before proceeding. In-memory
  // tombstones do not survive restart, and branch ids are globally addressable
  // enough that session-only checks hide cross-session mistakes.
  const requireSessionBranch = (target: SessionRuntimeTarget) =>
    resolveExistingSessionBranch({ sessionStorage, branchStorage, ...target }).pipe(
      Effect.mapError(
        (cause) =>
          new SessionRuntimeError({
            message: cause.message,
            cause,
          }),
      ),
    )

  const waitForSubmittedMessageAccepted = (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly messageId: MessageId
    readonly content?: string
    readonly acceptPersisted?: boolean
  }): Effect.Effect<void, SessionRuntimeError> =>
    Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + 15_000
      const loop: Effect.Effect<void, SessionRuntimeError> = Effect.gen(function* () {
        if (params.acceptPersisted !== false) {
          const persisted = yield* messageStorage.getMessage(params.messageId).pipe(
            Effect.mapError(
              (cause) =>
                new SessionRuntimeError({
                  message: `Failed to read submitted message ${params.messageId}`,
                  cause,
                }),
            ),
          )
          if (persisted !== undefined) return
        }

        const ref = yield* agentLoopActorRefFor(params.sessionId, params.branchId)
        const queue = yield* ref
          .execute(
            AgentLoopActor.GetQueue.make({ ...params, workspaceId: yield* CurrentWorkspaceId }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new SessionRuntimeError({
                  message: `Failed to read submitted message queue ${params.messageId}`,
                  cause,
                }),
            ),
          )
        const queued = [...queue.steering, ...queue.followUp].some(
          (entry) =>
            entry.id === params.messageId ||
            (params.content !== undefined && entry.content.includes(params.content)),
        )
        if (queued) return

        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new SessionRuntimeError({
            message: `Timed out waiting for submitted message ${params.messageId}`,
          })
        }

        yield* Effect.sleep("50 millis")
        return yield* loop
      })
      yield* loop
    })

  const queueFollowUpThroughActor = Effect.fn("SessionRuntime.queueFollowUpThroughActor")(
    function* (input: QueueFollowUpPayload) {
      const message = Message.Regular.make({
        id: MessageId.make(yield* platform.randomId),
        sessionId: input.sessionId,
        branchId: input.branchId,
        role: "user",
        parts: [Prompt.textPart({ text: input.content })],
        createdAt: yield* DateTime.nowAsDate,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })
      const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
      yield* ref
        .execute(
          AgentLoopActor.QueueFollowUp.make({
            workspaceId: yield* CurrentWorkspaceId,
            message,
            agentOverride: undefined,
            runSpec: undefined,
            interactive: undefined,
          }),
        )
        .pipe(
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

  const hostDeps = yield* makeAmbientExtensionHostContextDeps({
    extensionRegistry,
    overrides: {
      sessionControl: {
        queueFollowUp: queueFollowUpThroughActor,
      },
    },
  })

  const redeliverPendingActorMessages = (target: SessionRuntimeTarget) =>
    Effect.gen(function* () {
      const workspaceId = yield* CurrentWorkspaceId
      yield* AgentLoopActor.redeliver(entityIdOf(workspaceId, target.sessionId, target.branchId))
    }).pipe(
      Effect.provideService(ClusterMessageStorage.MessageStorage, clusterMessageStorage),
      Effect.provideService(ActorAddressResolver, actorAddressResolver),
      Effect.provideService(Sharding.Sharding, sharding),
      Effect.ignore,
    )

  const sendUserMessage = Effect.fn("SessionRuntime.sendUserMessage")(function* (
    input: SendUserMessagePayload,
  ) {
    yield* requireSessionBranch(input)
    const commandId = input.commandId ?? ActorCommandId.make(yield* platform.randomId)
    const resolved = yield* resolveSessionEnvironmentOrFail({
      sessionId: input.sessionId,
      branchId: input.branchId,
      sessionStorage,
      hostDeps,
      profileCache,
      defaults: {
        driverRegistry,
        permission: defaultPermission,
        baseSections: [],
      },
    }).pipe(
      Effect.flatMap(({ session, environment }) =>
        session !== undefined
          ? Effect.succeed({ session, environment })
          : Effect.fail(
              new SessionRuntimeError({
                message: `Session not found: ${input.sessionId}`,
              }),
            ),
      ),
    )
    const { environment } = resolved
    const content = yield* environment.extensionRegistry.extensionReactions.normalizeMessageInput(
      {
        content: input.content,
        sessionId: input.sessionId,
        branchId: input.branchId,
      },
      environment.hostCtx,
    )

    const message = Message.Regular.make({
      id: userMessageIdForCommand(commandId),
      sessionId: input.sessionId,
      branchId: input.branchId,
      role: "user",
      parts: [Prompt.textPart({ text: content })],
      createdAt: yield* DateTime.nowAsDate,
    })

    const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
    yield* ref
      .send(
        AgentLoopActor.Submit.make({
          workspaceId: yield* CurrentWorkspaceId,
          message,
          agentOverride: input.agentOverride,
          interactive: input.interactive,
          runSpec: input.runSpec,
        }),
      )
      .pipe(
        Effect.tapCause((cause) => {
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
        }),
      )
    yield* waitForSubmittedMessageAccepted({
      sessionId: input.sessionId,
      branchId: input.branchId,
      messageId: message.id,
      content,
    })
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

    recordToolResult: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.RecordToolResult.make({
                workspaceId: yield* CurrentWorkspaceId,
                sessionId: input.sessionId,
                branchId: input.branchId,
                toolCallId: input.toolCallId,
                toolName: input.toolName,
                output: input.output,
                commandId: input.commandId,
                isError: input.isError,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("recordToolResult failed", cause))),
      ),

    invokeTool: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = input.commandId ?? ActorCommandId.make(yield* platform.randomId)
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.InvokeTool.make({
                workspaceId: yield* CurrentWorkspaceId,
                sessionId: input.sessionId,
                branchId: input.branchId,
                commandId,
                toolName: input.toolName,
                input: input.input,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("invokeTool failed", cause))),
      ),

    steer: (command) =>
      requireSessionBranch(command).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const commandId = ActorCommandId.make(yield* platform.randomId)
            const ref = yield* agentLoopActorRefFor(command.sessionId, command.branchId)
            yield* ref.send(
              AgentLoopActor.Steer.make({
                workspaceId: yield* CurrentWorkspaceId,
                commandId,
                command,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("steer failed", cause))),
      ),

    respondInteraction: (input) =>
      requireSessionBranch(input).pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
            yield* ref.execute(
              AgentLoopActor.RespondInteraction.make({
                ...input,
                workspaceId: yield* CurrentWorkspaceId,
              }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("respondInteraction failed", cause))),
      ),

    runPrompt: (input: RunPromptInput) =>
      agentLoop.runOnce(input).pipe(
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
            const commandId = ActorCommandId.make(yield* platform.randomId)
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
              AgentLoopActor.GetQueue.make({ ...input, workspaceId: yield* CurrentWorkspaceId }),
            )
          }),
        ),
        Effect.catchCause((cause) => Effect.fail(wrapError("getQueuedMessages failed", cause))),
      ),

    getState: (input) =>
      Effect.gen(function* () {
        yield* requireSessionBranch(input)
        yield* redeliverPendingActorMessages(input)
        const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
        const loopState = yield* ref.execute(
          AgentLoopActor.GetState.make({ ...input, workspaceId: yield* CurrentWorkspaceId }),
        )
        return loopState satisfies SessionRuntimeState
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

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
        const ref = yield* agentLoopActorRefFor(input.sessionId, input.branchId)
        yield* ref.execute(
          AgentLoopActor.EnsureStarted.make({
            ...input,
            workspaceId: yield* CurrentWorkspaceId,
          }),
        )
        return yield* agentLoop.watchState(input)
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("watchState failed", cause)))),

    terminateSession: (sessionId) =>
      Effect.gen(function* () {
        const workspaceId = yield* CurrentWorkspaceId
        yield* agentLoopSessionGovernance.markTerminated(workspaceId, sessionId)
        const branches = yield* agentLoopStateRegistry.listForSession(workspaceId, sessionId)
        yield* Effect.forEach(
          branches,
          (branchId) =>
            Effect.gen(function* () {
              const ref = yield* agentLoopActorRefFor(sessionId, branchId)
              yield* ref.execute(
                AgentLoopActor.TerminateBranch.make({
                  workspaceId,
                  sessionId,
                  branchId,
                }),
              )
            }),
          { concurrency: "unbounded", discard: true },
        )
        yield* agentLoop.terminateSession(sessionId)
      }).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("terminateSession failed", cause))),
      ),

    restoreSession: (sessionId) => agentLoop.restoreSession(sessionId),
  } satisfies SessionRuntimeService
})

const makeEntityClientSessionRuntime = Effect.gen(function* () {
  const makeClient = yield* SessionRuntimeEntity.client
  const clientForTarget = (target: SessionRuntimeTarget | SessionRuntimeSessionTarget) =>
    makeClient(target.sessionId)

  return {
    sendUserMessage: (input) =>
      clientForTarget(input)
        .sendUserMessage(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("sendUserMessage", error))),
    recordToolResult: (input) =>
      clientForTarget(input)
        .recordToolResult(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("recordToolResult", error))),
    invokeTool: (input) =>
      clientForTarget(input)
        .invokeTool(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("invokeTool", error))),
    steer: (command) =>
      clientForTarget(command)
        .steer(command)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("steer", error))),
    respondInteraction: (input) =>
      clientForTarget(input)
        .respondInteraction(input)
        .pipe(
          Effect.mapError((error) => wrapEntitySessionRuntimeError("respondInteraction", error)),
        ),
    runPrompt: (input) =>
      clientForTarget(input)
        .runPrompt(input)
        .pipe(Effect.mapError((error) => wrapEntityAgentRunError("runPrompt", error))),
    queueFollowUp: (input) =>
      clientForTarget(input)
        .queueFollowUp(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("queueFollowUp", error))),
    drainQueuedMessages: (input) =>
      clientForTarget(input)
        .drainQueuedMessages(input)
        .pipe(
          Effect.mapError((error) => wrapEntitySessionRuntimeError("drainQueuedMessages", error)),
        ),
    getQueuedMessages: (input) =>
      clientForTarget(input)
        .getQueuedMessages(input)
        .pipe(
          Effect.mapError((error) => wrapEntitySessionRuntimeError("getQueuedMessages", error)),
        ),
    getState: (input) =>
      clientForTarget(input)
        .getState(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("getState", error))),
    getMetrics: (input) =>
      clientForTarget(input)
        .getMetrics(input)
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("getMetrics", error))),
    watchState: (input) =>
      Effect.succeed(
        clientForTarget(input)
          .watchState(input)
          .pipe(Stream.mapError((error) => wrapEntitySessionRuntimeError("watchState", error))),
      ),
    terminateSession: (sessionId) =>
      clientForTarget({ sessionId })
        .terminateSession({ sessionId })
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("terminateSession", error))),
    restoreSession: (sessionId) =>
      clientForTarget({ sessionId })
        .restoreSession({ sessionId })
        .pipe(Effect.mapError((error) => wrapEntitySessionRuntimeError("restoreSession", error))),
  } satisfies SessionRuntimeService
})

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = (_config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<SessionRuntime, never, Sharding.Sharding> =>
    Layer.effect(SessionRuntime, makeEntityClientSessionRuntime)

  static EntityLive = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<AgentLoop, never, SessionRuntimeEntityLayerRequirements> =>
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — Effect cluster's Entity.toLayer exposes erased RPC middleware requirements; the exported layer narrows the Gent-owned services at this boundary.
    SessionRuntimeEntity.toLayer(
      makeLiveSessionRuntime.pipe(Effect.map(makeSessionRuntimeEntityHandlers)),
      {
        // SessionRuntime hosts long-lived streams and control-plane calls;
        // per-branch mutation ordering lives in AgentLoop's entity operation
        // queue and actor-owned mutation gates.
        concurrency: "unbounded",
      },
    ).pipe(
      Layer.provideMerge(AgentLoop.Live(config)),
      // `AgentLoopLiveActor` provides the `AgentLoop` actor client consumed
      // by both `makeLiveSessionRuntime` and the legacy `AgentLoop` facade.
      // Provide it after merging those two consumers so the actor client is
      // shared and not re-exported from `LiveWithEntity`.
      Layer.provide(AgentLoopLiveActor),
      // `AgentLoopStateRegistry` and `AgentLoopSessionGovernance` are
      // runtime-internal shared services. They are provided at the entity
      // boundary (NOT inside `AgentLoop.Live`) so the legacy `AgentLoop`
      // service and the actor handler (C5.4.4.c) consume the SAME instances —
      // otherwise actor-owned state and read-side state would split into two
      // separate registries. `Layer.provide` keeps them out of public layer
      // requirements.
      Layer.provide(AgentLoopStateRegistry.Live),
      Layer.provide(AgentLoopSessionGovernance.Live),
      // `AgentLoopBehaviorDeps` (C5.4.4.c.1.b.1) is the layer-level service
      // snapshot the per-entity actor build will consume in c.1.b.2. Provided
      // here so it co-exists with legacy `AgentLoop.Live` until the actor
      // build replaces the legacy factory in c.1.b.2.
      Layer.provide(AgentLoopBehaviorDeps.Live(config)),
    )

  static LiveWithEntity = (config: {
    readonly baseSections: ReadonlyArray<PromptSection>
  }): Layer.Layer<SessionRuntime | AgentLoop, never, SessionRuntimeEntityLayerRequirements> =>
    SessionRuntime.Live(config).pipe(Layer.provideMerge(SessionRuntime.EntityLive(config)))

  static Test = (overrides: Partial<SessionRuntimeService> = {}): Layer.Layer<SessionRuntime> =>
    Layer.succeed(SessionRuntime, {
      sendUserMessage: () => Effect.void,
      recordToolResult: () => Effect.void,
      invokeTool: () => Effect.void,
      steer: () => Effect.void,
      respondInteraction: () => Effect.void,
      runPrompt: () => Effect.void,
      queueFollowUp: () => Effect.void,
      drainQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
      getQueuedMessages: () => Effect.succeed(emptyQueueSnapshot()),
      getState: () =>
        Effect.succeed(
          SessionRuntimeStateSchema.Idle.make({
            agent: DEFAULT_AGENT_NAME,
            queue: emptyQueueSnapshot(),
          }),
        ),
      getMetrics: () =>
        Effect.succeed({
          turns: 0,
          tokens: 0,
          toolCalls: 0,
          retries: 0,
          durationMs: 0,
          costUsd: 0,
          lastInputTokens: 0,
        }),
      watchState: () => Effect.succeed(Stream.empty),
      terminateSession: () => Effect.void,
      restoreSession: () => Effect.void,
      ...overrides,
    })
}
