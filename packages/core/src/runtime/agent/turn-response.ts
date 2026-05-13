import { Deferred, Effect, Stream, type Scope } from "effect"
import type * as Response from "effect/unstable/ai/Response"
import { DEFAULT_AGENT_NAME, type AgentName as AgentNameType } from "../../domain/agent.js"
import { TurnError } from "../../domain/driver.js"
import {
  ErrorOccurred,
  StreamChunk as EventStreamChunk,
  StreamEnded,
  ToolCallFailed,
  ToolCallStarted,
  ToolCallSucceeded,
  type AgentEvent,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { ToolCallId, type BranchId, type SessionId } from "../../domain/ids.js"
import type { InteractionPendingError } from "../../domain/interaction-request.js"
import { hasMessage } from "../../domain/guards.js"
import type { AssistantDraft } from "./agent-loop.state.js"
import {
  normalizeResponseParts,
  projectResponsePartsToMessageParts,
} from "../../domain/message-part-projection.js"
import { ProviderError } from "../../domain/provider-error.js"
import { summarizeOutput, stringifyOutput } from "../../domain/tool-output.js"
import type { AssistantResponsePart, ToolResponsePart } from "./turn-persistence.js"

/**
 * Cancellation handle for an in-flight turn stream. `interrupted` is the
 * single source of truth: succeeding it both unblocks
 * `Stream.interruptWhen(...)` and (via the constructor-wired listener)
 * aborts the underlying `AbortController` for AI SDK interop. Callers
 * read `Deferred.isDone(interrupted)` instead of a parallel boolean Ref.
 */
export type ActiveStreamHandle = {
  readonly interrupted: Deferred.Deferred<void>
  readonly abortSignal: AbortSignal
}

/**
 * Scoped: the forked listener that translates `Deferred.succeed(interrupted)`
 * into `abortController.abort()` lives for the duration of the supplied
 * scope. Clean turn completion closes the scope and interrupts the listener,
 * preventing the per-turn fiber-leak that a detached fork would produce.
 */
export const makeActiveStreamHandle = (): Effect.Effect<ActiveStreamHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const interrupted = yield* Deferred.make<void>()
    const abortController = new AbortController()
    yield* Effect.forkScoped(
      Deferred.await(interrupted).pipe(Effect.andThen(Effect.sync(() => abortController.abort()))),
    )
    return { interrupted, abortSignal: abortController.signal }
  })

export const signalActiveStreamInterrupt = (handle: ActiveStreamHandle): Effect.Effect<void> =>
  Deferred.succeed(handle.interrupted, undefined).pipe(Effect.asVoid)

const wasInterrupted = (handle: ActiveStreamHandle): Effect.Effect<boolean> =>
  Deferred.isDone(handle.interrupted)

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

export interface TurnResponseMessages {
  readonly assistant: ReadonlyArray<AssistantResponsePart>
  readonly tool: ReadonlyArray<ToolResponsePart>
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

const publishEventOrDie = (event: AgentEvent) =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    yield* eventPublisher.publish(event).pipe(Effect.orDie)
  })

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
  turnStream: Stream.Stream<Response.AnyPart, ProviderError>
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
      params.turnStream.pipe(Stream.interruptWhen(Deferred.await(params.activeStream.interrupted))),
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
            yield* publishEventOrDie(
              EventStreamChunk.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                chunk: part.delta,
              }),
            )
          }
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("ProviderError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* wasInterrupted(params.activeStream)
          if (interrupted) return false
          if (params.retryPreOutputFailures === true && !hasObservableOutput) {
            return yield* streamError
          }
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* publishEventOrDie(
            StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
          )
          yield* publishEventOrDie(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: params.formatStreamError(streamError),
            }),
          )
          return true
        }),
      ),
    )

    const interrupted = yield* wasInterrupted(params.activeStream)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "model",
    })
  })

export const collectFailedModelTurnResponse = (params: {
  streamError: ProviderError
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: ProviderError) => string
}) =>
  Effect.gen(function* () {
    const interrupted = yield* wasInterrupted(params.activeStream)
    if (!interrupted) {
      yield* Effect.logWarning("stream error before output, retries exhausted").pipe(
        Effect.annotateLogs({ error: String(params.streamError) }),
      )
      yield* publishEventOrDie(
        StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
      )
      yield* publishEventOrDie(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: params.formatStreamError(params.streamError),
        }),
      )
    }

    return collectNormalizedResponse({
      responseParts: [],
      streamFailed: !interrupted,
      interrupted,
      driverKind: "model",
    })
  })

const externalToolOutput = (
  part: Extract<Response.AnyPart, { readonly type: "tool-result" }>,
): { readonly type: "json" | "error-json"; readonly value: unknown } => ({
  type: part.isFailure ? "error-json" : "json",
  value: part.encodedResult,
})

const publishExternalStreamChunk = (params: {
  sessionId: SessionId
  branchId: BranchId
  chunk: string
}) =>
  publishEventOrDie(
    EventStreamChunk.make({
      sessionId: params.sessionId,
      branchId: params.branchId,
      chunk: params.chunk,
    }),
  )

const publishExternalToolCallStarted = (params: {
  sessionId: SessionId
  branchId: BranchId
  part: Extract<Response.AnyPart, { readonly type: "tool-call" }>
}) =>
  publishEventOrDie(
    ToolCallStarted.make({
      sessionId: params.sessionId,
      branchId: params.branchId,
      toolCallId: ToolCallId.make(params.part.id),
      toolName: params.part.name,
      input: params.part.params,
    }),
  )

const publishExternalToolResult = (params: {
  sessionId: SessionId
  branchId: BranchId
  part: Extract<Response.AnyPart, { readonly type: "tool-result" }>
}) => {
  const output = externalToolOutput(params.part)
  const fields = {
    sessionId: params.sessionId,
    branchId: params.branchId,
    toolCallId: ToolCallId.make(params.part.id),
    toolName: params.part.name,
    summary: summarizeOutput(output),
    output: stringifyOutput(output.value),
  }
  return publishEventOrDie(
    params.part.isFailure ? ToolCallFailed.make(fields) : ToolCallSucceeded.make(fields),
  )
}

const collectExternalResponsePart = (params: {
  sessionId: SessionId
  branchId: BranchId
  part: Response.AnyPart
  publishedToolCallIds: Set<string>
  publishedToolResultIds: Set<string>
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
      if (params.part.preliminary === true) return Effect.void
      if (params.publishedToolResultIds.has(params.part.id)) return Effect.void
      params.publishedToolResultIds.add(params.part.id)
      return publishExternalToolResult({ ...params, part: params.part })
    default:
      return Effect.void
  }
}

export const collectExternalTurnResponse = <R>(params: {
  turnStream: Stream.Stream<Response.AnyPart, TurnError | InteractionPendingError, R>
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
  formatStreamError: (streamError: TurnError) => string
}) =>
  Effect.gen(function* () {
    const responseParts: Response.AnyPart[] = []
    const publishedToolCallIds = new Set<string>()
    const publishedToolResultIds = new Set<string>()

    const streamFailed = yield* Stream.runForEach(
      params.turnStream.pipe(Stream.interruptWhen(Deferred.await(params.activeStream.interrupted))),
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
            sessionId: params.sessionId,
            branchId: params.branchId,
            part,
            publishedToolCallIds,
            publishedToolResultIds,
          })
        }),
    ).pipe(
      Effect.as(false),
      Effect.catchTag("TurnError", (streamError) =>
        Effect.gen(function* () {
          const interrupted = yield* wasInterrupted(params.activeStream)
          if (interrupted) return false
          yield* Effect.logWarning("stream error, persisting partial output").pipe(
            Effect.annotateLogs({ error: String(streamError) }),
          )
          yield* publishEventOrDie(
            StreamEnded.make({ sessionId: params.sessionId, branchId: params.branchId }),
          )
          yield* publishEventOrDie(
            ErrorOccurred.make({
              sessionId: params.sessionId,
              branchId: params.branchId,
              error: params.formatStreamError(streamError),
            }),
          )
          return true
        }),
      ),
    )

    const interrupted = yield* wasInterrupted(params.activeStream)
    return collectNormalizedResponse({
      responseParts,
      streamFailed,
      interrupted,
      driverKind: "external",
    })
  })
