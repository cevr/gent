import { Context, Deferred, Duration, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import { ToolCallId } from "../domain/ids.js"
import { Auth } from "../domain/auth.js"
import type { ProviderAuthError, ProviderHints, ProviderResolution } from "../domain/driver.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiError from "effect/unstable/ai/AiError"
import type * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import { ProviderError } from "../domain/provider-error.js"
import { ModelResolver, resolveProviderModel, type ResolveModelRequest } from "./model-resolver.js"

// ── Provider Resolution ──

export type { ProviderResolution } from "../domain/driver.js"

// ── Provider Info ──

export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  isCustom: Schema.Boolean,
}) {}

const providerAiError = (method: string, message: string) =>
  AiError.make({
    module: "Provider",
    method,
    reason: new AiError.UnknownError({ description: message }),
  })

// ── Provider Error ──
// Definition lives in domain/ so `domain/driver.ts` can reference it without
// back-importing infrastructure. One brand, single source.

export { ProviderError }

// ── Provider Stream Parts ──

export type ProviderToolMap = Record<string, AiTool.Any>
// ── Provider Request ──

export interface ModelRequest {
  readonly model: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  /** Per-turn driver registry override (per-cwd profile). */
  readonly driverRegistry?: DriverRegistryService
  /** Per-agent driver id override (from `ModelDriverRef.id`). */
  readonly driverId?: string
}

// ── Provider Service ──

export interface ProviderService {
  readonly resolve: (
    request: ModelRequest,
  ) => Effect.Effect<ProviderResolution, ProviderError | ProviderAuthError>
}

const isModelReasoning = (value: string): value is NonNullable<ModelRequest["reasoning"]> =>
  value === "none" ||
  value === "minimal" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh"

export const modelResolverFromProvider = <E, R>(
  providerLayer: Layer.Layer<Provider, E, R>,
): Layer.Layer<ModelResolver, E, R> =>
  Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const provider = yield* Provider
      return {
        resolve: (request: ResolveModelRequest) =>
          Effect.gen(function* () {
            const hints = request.hints
            const reasoning = hints?.reasoning
            const modelRequest: ModelRequest = {
              model: request.modelId,
              ...(reasoning !== undefined && isModelReasoning(reasoning) ? { reasoning } : {}),
              ...(hints?.maxTokens !== undefined ? { maxTokens: hints.maxTokens } : {}),
              ...(hints?.temperature !== undefined ? { temperature: hints.temperature } : {}),
              ...(request.driverRegistry !== undefined
                ? { driverRegistry: request.driverRegistry }
                : {}),
              ...(request.driverId !== undefined ? { driverId: request.driverId } : {}),
            }
            const resolved = yield* provider.resolve(modelRequest)
            const context = yield* Effect.scoped(Layer.build(resolved))
            return Context.get(context, LanguageModel.LanguageModel)
          }),
      }
    }),
  ).pipe(Layer.provide(providerLayer))

// ── Response Encoding Toolkit ──

const makeEncodingToolkit = <Tools extends Record<string, AiTool.Any>>(
  tools: Tools,
): AiToolkit.WithHandler<Tools> => ({
  tools,
  handle: (name) =>
    Effect.fail(
      AiError.make({
        module: "Provider",
        method: "makeEncodingToolkit.handle",
        reason: new AiError.ToolConfigurationError({
          toolName: String(name),
          description: "provider response encoding does not execute tool handlers",
        }),
      }),
    ),
})

// ── Debug providers ──

const _extractLatestUserText = (promptInput: Prompt.RawInput): string => {
  const latest = [...Prompt.make(promptInput).content]
    .reverse()
    .find((message) => message.role === "user")
  if (latest === undefined) return ""
  return latest.content
    .filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const _retryBudgetFor = (text: string): number => {
  if (text.trim().length === 0) return 0
  const hash = [...text].reduce((total, ch) => total + ch.charCodeAt(0), 0)
  if (hash % 3 === 0) return 2
  if (hash % 2 === 0) return 1
  return 0
}

const _buildReply = (request: ModelRequest, latestUserText: string): string => {
  const lineCount = latestUserText.split("\n").filter((line) => line.trim().length > 0).length
  const modelLabel = request.model.startsWith("openai/") ? "deepwork" : "cowork"

  if (lineCount > 1) {
    return [
      `${modelLabel} processed a merged queued turn.`,
      `Received ${lineCount} lines in one message block.`,
      `Tail: ${latestUserText.split("\n").at(-1) ?? latestUserText}`,
    ].join(" ")
  }

  return [
    `${modelLabel} debug response.`,
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted provider.",
  ].join(" ")
}

const _makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const parts = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const stream = Stream.fromIterable([
    ...parts.map((text) => textDeltaPart(`${text} `)),
    finishPart({
      finishReason: "stop",
      usage: {
        inputTokens: Math.max(1, Math.ceil(latestUserText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
      },
    }),
  ])

  if (delayMs <= 0) return stream

  return stream.pipe(
    Stream.flatMap((chunk) =>
      Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(chunk))),
    ),
  )
}

const _testModel = (
  request: ModelRequest,
  streamText: (options: ProviderOptions) => Stream.Stream<ProviderStreamPart, AiError.AiError>,
  generateText: (options: ProviderOptions) => Effect.Effect<string, AiError.AiError>,
): ProviderResolution =>
  AiModel.make(
    "test",
    request.model,
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          generateText(options).pipe(
            Effect.map((text) => [_encodePart(options, Response.makePart("text", { text }))]),
          ),
        streamText: (options) =>
          streamText(options).pipe(Stream.map((part) => _encodeStreamPart(options, part))),
      }),
    ),
  )

const _encodePart = (
  options: ProviderOptions,
  part: Response.Part<ProviderToolMap>,
): Response.PartEncoded =>
  Schema.encodeUnknownSync(Response.Part(_toolkitFromProviderOptions(options)))(part)

const _encodeStreamPart = (
  options: ProviderOptions,
  part: ProviderStreamPart,
): Response.StreamPartEncoded =>
  Schema.encodeUnknownSync(Response.StreamPart(_toolkitFromProviderOptions(options)))(part)

const _toolkitFromProviderOptions = (
  options: ProviderOptions,
): AiToolkit.WithHandler<ProviderToolMap> => {
  const toolsRecord: ProviderToolMap = {}
  for (const tool of options.tools) {
    toolsRecord[tool.name] = tool
  }
  return makeEncodingToolkit(toolsRecord)
}

// Forward-reference Provider class below via late binding — these
// closures are only invoked at runtime (never during module init),
// so `Provider` is fully defined by then.

export const DebugSlowProviderDelayMs = 250

const _DebugProvider = (options?: { delayMs?: number; retries?: boolean }) =>
  Layer.effect(
    Provider,
    Effect.sync(() => {
      const delayMs = options?.delayMs ?? 0
      const retries = options?.retries ?? delayMs === 0
      const attempts = new Map<string, number>()

      const resolve = (request: ModelRequest) =>
        Effect.suspend(() =>
          Effect.succeed(
            _testModel(
              request,
              (modelOptions) =>
                Effect.suspend(() => {
                  const latestUserText = _extractLatestUserText(modelOptions.prompt)
                  const key = `${request.model}:${latestUserText}`
                  const seen = attempts.get(key) ?? 0
                  const retryBudget = retries ? _retryBudgetFor(latestUserText) : 0

                  if (seen < retryBudget) {
                    attempts.set(key, seen + 1)
                    return Effect.fail(
                      providerAiError("Debug.streamText", "Rate limit exceeded (429)"),
                    )
                  }

                  attempts.delete(key)
                  const reply = _buildReply(request, latestUserText)
                  return Effect.succeed(_makeReplyStream(latestUserText, reply, delayMs))
                }).pipe(Stream.unwrap),
              () => Effect.succeed("debug scenario"),
            ),
          ),
        )

      return { resolve }
    }),
  )

// Lazy — `Provider` class is defined below; this is only evaluated when accessed.
let _debugFailingProviderCache: Layer.Layer<Provider> | undefined
const _DebugFailingProvider = () => {
  if (_debugFailingProviderCache === undefined) {
    _debugFailingProviderCache = Layer.succeed(Provider, {
      resolve: (request: ModelRequest) =>
        Effect.succeed(
          _testModel(
            request,
            () => Stream.fail(providerAiError("Failing.streamText", "provider exploded")),
            () => Effect.fail(providerAiError("Failing.generateText", "provider exploded")),
          ),
        ),
    } satisfies ProviderService)
  }
  return _debugFailingProviderCache
}

// ── Stream-part helpers (test-only) ──

export type ProviderStreamPart<Tools extends ProviderToolMap = ProviderToolMap> =
  Response.StreamPart<Tools>

export interface SignalProviderControls {
  readonly emitNext: () => Effect.Effect<void>
  readonly emitAll: () => Effect.Effect<void>
  readonly waitForStreamStart: Effect.Effect<void>
}

export interface SequenceStep {
  readonly parts: ReadonlyArray<ProviderStreamPart>
  readonly assertRequest?: (request: ModelRequest) => void
  readonly assertOptions?: (options: ProviderOptions) => void
  readonly gated?: boolean
}

export interface SequenceProviderControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: () => Effect.Effect<void>
}

let _streamPartIdCounter = 0
const _makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (text: string, id = _makeStreamPartId("text")): ProviderStreamPart =>
  Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): ProviderStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.make(_makeStreamPartId("tool")),
    name: toolName,
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = _makeStreamPartId("reasoning"),
): ProviderStreamPart => Response.makePart("reasoning-delta", { id, delta: text })

export const finishPart = (params: {
  finishReason: Response.FinishReason
  usage?: { inputTokens: number; outputTokens: number }
}): ProviderStreamPart =>
  Response.makePart("finish", {
    reason: params.finishReason,
    usage: new Response.Usage({
      inputTokens: {
        uncached: undefined,
        total: params.usage?.inputTokens,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: params.usage?.outputTokens,
        text: undefined,
        reasoning: undefined,
      },
    }),
    response: undefined,
  })

const _SignalProvider = (
  reply: string,
  options?: { inputTokens?: number; outputTokens?: number },
) =>
  Effect.gen(function* () {
    const gate = yield* Queue.unbounded<null>()
    const streamStarted = yield* Deferred.make<void>()

    const parts = reply
      .split(/(?<=[.!?])\s+/)
      .filter((chunk) => chunk.length > 0)
      .map((text) => textDeltaPart(`${text} `))

    const allParts = [
      ...parts,
      finishPart({
        finishReason: "stop",
        usage: {
          inputTokens: options?.inputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
          outputTokens: options?.outputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
        },
      }),
    ]

    const layer = Layer.succeed(Provider, {
      resolve: (request: ModelRequest) =>
        Effect.succeed(
          _testModel(
            request,
            () =>
              Stream.fromEffect(Deferred.succeed(streamStarted, void 0)).pipe(
                Stream.flatMap(() =>
                  Stream.fromIterable(allParts).pipe(
                    Stream.mapEffect((part) => Queue.take(gate).pipe(Effect.as(part))),
                  ),
                ),
              ),
            () => Effect.succeed(reply),
          ),
        ),
    })

    const controls: SignalProviderControls = {
      emitNext: () => Queue.offer(gate, null).pipe(Effect.asVoid),
      emitAll: () => Effect.forEach(allParts, () => Queue.offer(gate, null).pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

const _SequenceProvider = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)

    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (step.gated || gate === undefined) return Effect.void
      return Deferred.succeed(gate, void 0)
    })

    const layer = Layer.succeed(Provider, {
      resolve: (request: ModelRequest) => {
        const streamText = (options: ProviderOptions) =>
          Effect.gen(function* () {
            const idx = yield* Ref.getAndUpdate(indexRef, (n) => n + 1)

            if (idx >= steps.length) {
              return yield* providerAiError(
                "Sequence.streamText",
                `Sequence provider: streamText() called ${idx + 1} times but only ${steps.length} steps scripted`,
              )
            }

            const step = steps[idx] ?? steps[0]
            const started = callStarted[idx] ?? callStarted[0]
            const gate = emitGates[idx] ?? emitGates[0]

            if (started !== undefined) yield* Deferred.succeed(started, void 0)

            if (step?.assertRequest) {
              yield* Effect.try({
                try: () => step.assertRequest?.(request),
                catch: (e) =>
                  providerAiError(
                    "Sequence.streamText",
                    `Sequence provider: assertRequest failed at step ${idx}: ${e}`,
                  ),
              })
            }

            if (step?.assertOptions) {
              yield* Effect.try({
                try: () => step.assertOptions?.(options),
                catch: (e) =>
                  providerAiError(
                    "Sequence.streamText",
                    `Sequence provider: assertOptions failed at step ${idx}: ${e}`,
                  ),
              })
            }

            if (gate !== undefined) {
              return Stream.fromEffect(Deferred.await(gate)).pipe(
                Stream.flatMap(() => Stream.fromIterable(step?.parts ?? [])),
              )
            }
            return Stream.fromIterable(step?.parts ?? [])
          }).pipe(Stream.unwrap)

        return Effect.succeed(
          _testModel(request, streamText, () => Effect.succeed("sequence provider")),
        )
      },
    })

    const controls: SequenceProviderControls = {
      waitForCall: (index) => {
        const deferred = callStarted[index]
        if (index < 0 || index >= steps.length || deferred === undefined) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },

      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || deferred === undefined) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },

      callCount: Ref.get(indexRef),

      assertDone: () =>
        Effect.gen(function* () {
          const consumed = yield* Ref.get(indexRef)
          if (consumed >= steps.length) return
          return yield* Effect.die(
            new Error(
              `Sequence provider: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
            ),
          )
        }),
    }

    return { layer, controls }
  })

// ── Provider Live ──

export class Provider extends Context.Service<Provider, ProviderService>()(
  "@gent/core/src/providers/provider",
) {
  static Live: Layer.Layer<Provider, never, Auth | DriverRegistry> = Layer.effect(
    Provider,
    Effect.gen(function* () {
      const authStore = yield* Auth
      const registry = yield* DriverRegistry

      const resolve = Effect.fn("Provider.resolve")(function* (request: ModelRequest) {
        const hints: ProviderHints = {
          reasoning: request.reasoning,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
        }
        const model = yield* resolveProviderModel(authStore, registry, {
          modelId: request.model,
          hints,
          driverRegistry: request.driverRegistry,
          driverId: request.driverId,
        })
        return model
      })

      return { resolve } satisfies ProviderService
    }),
  )

  static TestStream = (
    stream: (
      request: ModelRequest,
      options: ProviderOptions,
    ) => Effect.Effect<Stream.Stream<ProviderStreamPart, AiError.AiError>, AiError.AiError>,
  ): Layer.Layer<Provider> =>
    Layer.succeed(Provider, {
      resolve: (request) =>
        Effect.succeed(
          _testModel(
            request,
            (options) => stream(request, options).pipe(Stream.unwrap),
            () => Effect.succeed("test response"),
          ),
        ),
    })

  // ── Debug provider statics ──

  /** Debug provider — canned text responses, optional delays/retries. */
  static Debug = _DebugProvider

  /** Always-failing provider for error path tests. */
  static get Failing() {
    return _DebugFailingProvider()
  }

  /**
   * Scripted provider — replays a list of `SequenceStep`s in order.
   * Returns `{ layer, controls }`; `controls` exposes `waitForCall`,
   * `emitAll`, `callCount`, and `assertDone` for deterministic tests.
   */
  static Sequence = _SequenceProvider

  /**
   * Per-chunk-gated provider — yields one stream part per `emitNext()` call.
   * Returns `{ layer, controls }`; use `controls.waitForStreamStart` then
   * `controls.emitNext()` / `controls.emitAll()` to drive lifecycle assertions.
   */
  static Signal = _SignalProvider
}
