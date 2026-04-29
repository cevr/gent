import { Deferred, Effect, Ref, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import { DEFAULT_AGENT_NAME, type AgentName as AgentNameType } from "../../../domain/agent.js"
import type { TurnError, TurnEvent } from "../../../domain/driver.js"
import {
  ErrorOccurred,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  type AgentEvent,
} from "../../../domain/event.js"
import { ToolCallId, type BranchId, type SessionId } from "../../../domain/ids.js"
import type {
  ImagePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../../../domain/message.js"
import { hasMessage } from "../../../domain/guards.js"
import type { AssistantDraft } from "../agent-loop.state.js"
import {
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
} from "../../../providers/ai-transcript.js"
import { ProviderError, type ProviderStreamPart } from "../../../providers/provider.js"

export type PublishEvent = (event: AgentEvent) => Effect.Effect<void, never, never>

export type ActiveStreamHandle = {
  abortController: AbortController
  interruptDeferred: Deferred.Deferred<void>
  interruptedRef: Ref.Ref<boolean>
}

/** Mutable accumulator for per-turn wide event fields. */
export type TurnMetrics = {
  agent: AgentNameType
  model: string
  inputTokens: number
  outputTokens: number
  toolCallCount: number
}

export const emptyTurnMetrics = (): TurnMetrics => ({
  agent: DEFAULT_AGENT_NAME,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  toolCallCount: 0,
})

type AssistantResponsePart = TextPart | ReasoningPart | ImagePart | ToolCallPart

export interface TurnResponseMessages {
  readonly assistant: ReadonlyArray<AssistantResponsePart>
  readonly tool: ReadonlyArray<ToolResultPart>
  readonly usage?: AssistantDraft["usage"]
}

export interface CollectedTurnResponse {
  readonly responseParts: ReadonlyArray<Response.AnyPart>
  readonly messageProjection: TurnResponseMessages
  readonly interrupted: boolean
  readonly streamFailed: boolean
  readonly driverKind: "model" | "external"
}

export const formatStreamErrorMessage = (streamError: unknown) => {
  if (streamError instanceof Error) return streamError.message
  if (hasMessage(streamError)) return streamError.message
  return String(streamError)
}

export const toResponseFinishReason = (stopReason: string): Response.FinishReason => {
  switch (stopReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "pause":
    case "other":
    case "unknown":
      return stopReason
    default:
      return "unknown"
  }
}

const finishedUsage = (
  usage: Response.FinishPart["usage"],
): AssistantDraft["usage"] | undefined => {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.inputTokens?.total ?? 0,
    outputTokens: usage.outputTokens?.total ?? 0,
  }
}

export const collectNormalizedResponse = (params: {
  responseParts: ReadonlyArray<Response.AnyPart>
  streamFailed: boolean
  interrupted: boolean
  driverKind: "model" | "external"
}): CollectedTurnResponse => {
  const normalized = normalizeResponseParts(params.responseParts)
  const messages = projectResponsePartsToMessageParts(normalized)
  const usage = normalized
    .filter((part): part is Response.FinishPart => part.type === "finish")
    .map((part) => finishedUsage(part.usage))
    .find((part) => part !== undefined)

  return {
    responseParts: normalized,
    messageProjection: {
      assistant: messages.assistant,
      tool: messages.tool,
      ...(usage !== undefined ? { usage } : {}),
    },
    interrupted: params.interrupted,
    streamFailed: params.streamFailed,
    driverKind: params.driverKind,
  }
}

const isObservableModelOutputPart = (part: Response.AnyPart): boolean => {
  switch (part.type) {
    case "text":
      return part.text.length > 0
    case "text-delta":
      return part.delta.length > 0
    case "reasoning":
      return part.text.length > 0
    case "reasoning-delta":
      return part.delta.length > 0
    case "file":
    case "tool-call":
    case "tool-approval-request":
      return true
    case "tool-result":
      return part.preliminary !== true
    default:
      return false
  }
}

export const collectModelTurnResponse = (params: {
  turnStream: Stream.Stream<ProviderStreamPart, ProviderError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  modelId: string
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
  retryPreOutputFailures?: boolean
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    let hasObservableOutput = false

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (part) =>
        Effect.gen(function* () {
          if (part.type === "error") {
            return yield* new ProviderError({
              message: formatStreamErrorMessage(part.error),
              model: params.modelId,
              cause: part.error,
            })
          }
          responseParts.push(part)
          hasObservableOutput = hasObservableOutput || isObservableModelOutputPart(part)
          if (part.type === "text-delta") {
            yield* params
              .publishEvent(
                new EventStreamChunk({
                  sessionId: params.sessionId,
                  branchId: params.branchId,
                  chunk: part.delta,
                }),
              )
              .pipe(Effect.orDie)
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("ProviderError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          if (params.retryPreOutputFailures === true && !hasObservableOutput) {
            return yield* streamError
          }
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params
            .publishEvent(
              StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              ErrorOccurred.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: params.formatStreamError(streamError),
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "model",
    })
  })

export const collectFailedModelTurnResponse = (params: {
  streamError: ProviderError
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
}) =>
  Effect.gen(function* () {
    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    if (!interrupted) {
      yield* Effect.logWarning("stream error before output, retries exhausted").pipe(
        Effect.annotateLogs({ error: String(params.streamError) }),
      )
      yield* params
        .publishEvent(StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }))
        .pipe(Effect.orDie)
      yield* params
        .publishEvent(
          ErrorOccurred.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            error: params.formatStreamError(params.streamError),
          }),
        )
        .pipe(Effect.orDie)
    }

    return collectNormalizedResponse({
      responseParts: [],
      streamFailed: !interrupted,
      interrupted,
      driverKind: "model",
    })
  })

export const collectExternalTurnResponse = (params: {
  turnStream: Stream.Stream<TurnEvent, TurnError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: TurnError) => string
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    const toolNamesById = new Map<string, string>()
    const toolCallIdsSeen = new Set<string>()

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (event) =>
        Effect.gen(function* () {
          switch (event._tag) {
            case "text-delta":
              responseParts.push(Response.makePart("text", { text: event.text }))
              yield* params
                .publishEvent(
                  new EventStreamChunk({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    chunk: event.text,
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "reasoning-delta":
              responseParts.push(Response.makePart("reasoning", { text: event.text }))
              return
            case "tool-call":
              toolNamesById.set(event.toolCallId, event.toolName)
              if (!toolCallIdsSeen.has(event.toolCallId)) {
                toolCallIdsSeen.add(event.toolCallId)
                responseParts.push(
                  Response.makePart("tool-call", {
                    id: event.toolCallId,
                    name: event.toolName,
                    params: event.input,
                    providerExecuted: false,
                  }),
                )
              }
              return
            case "tool-started":
              toolNamesById.set(event.toolCallId, event.toolName)
              if (!toolCallIdsSeen.has(event.toolCallId)) {
                toolCallIdsSeen.add(event.toolCallId)
                responseParts.push(
                  Response.makePart("tool-call", {
                    id: event.toolCallId,
                    name: event.toolName,
                    params: event.input ?? {},
                    providerExecuted: false,
                  }),
                )
              }
              yield* params
                .publishEvent(
                  ToolCallStarted.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName: event.toolName,
                  }),
                )
                .pipe(Effect.orDie)
              return
            case "tool-completed": {
              const toolName = toolNamesById.get(event.toolCallId) ?? "external"
              const output = event.output ?? null
              responseParts.push(
                Response.makePart("tool-result", {
                  id: event.toolCallId,
                  name: toolName,
                  result: output,
                  isFailure: false,
                  providerExecuted: false,
                  encodedResult: output,
                  preliminary: false,
                }),
              )
              yield* params
                .publishEvent(
                  ToolCallSucceeded.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName,
                  }),
                )
                .pipe(Effect.orDie)
              return
            }
            case "tool-failed": {
              const toolName = toolNamesById.get(event.toolCallId) ?? "external"
              const failurePayload = { error: event.error }
              responseParts.push(
                Response.makePart("tool-result", {
                  id: event.toolCallId,
                  name: toolName,
                  result: failurePayload,
                  isFailure: true,
                  providerExecuted: false,
                  encodedResult: failurePayload,
                  preliminary: false,
                }),
              )
              yield* params
                .publishEvent(
                  ToolCallFailed.make({
                    sessionId: params.sessionId,
                    branchId: params.branchId,
                    toolCallId: ToolCallId.make(event.toolCallId),
                    toolName,
                    output: event.error,
                  }),
                )
                .pipe(Effect.orDie)
              return
            }
            case "finished":
              responseParts.push(
                Response.makePart("finish", {
                  reason: toResponseFinishReason(event.stopReason),
                  usage: new Response.Usage({
                    inputTokens: {
                      uncached: undefined,
                      total: event.usage?.inputTokens,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: event.usage?.outputTokens,
                      text: undefined,
                      reasoning: undefined,
                    },
                  }),
                  response: undefined,
                }),
              )
              return
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("TurnError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
          if (interrupted) return false
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* params
            .publishEvent(
              StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
            )
            .pipe(Effect.orDie)
          yield* params
            .publishEvent(
              ErrorOccurred.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: params.formatStreamError(streamError),
              }),
            )
            .pipe(Effect.orDie)
          return true
        }),
      ),
    )

    const interrupted = yield* Ref.get(params.activeStream.interruptedRef)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "external",
    })
  })
