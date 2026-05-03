import { Deferred, Effect, Ref, Stream } from "effect"
import type * as Response from "effect/unstable/ai/Response"
import { DEFAULT_AGENT_NAME, type AgentName as AgentNameType } from "../../../domain/agent.js"
import { TurnError } from "../../../domain/driver.js"
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

const formatToolFailureOutput = (
  part: Extract<Response.AnyPart, { readonly type: "tool-result" }>,
): string => {
  if (typeof part.encodedResult === "string") return part.encodedResult
  if (typeof part.result === "string") return part.result
  if (
    typeof part.encodedResult === "object" &&
    part.encodedResult !== null &&
    "error" in part.encodedResult &&
    typeof part.encodedResult.error === "string"
  ) {
    return part.encodedResult.error
  }
  return String(part.result)
}

const publishExternalStreamChunk = (params: {
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  chunk: string
}) =>
  params
    .publishEvent(
      new EventStreamChunk({
        sessionId: params.sessionId,
        branchId: params.branchId,
        chunk: params.chunk,
      }),
    )
    .pipe(Effect.orDie)

const publishExternalToolCallStarted = (params: {
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  part: Extract<Response.AnyPart, { readonly type: "tool-call" }>
}) =>
  params
    .publishEvent(
      ToolCallStarted.make({
        sessionId: params.sessionId,
        branchId: params.branchId,
        toolCallId: ToolCallId.make(params.part.id),
        toolName: params.part.name,
      }),
    )
    .pipe(Effect.orDie)

const publishExternalToolResult = (params: {
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  part: Extract<Response.AnyPart, { readonly type: "tool-result" }>
}) => {
  const output = formatToolFailureOutput(params.part)
  return params
    .publishEvent(
      params.part.isFailure
        ? ToolCallFailed.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: ToolCallId.make(params.part.id),
            toolName: params.part.name,
            output,
          })
        : ToolCallSucceeded.make({
            sessionId: params.sessionId,
            branchId: params.branchId,
            toolCallId: ToolCallId.make(params.part.id),
            toolName: params.part.name,
          }),
    )
    .pipe(Effect.orDie)
}

const collectExternalResponsePart = (params: {
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  part: Response.AnyPart
  publishedToolCallIds: Set<string>
}) => {
  switch (params.part.type) {
    case "text":
      return publishExternalStreamChunk({ ...params, chunk: params.part.text })
    case "text-delta":
      return publishExternalStreamChunk({ ...params, chunk: params.part.delta })
    case "tool-call":
      if (params.publishedToolCallIds.has(params.part.id)) return Effect.void
      params.publishedToolCallIds.add(params.part.id)
      return publishExternalToolCallStarted({ ...params, part: params.part })
    case "tool-result":
      return params.part.preliminary === true
        ? Effect.void
        : publishExternalToolResult({ ...params, part: params.part })
    default:
      return Effect.void
  }
}

export const collectExternalTurnResponse = (params: {
  turnStream: Stream.Stream<Response.AnyPart, TurnError>
  publishEvent: PublishEvent
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: TurnError) => string
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    const publishedToolCallIds = new Set<string>()

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(
        Stream.interruptWhen(Deferred.await(params.activeStream.interruptDeferred)),
      ),
      (part) =>
        Effect.gen(function* () {
          if (part.type === "error") {
            return yield* new TurnError({
              message: formatStreamErrorMessage(part.error),
              cause: part.error,
            })
          }
          responseParts.push(part)
          yield* collectExternalResponsePart({
            publishEvent: params.publishEvent,
            sessionId: params.sessionId,
            branchId: params.branchId,
            part,
            publishedToolCallIds,
          })
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
