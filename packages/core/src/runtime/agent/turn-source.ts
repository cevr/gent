import { Effect, Random, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as AiError from "effect/unstable/ai/AiError"
import type * as Response from "effect/unstable/ai/Response"
import { type ProviderAuthError, type TurnError } from "../../domain/driver.js"
import { ErrorOccurred, ProviderRetrying } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { ToolCallId, type BranchId, type SessionId } from "../../domain/ids.js"
import { ProviderError } from "../../domain/provider-error.js"
import { toPrompt } from "../../providers/ai-transcript.js"
import { ModelResolver } from "../../providers/model-resolver.js"
import { DriverRegistry } from "../extensions/driver-registry.js"
import type { ExtensionRegistry } from "../extensions/registry.js"
import { retryProviderCall } from "../retry"
import { providerStreamBoundary, WideEvent, withWideEvent } from "../wide-event-boundary"
import {
  CurrentExtensionHostContext,
  provideCurrentHostCtx,
} from "./current-extension-host-context.js"
import { convertTools, ToolRunner } from "./tool-runner"
import {
  collectFailedModelTurnResponse,
  formatStreamErrorMessage,
  type ActiveStreamHandle,
  type CollectedTurnResponse,
} from "./turn-response.js"
import type { ResolvedTurnContext } from "./turn-resolve.js"

export const toolCallsFromResponseParts = (
  parts: ReadonlyArray<Response.AnyPart>,
): ReadonlyArray<Prompt.ToolCallPart> =>
  parts.flatMap(
    (part): ReadonlyArray<Prompt.ToolCallPart> =>
      part.type === "tool-call"
        ? [
            Prompt.toolCallPart({
              id: part.id,
              name: part.name,
              params: part.params,
              providerExecuted: part.providerExecuted,
            }),
          ]
        : [],
  )

type ModelTurnSource = {
  readonly driverKind: "model"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, ProviderError>
  readonly formatStreamError: (streamError: ProviderError) => string
  readonly collect: <R>(
    effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
  ) => Effect.Effect<CollectedTurnResponse, ProviderAuthError, R | EventPublisher>
}

type ExternalTurnSource = {
  readonly driverKind: "external"
  readonly driverId?: string
  readonly stream: Stream.Stream<Response.AnyPart, TurnError, ExternalRunToolContext>
  readonly formatStreamError: (streamError: TurnError) => string
  readonly collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

type ExternalRunToolContext = ToolRunner | ExtensionRegistry | EventPublisher

export const resolveTurnSource = Effect.fn("TurnHelpers.resolveTurnSource")(function* (params: {
  resolved: ResolvedTurnContext
  sessionId: SessionId
  branchId: BranchId
  activeStream: ActiveStreamHandle
}) {
  const driverRegistry = yield* DriverRegistry
  const hostCtx = yield* CurrentExtensionHostContext
  const publishEventOrDie = (event: ErrorOccurred | ProviderRetrying) =>
    Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      yield* eventPublisher.publish(event).pipe(Effect.orDie)
    })
  const { resolved } = params
  if (resolved.driver?._tag === "external") {
    const externalDriver = yield* driverRegistry.getExternal(resolved.driver.id)
    const executor = externalDriver?.executor
    if (executor === undefined) {
      yield* publishEventOrDie(
        ErrorOccurred.make({
          sessionId: params.sessionId,
          branchId: params.branchId,
          error: `External driver "${resolved.driver.id}" not found`,
        }),
      )
      return undefined
    }

    return {
      driverKind: "external" as const,
      driverId: resolved.driver.id,
      stream: executor.executeTurn<ExternalRunToolContext>({
        sessionId: params.sessionId,
        branchId: params.branchId,
        agent: resolved.agent,
        messages: resolved.messages,
        tools: resolved.tools,
        systemPrompt: resolved.systemPrompt,
        cwd: hostCtx.cwd,
        abortSignal: params.activeStream.abortSignal,
        hostCtx,
        runTool: (toolName, args) =>
          Effect.gen(function* () {
            const toolRunner = yield* ToolRunner
            const toolCallId = ToolCallId.make(yield* Random.nextUUIDv4)
            const toolHostCtx = { ...hostCtx, toolCallId }
            return yield* toolRunner
              .run({ toolCallId, toolName, input: args }, toolHostCtx)
              .pipe(Effect.orDie, provideCurrentHostCtx(toolHostCtx))
          }),
      }),
      formatStreamError: (streamError: unknown) =>
        `External turn executor error: ${formatStreamErrorMessage(streamError)}`,
      collect: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } satisfies ExternalTurnSource
  }

  const modelResolver = yield* ModelResolver
  const modelRequest = {
    modelId: resolved.modelId,
    hints: {
      ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
      ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}),
    },
    driverRegistry,
    ...(resolved.driver?._tag === "model" && resolved.driver.id !== undefined
      ? { driverId: resolved.driver.id }
      : {}),
  }
  const prompt = toPrompt(resolved.messages, { systemPrompt: resolved.systemPrompt })
  const toolkit = convertTools([...resolved.tools])
  const rawStream = Stream.unwrap(
    modelResolver.resolve(modelRequest).pipe(
      Effect.map((model) =>
        resolved.tools.length > 0
          ? model.streamText({
              prompt,
              toolkit,
              disableToolCallResolution: true as const,
            })
          : model.streamText({ prompt }),
      ),
    ),
  )

  return {
    driverKind: "model" as const,
    stream: rawStream.pipe(
      Stream.mapError(
        (error: unknown) =>
          new ProviderError({
            message: AiError.isAiError(error) ? error.message : String(error),
            model: resolved.modelId,
            cause: error,
          }),
      ),
    ),
    formatStreamError: formatStreamErrorMessage,
    collect: <R>(
      effect: Effect.Effect<CollectedTurnResponse, ProviderError | ProviderAuthError, R>,
    ) =>
      // `ProviderAuthError` is a fail-closed credential-absence signal —
      // not retryable, not recoverable mid-turn. Let it escape so the RPC
      // seam surfaces the typed auth failure; narrow the retry scope to
      // transient `ProviderError` only.
      effect.pipe(
        retryProviderCall(undefined, {
          onRetry: ({ attempt, maxAttempts, delayMs, error }) =>
            publishEventOrDie(
              ProviderRetrying.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                attempt,
                maxAttempts,
                delayMs,
                error: error.message,
              }),
            ),
        }),
        Effect.catchTag("ProviderError", (streamError) =>
          collectFailedModelTurnResponse({
            streamError,
            sessionId: params.sessionId,
            branchId: params.branchId,
            activeStream: params.activeStream,
            formatStreamError: formatStreamErrorMessage,
          }),
        ),
        Effect.tap((collected) =>
          WideEvent.set({
            inputTokens: collected.messageProjection.usage?.inputTokens ?? 0,
            outputTokens: collected.messageProjection.usage?.outputTokens ?? 0,
            toolCallCount: toolCallsFromResponseParts(collected.responseParts).length,
            interrupted: collected.interrupted,
            streamFailed: collected.streamFailed,
          }),
        ),
        withWideEvent(providerStreamBoundary(resolved.modelId)),
      ),
  } satisfies ModelTurnSource
})
