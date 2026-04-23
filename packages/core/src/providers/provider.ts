import { Context, Deferred, Duration, Effect, Layer, Queue, Ref, Schema, Stream } from "effect"
import type { AnyCapabilityContribution } from "../domain/capability.js"
import type { Message, TextPart, ToolResultPart } from "../domain/message.js"
import { ToolCallId } from "../domain/ids.js"
import { AuthOauth, AuthStore, type AuthInfo, type AuthStoreService } from "../domain/auth-store.js"
import {
  Finished,
  ReasoningDelta,
  TextDelta,
  ToolCall,
  type ProviderAuthInfo,
  type ProviderHints,
  type TurnEvent,
} from "../domain/driver.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as AiError from "effect/unstable/ai/AiError"

// ── Provider Resolution ──

export type { ProviderResolution } from "../domain/driver.js"

// ── Provider Info ──

export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  isCustom: Schema.Boolean,
}) {}

const parseModelId = (modelId: string): [string, string] | undefined => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return undefined
  return [modelId.slice(0, slash), modelId.slice(slash + 1)]
}

// ── Model Resolver ──

const makeModelResolver = (authStore: AuthStoreService, defaultRegistry: DriverRegistryService) => {
  const resolveAuthFromStore = (providerName: string) =>
    authStore
      .get(providerName)
      .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))

  return Effect.fn("Provider.resolveModel")(function* (
    modelId: string,
    hints?: ProviderHints,
    /**
     * Per-turn driver registry override. When the agent loop resolves a turn
     * inside a per-cwd profile, it forwards that profile's `DriverRegistry`
     * here so project/user-scope driver overrides take effect for model turns.
     * Falls back to the registry captured at `Provider.Live` construction.
     */
    overrideRegistry?: DriverRegistryService,
    /**
     * Optional model-driver id from `agent.driver: ModelDriverRef`. When set,
     * overrides the provider segment parsed from `modelId` so an agent can
     * pick a non-default driver for a model that exists under multiple driver
     * implementations.
     */
    driverIdOverride?: string,
  ) {
    const parsed = parseModelId(modelId)
    if (parsed === undefined) {
      return yield* new ProviderError({
        message: "Invalid model id (expected provider/model)",
        model: modelId,
      })
    }
    const [parsedProviderName, modelName] = parsed
    const providerName = driverIdOverride ?? parsedProviderName
    const driverRegistry = overrideRegistry ?? defaultRegistry

    const extensionProvider = yield* driverRegistry.getModel(providerName)
    if (extensionProvider === undefined) {
      return yield* new ProviderError({
        message: `Unknown provider: ${providerName}`,
        model: modelId,
      })
    }

    const authInfo = yield* resolveAuthFromStore(providerName)
    let authParam: ProviderAuthInfo | undefined
    if (authInfo?.type === "api") {
      authParam = { type: "api", key: authInfo.key }
    } else if (authInfo?.type === "oauth") {
      authParam = {
        type: "oauth",
        access: authInfo.access,
        refresh: authInfo.refresh,
        expires: authInfo.expires,
        accountId: authInfo.accountId,
        persist: (updated) =>
          authStore
            .set(
              providerName,
              new AuthOauth({
                type: "oauth",
                access: updated.access,
                refresh: updated.refresh,
                expires: updated.expires,
                ...(updated.accountId !== undefined ? { accountId: updated.accountId } : {}),
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void)),
      }
    }

    const resolved = yield* Effect.try({
      try: () => extensionProvider.resolveModel(modelName, authParam, hints),
      catch: (e) =>
        new ProviderError({
          message: `Extension provider "${providerName}" failed: ${e instanceof Error ? e.message : String(e)}`,
          model: modelId,
        }),
    })

    return resolved
  })
}

// ── Provider Error ──

export class ProviderError extends Schema.TaggedErrorClass<ProviderError>()("ProviderError", {
  message: Schema.String,
  model: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// ── Provider Stream Parts ──

export type ProviderStreamPart = Response.StreamPart<Record<string, AiTool.Any>>
export type ProviderStream = Stream.Stream<ProviderStreamPart, ProviderError>

const toUsage = (usage: Response.FinishPart["usage"]) =>
  usage !== undefined
    ? {
        inputTokens: usage.inputTokens.total ?? 0,
        outputTokens: usage.outputTokens.total ?? 0,
      }
    : undefined

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (text: string, id = makeStreamPartId("text")): ProviderStreamPart =>
  Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): ProviderStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.of(makeStreamPartId("tool")),
    name: toolName,
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = makeStreamPartId("reasoning"),
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

export const toTurnEvent =
  (model: string) =>
  (part: ProviderStreamPart): Effect.Effect<TurnEvent | undefined, ProviderError> => {
    switch (part.type) {
      case "text-delta":
        return Effect.succeed(new TextDelta({ text: part.delta }))
      case "reasoning-delta":
        return Effect.succeed(new ReasoningDelta({ text: part.delta }))
      case "tool-call":
        return Effect.succeed(
          new ToolCall({
            toolCallId: ToolCallId.of(part.id),
            toolName: part.name,
            input: part.params,
          }),
        )
      case "finish":
        return Effect.succeed(
          new Finished({
            stopReason: part.reason,
            ...(toUsage(part.usage) !== undefined ? { usage: toUsage(part.usage) } : {}),
          }),
        )
      case "error":
        return Effect.fail(
          new ProviderError({
            message: `API error: ${String(part.error)}`,
            model,
          }),
        )
      default:
        return Effect.succeed(undefined)
    }
  }

export const toTurnEventStream = (model: string, stream: ProviderStream) =>
  stream.pipe(
    Stream.mapEffect(toTurnEvent(model)),
    Stream.filter((event): event is TurnEvent => event !== undefined),
  )

// ── Provider Request ──

export interface ProviderRequest {
  readonly model: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<AnyCapabilityContribution>
  readonly systemPrompt?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  readonly abortSignal?: AbortSignal
  readonly providerOptions?: unknown
  /** Per-turn driver registry override (per-cwd profile). */
  readonly driverRegistry?: DriverRegistryService
  /** Per-agent driver id override (from `ModelDriverRef.id`). */
  readonly driverId?: string
}

// Simple generate request (no tools, no streaming)

export interface GenerateRequest {
  readonly model: string
  readonly prompt: string
  readonly systemPrompt?: string
  readonly maxTokens?: number
  /** Per-turn driver registry override (per-cwd profile). */
  readonly driverRegistry?: DriverRegistryService
  /** Per-agent driver id override (from `ModelDriverRef.id`). */
  readonly driverId?: string
}

// ── Provider Service ──

export interface ProviderService {
  readonly stream: (request: ProviderRequest) => Effect.Effect<ProviderStream, ProviderError>

  readonly generate: (request: GenerateRequest) => Effect.Effect<string, ProviderError>
}

// ── Message Conversion (our MessagePart → Prompt.Message) ──

/** @internal — exported for testing */
export function convertMessages(messages: ReadonlyArray<Message>): Prompt.Message[] {
  const result: Prompt.Message[] = []

  for (const msg of messages) {
    const parts = msg.parts

    if (msg.role === "system") {
      const textParts = parts.filter((p): p is TextPart => p.type === "text")
      if (textParts.length > 0) {
        const text = textParts.map((p) => p.text).join("\n")
        result.push(Prompt.systemMessage({ content: text }))
      }
      continue
    }

    if (msg.role === "tool") {
      const toolResults = parts.filter((p): p is ToolResultPart => p.type === "tool-result")
      if (toolResults.length > 0) {
        result.push(
          Prompt.toolMessage({
            content: toolResults.map((p) =>
              Prompt.toolResultPart({
                id: p.toolCallId,
                name: p.toolName,
                isFailure: p.output.type === "error-json",
                result: p.output.value,
              }),
            ),
          }),
        )
      }
      continue
    }

    if (msg.role === "user") {
      const content: Prompt.UserMessagePart[] = []
      for (const part of parts) {
        if (part.type === "text") {
          content.push(Prompt.textPart({ text: part.text }))
        } else if (part.type === "image") {
          content.push(Prompt.filePart({ data: part.image, mediaType: "image/png" }))
        }
      }
      if (content.length > 0) {
        result.push(Prompt.userMessage({ content }))
      }
      continue
    }

    if (msg.role === "assistant") {
      const content: Prompt.AssistantMessagePart[] = []
      for (const part of parts) {
        if (part.type === "text") {
          content.push(Prompt.textPart({ text: part.text }))
        } else if (part.type === "tool-call") {
          content.push(
            Prompt.toolCallPart({
              id: part.toolCallId,
              name: part.toolName,
              params: part.input,
              providerExecuted: false,
            }),
          )
        }
      }
      if (content.length > 0) {
        result.push(Prompt.assistantMessage({ content }))
      }
    }
  }

  return result
}

// ── Tool Conversion (Capability → Toolkit.WithHandler) ──

// Tool JSON schema conversion — canonical implementation in domain/tool-schema.ts
import { buildToolJsonSchema } from "../domain/tool-schema.js"

/** @internal — exported for testing */
export function convertTools(
  tools: ReadonlyArray<AnyCapabilityContribution>,
): AiToolkit.WithHandler<Record<string, AiTool.Any>> {
  const toolsRecord: Record<string, AiTool.Any> = {}

  for (const capability of tools) {
    const flat = buildToolJsonSchema(capability)
    toolsRecord[capability.id] = AiTool.dynamic(capability.id, {
      description: capability.description ?? "",
      parameters: flat,
    })
  }

  // Manual WithHandler construction — Toolkit.make().asEffect() eagerly resolves
  // handlers from context which crashes when none are provided. Since we use
  // disableToolCallResolution: true, handlers are never called.
  return {
    tools: toolsRecord,
    handle: (() =>
      Effect.die("unreachable: disableToolCallResolution is true")) as AiToolkit.WithHandler<
      Record<string, AiTool.Any>
    >["handle"],
  }
}

// ── Debug / test providers ──
//
// Formerly in `debug/provider.ts`. Inlined here so the static methods
// on Provider (`Provider.Debug`, `Provider.Sequence`, etc.) avoid a
// circular ESM import.

const _extractLatestUserText = (messages: ReadonlyArray<Message>): string => {
  const latest = [...messages].reverse().find((message) => message.role === "user")
  if (latest === undefined) return ""
  return latest.parts
    .filter((part): part is TextPart => part.type === "text")
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

const _buildReply = (request: ProviderRequest, latestUserText: string): string => {
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

// Forward-reference Provider class below via late binding — these
// closures are only invoked at runtime (never during module init),
// so `Provider` is fully defined by then.

const _DebugProvider = (options?: { delayMs?: number; retries?: boolean }) =>
  Layer.effect(
    Provider,
    Effect.sync(() => {
      const delayMs = options?.delayMs ?? 0
      const retries = options?.retries ?? delayMs === 0
      const attempts = new Map<string, number>()

      const stream = (request: ProviderRequest) =>
        Effect.suspend(() => {
          const latestUserText = _extractLatestUserText(request.messages)
          const key = `${request.model}:${latestUserText}`
          const seen = attempts.get(key) ?? 0
          const retryBudget = retries ? _retryBudgetFor(latestUserText) : 0

          if (seen < retryBudget) {
            attempts.set(key, seen + 1)
            return Effect.fail(
              new ProviderError({
                message: "Rate limit exceeded (429)",
                model: request.model,
              }),
            )
          }

          attempts.delete(key)
          const reply = _buildReply(request, latestUserText)
          return Effect.succeed(_makeReplyStream(latestUserText, reply, delayMs))
        })

      const generate = (_request: GenerateRequest) => Effect.succeed("debug scenario")

      return { stream, generate }
    }),
  )

// Lazy — `Provider` class is defined below; this is only evaluated when accessed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _debugFailingProviderCache: any
const _DebugFailingProvider = () => {
  if (_debugFailingProviderCache === undefined) {
    _debugFailingProviderCache = Layer.succeed(Provider, {
      stream: (request: ProviderRequest) =>
        Effect.fail(
          new ProviderError({
            message: "provider exploded",
            model: request.model,
          }),
        ),
      generate: () => Effect.succeed("debug failure"),
    } satisfies ProviderService)
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return _debugFailingProviderCache
}

export interface SignalProviderControls {
  readonly emitNext: () => Effect.Effect<void>
  readonly emitAll: () => Effect.Effect<void>
  readonly waitForStreamStart: Effect.Effect<void>
}

const _createSignalProvider = (
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
      stream: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
          return Stream.fromIterable(allParts).pipe(
            Stream.mapEffect((part) => Queue.take(gate).pipe(Effect.as(part))),
          )
        }),
      generate: () => Effect.succeed(reply),
    })

    const controls: SignalProviderControls = {
      emitNext: () => Queue.offer(gate, null).pipe(Effect.asVoid),
      emitAll: () => Effect.forEach(allParts, () => Queue.offer(gate, null).pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

export interface SequenceStep {
  readonly parts: ReadonlyArray<ProviderStreamPart>
  readonly assertRequest?: (request: ProviderRequest) => void
  readonly gated?: boolean
}

export interface SequenceProviderControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: () => Effect.Effect<void>
}

const _createSequenceProvider = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)

    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (!step.gated && gate) return Deferred.succeed(gate, void 0)
      return Effect.void
    })

    const layer = Layer.succeed(Provider, {
      stream: (request: ProviderRequest) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(indexRef, (n) => n + 1)

          if (idx >= steps.length) {
            return yield* new ProviderError({
              message: `Sequence provider: stream() called ${idx + 1} times but only ${steps.length} steps scripted`,
              model: request.model,
            })
          }

          const step = steps[idx] ?? steps[0]
          const started = callStarted[idx] ?? callStarted[0]
          const gate = emitGates[idx] ?? emitGates[0]

          if (started) yield* Deferred.succeed(started, void 0)

          if (step?.assertRequest) {
            yield* Effect.try({
              try: () => step.assertRequest?.(request),
              catch: (e) =>
                new ProviderError({
                  message: `Sequence provider: assertRequest failed at step ${idx}: ${e}`,
                  model: request.model,
                }),
            })
          }

          if (gate) {
            return Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.fromIterable(step?.parts ?? [])),
            )
          }
          return Stream.fromIterable(step?.parts ?? [])
        }),
      generate: () => Effect.succeed("sequence provider"),
    })

    const controls: SequenceProviderControls = {
      waitForCall: (index) => {
        const deferred = callStarted[index]
        if (index < 0 || index >= steps.length || !deferred) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },

      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || !deferred) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },

      callCount: Ref.get(indexRef),

      assertDone: () =>
        Effect.gen(function* () {
          const consumed = yield* Ref.get(indexRef)
          if (consumed < steps.length) {
            return yield* Effect.die(
              new Error(
                `Sequence provider: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
              ),
            )
          }
        }),
    }

    return { layer, controls }
  })

// ── Step builders ──

let _stepCallIdCounter = 0

const _makeStepToolCallId = () => ToolCallId.of(`step-tc-${++_stepCallIdCounter}`)

/** A turn that emits a single text response and finishes with "stop". */
export const textStep = (text: string): SequenceStep => ({
  parts: [
    textDeltaPart(text),
    finishPart({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
    }),
  ],
})

/** A turn that emits a single tool call and finishes with "tool-calls". */
export const toolCallStep = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  parts: [
    toolCallPart(toolName, input, { toolCallId: options?.toolCallId ?? _makeStepToolCallId() }),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  ],
})

/** A turn that emits text before a tool call. */
export const textThenToolCallStep = (
  text: string,
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  parts: [
    textDeltaPart(text),
    toolCallPart(toolName, input, { toolCallId: options?.toolCallId ?? _makeStepToolCallId() }),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) + 20 },
    }),
  ],
})

/** A turn that emits multiple tool calls and finishes with "tool-calls". */
export const multiToolCallStep = (
  ...calls: ReadonlyArray<{ toolName: string; input: unknown; toolCallId?: ToolCallId }>
): SequenceStep => ({
  parts: [
    ...calls.map((c) =>
      toolCallPart(c.toolName, c.input, { toolCallId: c.toolCallId ?? _makeStepToolCallId() }),
    ),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 * calls.length },
    }),
  ],
})

// ── Provider Live ──

export class Provider extends Context.Service<Provider, ProviderService>()(
  "@gent/core/src/providers/provider",
) {
  static Live: Layer.Layer<Provider, never, AuthStore | DriverRegistry> = Layer.effect(
    Provider,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const registry = yield* DriverRegistry
      const getModel = makeModelResolver(authStore, registry)

      return {
        stream: Effect.fn("Provider.stream")(function* (request: ProviderRequest) {
          const hints: ProviderHints = {
            reasoning: request.reasoning,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
          }
          const resolution = yield* getModel(
            request.model,
            hints,
            request.driverRegistry,
            request.driverId,
          )
          const modelLayer = resolution.layer

          // Build prompt
          const msgs = convertMessages(request.messages)
          const promptMessages: Prompt.Message[] =
            request.systemPrompt !== undefined && request.systemPrompt !== ""
              ? [Prompt.systemMessage({ content: request.systemPrompt }), ...msgs]
              : msgs

          // Build tools
          const withHandler = request.tools !== undefined ? convertTools(request.tools) : undefined

          // Create stream via LanguageModel service
          const rawStream =
            withHandler !== undefined
              ? LanguageModel.streamText({
                  prompt: Prompt.make(promptMessages),
                  toolkit: withHandler,
                  disableToolCallResolution: true as const,
                })
              : LanguageModel.streamText({
                  prompt: Prompt.make(promptMessages),
                })

          return rawStream.pipe(
            Stream.provide(modelLayer),
            Stream.catch((error: unknown) =>
              Stream.fail(
                new ProviderError({
                  message: AiError.isAiError(error) ? error.message : String(error),
                  model: request.model,
                  cause: error,
                }),
              ),
            ),
          )
        }),

        generate: Effect.fn("Provider.generate")(function* (request: GenerateRequest) {
          const hints: ProviderHints = { maxTokens: request.maxTokens }
          const resolution = yield* getModel(
            request.model,
            hints,
            request.driverRegistry,
            request.driverId,
          )
          const modelLayer = resolution.layer

          const promptMessages: Prompt.Message[] =
            request.systemPrompt !== undefined && request.systemPrompt !== ""
              ? [
                  Prompt.systemMessage({ content: request.systemPrompt }),
                  Prompt.userMessage({ content: [Prompt.textPart({ text: request.prompt })] }),
                ]
              : [Prompt.userMessage({ content: [Prompt.textPart({ text: request.prompt })] })]

          const result = yield* LanguageModel.generateText({
            prompt: Prompt.make(promptMessages),
          }).pipe(
            // @effect-diagnostics-next-line strictEffectProvide:off
            Effect.provide(modelLayer),
            Effect.mapError(
              (error: unknown) =>
                new ProviderError({
                  message: AiError.isAiError(error) ? error.message : `Generate failed: ${error}`,
                  model: request.model,
                  cause: error,
                }),
            ),
          )

          return result.text
        }),
      } satisfies ProviderService
    }),
  )

  // ── Debug / test provider statics ──
  //
  // Inlined from the former `debug/provider.ts` to avoid a circular
  // import (debug/provider → Provider class → debug/provider).

  /** Scripted multi-turn provider. Each `stream()` call consumes the next step. */
  static Sequence = _createSequenceProvider

  /** Debug provider — canned text responses, optional delays/retries. */
  static Debug = _DebugProvider

  /** Signal-controlled provider for lifecycle assertions. */
  static Signal = _createSignalProvider

  /** Always-failing provider for error path tests. */
  static get Failing() {
    return _DebugFailingProvider()
  }
}
