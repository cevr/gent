import { Cause, Context, DateTime, Effect, Layer, Schema, Stream } from "effect"
import { RunSpecSchema, AgentName, AgentRunnerService } from "../domain/agent.js"
import { QueueSnapshot } from "../domain/queue.js"
import {
  AgentRestarted,
  ErrorOccurred,
  ToolCallFailed,
  ToolCallSucceeded,
} from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { ActorCommandId, BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"
import { Message, TextPart, ToolResultPart } from "../domain/message.js"
import { summarizeToolOutput, stringifyOutput } from "../domain/tool-output.js"
import { Storage } from "../storage/sqlite-storage.js"
import { AgentLoop, invokeToolPhase } from "./agent/agent-loop.js"
import { ToolRunner } from "./agent/tool-runner.js"
import { ExtensionRegistry } from "./extensions/registry.js"
import { type MakeExtensionHostContextDeps } from "./make-extension-host-context.js"
import { RuntimePlatform } from "./runtime-platform.js"
import { ApprovalService } from "./approval-service.js"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ExtensionTurnControl } from "./extensions/turn-control.js"
import { SearchStorage } from "../storage/search-storage.js"
import { MachineEngine } from "./extensions/resource-host/machine-engine.js"
import { SessionProfileCache } from "./session-profile.js"
import { ResourceManager } from "./resource-manager.js"
import { SteerCommand, type SteerCommand as SteerCommandType } from "../domain/steer.js"
import { resolveSessionRuntimeContext } from "./session-runtime-context.js"

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

export const SendUserMessagePayload = Schema.Struct({
  commandId: Schema.optional(ActorCommandId),
  sessionId: SessionId,
  branchId: BranchId,
  content: Schema.String,
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
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
  runSpec: Schema.optional(RunSpecSchema),
}

export const SendUserMessageCommand = Schema.TaggedStruct("SendUserMessage", {
  ...RuntimeTurnFields,
  content: Schema.String,
  ...RuntimeTurnOptionFields,
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

export const SessionRuntimePhase = Schema.Literals(["idle", "running", "waiting-for-interaction"])
export type SessionRuntimePhase = typeof SessionRuntimePhase.Type

export const SessionRuntimeStatus = Schema.Literals(["idle", "running", "interrupted"])
export type SessionRuntimeStatus = typeof SessionRuntimeStatus.Type

export const SessionRuntimeStateSchema = Schema.Struct({
  phase: SessionRuntimePhase,
  status: SessionRuntimeStatus,
  agent: AgentName,
  queue: QueueSnapshot,
})
export type SessionRuntimeState = typeof SessionRuntimeStateSchema.Type

export const SessionRuntimeMetrics = Schema.Struct({
  turns: Schema.Number,
  tokens: Schema.Number,
  toolCalls: Schema.Number,
  retries: Schema.Number,
  durationMs: Schema.Number,
})
export type SessionRuntimeMetrics = typeof SessionRuntimeMetrics.Type

export interface SessionRuntimeService {
  readonly dispatch: (command: RuntimeCommand) => Effect.Effect<void, SessionRuntimeError>
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
}

const wrapError = (message: string, cause: Cause.Cause<unknown>) =>
  new SessionRuntimeError({ message, cause })

const makeCommandId = () => ActorCommandId.of(Bun.randomUUIDv7())
const userMessageIdForCommand = (commandId: ActorCommandId) => MessageId.of(commandId)
const toolCallIdForCommand = (commandId: ActorCommandId) => ToolCallId.of(commandId)
const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.of(`${commandId}:assistant`)
const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.of(`${commandId}:tool-result`)

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

export class SessionRuntime extends Context.Service<SessionRuntime, SessionRuntimeService>()(
  "@gent/core/src/runtime/session-runtime/SessionRuntime",
) {
  static Live = Layer.effect(
    SessionRuntime,
    Effect.gen(function* () {
      const agentLoop = yield* AgentLoop
      const storage = yield* Storage
      const eventPublisher = yield* EventPublisher
      const toolRunner = yield* ToolRunner
      const extensionRegistry = yield* ExtensionRegistry
      const resourceManager = yield* ResourceManager
      const profileCacheOpt = yield* Effect.serviceOption(SessionProfileCache)
      const profileCache = profileCacheOpt._tag === "Some" ? profileCacheOpt.value : undefined

      const die = (label: string) => () => Effect.die(`${label} not available`)
      const opt = <T>(
        svc: { _tag: "Some"; value: T } | { _tag: "None" },
        fallback: Record<string, unknown>,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ) => (svc._tag === "Some" ? svc.value : (fallback as unknown as T))

      const hostDeps: MakeExtensionHostContextDeps = {
        platform: opt(yield* Effect.serviceOption(RuntimePlatform), {
          cwd: "",
          home: "",
          platform: "unknown",
        }),
        extensionStateRuntime: opt(yield* Effect.serviceOption(MachineEngine), {
          send: die("MachineEngine"),
          execute: die("MachineEngine"),
        }),
        approvalService: opt(yield* Effect.serviceOption(ApprovalService), {
          present: die("ApprovalService"),
          storeResolution: die("ApprovalService"),
          respond: die("ApprovalService"),
          rehydrate: die("ApprovalService"),
        }),
        promptPresenter: opt(yield* Effect.serviceOption(PromptPresenter), {
          present: die("PromptPresenter"),
          confirm: die("PromptPresenter"),
          review: die("PromptPresenter"),
        }),
        extensionRegistry,
        turnControl: opt(yield* Effect.serviceOption(ExtensionTurnControl), {
          queueFollowUp: die("TurnControl"),
          interject: die("TurnControl"),
          bind: die("TurnControl"),
        }),
        storage,
        searchStorage: opt(yield* Effect.serviceOption(SearchStorage), {
          searchMessages: () => Effect.succeed([]),
        }),
        agentRunner: opt(yield* Effect.serviceOption(AgentRunnerService), {
          run: die("AgentRunnerService"),
        }),
        eventPublisher,
      }

      const dispatchCommand = Effect.fn("SessionRuntime.dispatchCommand")(function* (
        command: RuntimeCommand,
      ) {
        switch (command._tag) {
          case "SendUserMessage": {
            const commandId = command.commandId ?? makeCommandId()
            const runtimeCtx = yield* resolveSessionRuntimeContext({
              sessionId: command.sessionId,
              branchId: command.branchId,
              storage,
              hostDeps,
              profileCache,
            })
            const content = yield* runtimeCtx.extensionRegistry.runtimeSlots.normalizeMessageInput(
              {
                content: command.content,
                sessionId: command.sessionId,
                branchId: command.branchId,
              },
              runtimeCtx.hostCtx,
            )

            const message = new Message({
              id: userMessageIdForCommand(commandId),
              sessionId: command.sessionId,
              branchId: command.branchId,
              kind: "regular",
              role: "user",
              parts: [new TextPart({ type: "text", text: content })],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* agentLoop
              .submit(message, {
                ...(command.agentOverride !== undefined
                  ? { agentOverride: command.agentOverride }
                  : {}),
                ...(command.runSpec !== undefined ? { runSpec: command.runSpec } : {}),
              })
              .pipe(
                Effect.catchCause((cause) => {
                  if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                  return Effect.gen(function* () {
                    if (Cause.hasDies(cause)) {
                      yield* eventPublisher.publish(
                        new AgentRestarted({
                          sessionId: command.sessionId,
                          branchId: command.branchId,
                          attempt: 0,
                          error: Cause.pretty(cause),
                        }),
                      )
                    }
                    yield* eventPublisher.publish(
                      new ErrorOccurred({
                        sessionId: command.sessionId,
                        branchId: command.branchId,
                        error: Cause.pretty(cause),
                      }),
                    )
                    yield* Effect.logWarning("agent loop submission failed").pipe(
                      Effect.annotateLogs({ error: Cause.pretty(cause) }),
                    )
                  }).pipe(Effect.catchEager(() => Effect.void))
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
            const commandId = command.commandId ?? makeCommandId()
            const outputType = command.isError === true ? "error-json" : "json"
            const part = new ToolResultPart({
              type: "tool-result",
              toolCallId: command.toolCallId,
              toolName: command.toolName,
              output: { type: outputType, value: command.output },
            })

            const message = new Message({
              id: toolResultMessageIdForCommand(commandId),
              sessionId: command.sessionId,
              branchId: command.branchId,
              role: "tool",
              parts: [part],
              createdAt: yield* DateTime.nowAsDate,
            })

            yield* storage.createMessageIfAbsent(message)
            const isError = command.isError ?? false
            const toolCallFields = {
              sessionId: command.sessionId,
              branchId: command.branchId,
              toolCallId: command.toolCallId,
              toolName: command.toolName,
              summary: summarizeToolOutput(part),
              output: stringifyOutput(part.output.value),
            }
            yield* eventPublisher.publish(
              isError ? new ToolCallFailed(toolCallFields) : new ToolCallSucceeded(toolCallFields),
            )
            return
          }
          case "InvokeTool": {
            const commandId = command.commandId ?? makeCommandId()
            const toolCallId = toolCallIdForCommand(commandId)
            const currentTurnAgent = (yield* agentLoop.getState(command)).agent
            const runtimeCtx = yield* resolveSessionRuntimeContext({
              sessionId: command.sessionId,
              branchId: command.branchId,
              storage,
              hostDeps,
              profileCache,
            })

            yield* invokeToolPhase({
              assistantMessageId: assistantMessageIdForCommand(commandId),
              toolResultMessageId: toolResultMessageIdForCommand(commandId),
              toolCallId,
              toolName: command.toolName,
              input: command.input,
              publishEvent: (event) =>
                eventPublisher.publish(event).pipe(Effect.catchEager(() => Effect.void)),
              sessionId: command.sessionId,
              branchId: command.branchId,
              currentTurnAgent,
              toolRunner,
              extensionRegistry: runtimeCtx.extensionRegistry,
              permission: runtimeCtx.permission,
              hostCtx: runtimeCtx.hostCtx,
              resourceManager,
              storage,
            })
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

        drainQueuedMessages: (input) =>
          agentLoop
            .drainQueue(input)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.fail(wrapError("drainQueuedMessages failed", cause)),
              ),
            ),

        getQueuedMessages: (input) =>
          agentLoop
            .getQueue(input)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.fail(wrapError("getQueuedMessages failed", cause)),
              ),
            ),

        getState: (input) =>
          Effect.gen(function* () {
            const loopState = yield* agentLoop.getState(input)
            return {
              phase: loopState.phase,
              status: loopState.status,
              agent: loopState.agent,
              queue: loopState.queue,
            } satisfies SessionRuntimeState
          }).pipe(Effect.catchCause((cause) => Effect.fail(wrapError("getState failed", cause)))),

        getMetrics: (input) =>
          storage.listEvents({ sessionId: input.sessionId, branchId: input.branchId }).pipe(
            Effect.map((envelopes) => {
              let turns = 0
              let tokens = 0
              let toolCalls = 0
              let retries = 0
              let durationMs = 0
              for (const { event } of envelopes) {
                switch (event._tag) {
                  case "TurnCompleted":
                    turns++
                    durationMs += event.durationMs
                    break
                  case "StreamEnded":
                    if (event.usage !== undefined) {
                      tokens += event.usage.inputTokens + event.usage.outputTokens
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
              } satisfies SessionRuntimeMetrics
            }),
            Effect.catchEager(() =>
              Effect.succeed({
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
              } satisfies SessionRuntimeMetrics),
            ),
            Effect.catchCause((cause) => Effect.fail(wrapError("getMetrics failed", cause))),
          ),

        watchState: (input) =>
          agentLoop
            .watchState(input)
            .pipe(Effect.catchCause((cause) => Effect.fail(wrapError("watchState failed", cause)))),
      } satisfies SessionRuntimeService
    }),
  )

  static Test = (): Layer.Layer<SessionRuntime> =>
    Layer.succeed(SessionRuntime, {
      dispatch: () => Effect.void,
      drainQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
      getState: () =>
        Effect.succeed({
          phase: "idle" as const,
          status: "idle" as const,
          agent: "cowork" as const,
          queue: { steering: [], followUp: [] },
        }),
      getMetrics: () =>
        Effect.succeed({ turns: 0, tokens: 0, toolCalls: 0, retries: 0, durationMs: 0 }),
      watchState: () => Effect.succeed(Stream.empty),
    })
}
