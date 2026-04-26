import { Cause, Context, DateTime, Effect, Layer, Schema, Stream } from "effect"
import {
  AgentRunError,
  DEFAULT_AGENT_NAME,
  RunSpecSchema,
  type RunSpec,
  AgentName,
} from "../domain/agent.js"
import { emptyQueueSnapshot, type QueueSnapshot } from "../domain/queue.js"
import { Permission } from "../domain/permission.js"
import { AgentRestarted, ErrorOccurred } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { ActorCommandId, BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"
import { Message, TextPart } from "../domain/message.js"
import type { PromptSection } from "../domain/prompt.js"
import { Storage } from "../storage/sqlite-storage.js"
import { ModelId } from "../domain/model.js"
import { AgentLoop } from "./agent/agent-loop.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import { DriverRegistry } from "./extensions/driver-registry.js"
import type { ModelRegistry } from "./model-registry.js"
import { makeAmbientExtensionHostContextDeps } from "./make-extension-host-context.js"
import { MachineEngine } from "./extensions/resource-host/machine-engine.js"
import { SessionProfileCache } from "./session-profile.js"
import { SteerCommand, type SteerCommand as SteerCommandType } from "../domain/steer.js"
import { AllowAllPermission, resolveSessionEnvironmentOrFail } from "./session-runtime-context.js"
import { LoopRuntimeStateSchema, type LoopRuntimeState } from "./agent/agent-loop.state.js"

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

const RuntimeCommandTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

const RuntimeCommandIdField = {
  commandId: Schema.optional(ActorCommandId),
}

const RuntimeTurnFields = {
  ...RuntimeCommandTargetFields,
  ...RuntimeCommandIdField,
}

const RuntimeTurnOptionFields = {
  agentOverride: Schema.optional(AgentName),
  interactive: Schema.optional(Schema.Boolean),
  runSpec: Schema.optional(RunSpecSchema),
}

export const SendUserMessageCommand = Schema.TaggedStruct("SendUserMessage", {
  ...RuntimeTurnFields,
  content: Schema.String,
  ...RuntimeTurnOptionFields,
  requestId: Schema.optional(RequestIdSchema),
})
export type SendUserMessageCommand = typeof SendUserMessageCommand.Type

export const RecordToolResultCommand = Schema.TaggedStruct("RecordToolResult", {
  ...RuntimeTurnFields,
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
export type RecordToolResultCommand = typeof RecordToolResultCommand.Type

export const InvokeToolCommand = Schema.TaggedStruct("InvokeTool", {
  ...RuntimeTurnFields,
  toolName: Schema.String,
  input: Schema.Unknown,
})
export type InvokeToolCommand = typeof InvokeToolCommand.Type

export const ApplySteerCommand = Schema.TaggedStruct("ApplySteer", {
  command: SteerCommand,
})
export type ApplySteerCommand = typeof ApplySteerCommand.Type

export const RespondInteractionCommand = Schema.TaggedStruct("RespondInteraction", {
  ...RuntimeCommandTargetFields,
  requestId: Schema.String,
})
export type RespondInteractionCommand = typeof RespondInteractionCommand.Type

export const RuntimeCommand = Schema.Union([
  SendUserMessageCommand,
  RecordToolResultCommand,
  InvokeToolCommand,
  ApplySteerCommand,
  RespondInteractionCommand,
])
export type RuntimeCommand = typeof RuntimeCommand.Type

export const SessionRuntimeStateSchema = LoopRuntimeStateSchema
export type SessionRuntimeState = LoopRuntimeState

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

export interface SessionRuntimeService {
  readonly dispatch: (command: RuntimeCommand) => Effect.Effect<void, SessionRuntimeError>
  readonly runPrompt: (input: {
    sessionId: SessionId
    branchId: BranchId
    agentName: AgentName
    prompt: string
    interactive?: boolean
    runSpec?: RunSpec
  }) => Effect.Effect<void, AgentRunError>
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
  ) => Effect.Effect<Stream.Stream<SessionRuntimeState>, SessionRuntimeError>
  readonly terminateSession: (sessionId: SessionId) => Effect.Effect<void>
  readonly restoreSession: (sessionId: SessionId) => Effect.Effect<void>
}

const wrapError = (message: string, cause: Cause.Cause<unknown>) => {
  // Preserve inner typed SessionRuntimeError (e.g. from `requireSessionExists`)
  // so callers observing the cause chain see the specific "Session not found"
  // message instead of a generic "<op> failed" wrapper.
  const inner = cause.reasons.find(Cause.isFailReason)?.error
  if (Schema.is(SessionRuntimeError)(inner)) return inner
  return new SessionRuntimeError({ message, cause })
}

const makeCommandId = () => ActorCommandId.make(Bun.randomUUIDv7())
const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.make(commandId)

export const sendUserMessageCommand = (input: SendUserMessagePayload): SendUserMessageCommand => ({
  _tag: "SendUserMessage",
  ...input,
})

export const recordToolResultCommand = (input: SendToolResultPayload): RecordToolResultCommand => ({
  _tag: "RecordToolResult",
  ...input,
})

export const invokeToolCommand = (input: InvokeToolPayload): InvokeToolCommand => ({
  _tag: "InvokeTool",
  ...input,
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

export const applySteerCommand = (command: SteerCommandType): ApplySteerCommand => ({
  _tag: "ApplySteer",
  command,
})

export const respondInteractionCommand = (
  input: Pick<SessionRuntimeTarget, "sessionId" | "branchId"> & { requestId: string },
): RespondInteractionCommand => ({
  _tag: "RespondInteraction",
  ...input,
})

const runtimeCommandTarget = (command: RuntimeCommand): SessionRuntimeTarget => {
  switch (command._tag) {
    case "SendUserMessage":
    case "RecordToolResult":
    case "InvokeTool":
    case "RespondInteraction":
      return {
        sessionId: command.sessionId,
        branchId: command.branchId,
      }
    case "ApplySteer":
      return {
        sessionId: command.command.sessionId,
        branchId: command.command.branchId,
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

const makeLiveSessionRuntime: Effect.Effect<
  SessionRuntimeService,
  never,
  | AgentLoop
  | Storage
  | EventPublisher
  | ExtensionRegistry
  | DriverRegistry
  | MachineEngine
  | Permission
  | SessionProfileCache
  | ModelRegistry
> = Effect.gen(function* () {
  const agentLoop = yield* AgentLoop
  const storage = yield* Storage
  const eventPublisher = yield* EventPublisher
  const extensionRegistry = yield* ExtensionRegistry
  const driverRegistry = yield* DriverRegistry
  const permissionOpt = yield* Effect.serviceOption(Permission)
  const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
  const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined
  const defaultPermission = permissionOpt._tag === "Some" ? permissionOpt.value : AllowAllPermission
  const extensionStateRuntime = yield* MachineEngine
  const hostDeps = yield* makeAmbientExtensionHostContextDeps({
    extensionStateRuntime,
    extensionRegistry,
    storage,
  })

  // Every public session-scoped boundary (dispatch + reads + subscriptions) MUST
  // validate durable existence before proceeding. In-memory tombstones do not
  // survive restart — a read for a deleted session would otherwise fall through
  // to "return idle" in the agent-loop and hide the ghost.
  const requireSessionExists = (target: SessionRuntimeTarget) =>
    storage.getSession(target.sessionId).pipe(
      Effect.mapError(
        (cause) =>
          new SessionRuntimeError({
            message: `Session lookup failed: ${target.sessionId}`,
            cause,
          }),
      ),
      Effect.flatMap((session) =>
        session === undefined
          ? Effect.fail(
              new SessionRuntimeError({
                message: `Session not found: ${target.sessionId}`,
              }),
            )
          : Effect.succeed(session),
      ),
    )

  const dispatchCommand = Effect.fn("SessionRuntime.dispatchCommand")(function* (
    command: RuntimeCommand,
  ) {
    const target = runtimeCommandTarget(command)
    yield* requireSessionExists(target)

    switch (command._tag) {
      case "SendUserMessage": {
        const commandId = command.commandId ?? makeCommandId()
        const resolved = yield* resolveSessionEnvironmentOrFail({
          sessionId: command.sessionId,
          branchId: command.branchId,
          storage,
          hostDeps,
          profileCache,
          defaults: {
            driverRegistry,
            permission: defaultPermission,
            baseSections: [],
          },
        }).pipe(
          Effect.flatMap((result) =>
            result._tag === "SessionFound"
              ? Effect.succeed(result)
              : Effect.fail(
                  new SessionRuntimeError({
                    message: `Session not found: ${command.sessionId}`,
                  }),
                ),
          ),
        )
        const { environment } = resolved
        const content = yield* environment.extensionRegistry.runtimeSlots.normalizeMessageInput(
          {
            content: command.content,
            sessionId: command.sessionId,
            branchId: command.branchId,
          },
          environment.hostCtx,
        )

        const message = Message.Regular.make({
          id: userMessageIdForCommand(commandId),
          sessionId: command.sessionId,
          branchId: command.branchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: content })],
          createdAt: yield* DateTime.nowAsDate,
        })

        yield* agentLoop
          .submit(message, {
            ...(command.agentOverride !== undefined
              ? { agentOverride: command.agentOverride }
              : {}),
            ...(command.interactive !== undefined ? { interactive: command.interactive } : {}),
            ...(command.runSpec !== undefined ? { runSpec: command.runSpec } : {}),
          })
          .pipe(
            Effect.tapCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.void
              return Effect.gen(function* () {
                if (Cause.hasDies(cause)) {
                  yield* eventPublisher.publish(
                    AgentRestarted.make({
                      sessionId: command.sessionId,
                      branchId: command.branchId,
                      attempt: 0,
                      error: Cause.pretty(cause),
                    }),
                  )
                }
                yield* eventPublisher.publish(
                  ErrorOccurred.make({
                    sessionId: command.sessionId,
                    branchId: command.branchId,
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
        yield* Effect.logInfo("session-runtime.message.submitted").pipe(
          Effect.annotateLogs({
            sessionId: command.sessionId,
            branchId: command.branchId,
          }),
        )
        return
      }
      case "RecordToolResult": {
        yield* agentLoop.recordToolResult(command)
        return
      }
      case "InvokeTool": {
        yield* agentLoop.invokeTool(command)
        return
      }
      case "ApplySteer":
        yield* agentLoop.steer(command.command)
        return
      case "RespondInteraction":
        yield* agentLoop.respondInteraction(command)
        return
    }
  })

  return {
    dispatch: (command) =>
      dispatchCommand(command).pipe(
        Effect.catchCause((cause) => Effect.fail(wrapError("dispatch failed", cause))),
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

    drainQueuedMessages: (input) =>
      requireSessionExists(input).pipe(
        Effect.flatMap(() => agentLoop.drainQueue(input)),
        Effect.catchCause((cause) => Effect.fail(wrapError("drainQueuedMessages failed", cause))),
      ),

    getQueuedMessages: (input) =>
      requireSessionExists(input).pipe(
        Effect.flatMap(() => agentLoop.getQueue(input)),
        Effect.catchCause((cause) => Effect.fail(wrapError("getQueuedMessages failed", cause))),
      ),

    getState: (input) =>
      Effect.gen(function* () {
        yield* requireSessionExists(input)
        const loopState = yield* agentLoop.getState(input)
        return loopState satisfies SessionRuntimeState
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

    getMetrics: (input) =>
      Effect.gen(function* () {
        yield* requireSessionExists(input)
        const envelopes = yield* storage
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
        yield* requireSessionExists(input)
        return yield* agentLoop.watchState(input)
      }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("watchState failed", cause)))),

    terminateSession: (sessionId) => agentLoop.terminateSession(sessionId),

    restoreSession: (sessionId) => agentLoop.restoreSession(sessionId),
  } satisfies SessionRuntimeService
})

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = (config: { readonly baseSections: ReadonlyArray<PromptSection> }) =>
    Layer.effect(SessionRuntime, makeLiveSessionRuntime).pipe(
      Layer.provideMerge(AgentLoop.Live(config)),
    )

  static Test = (): Layer.Layer<SessionRuntime> =>
    Layer.succeed(SessionRuntime, {
      dispatch: () => Effect.void,
      runPrompt: () => Effect.void,
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
    })
}
