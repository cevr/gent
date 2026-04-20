import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Message, TextPart, ToolResultPart } from "../domain/message.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { ToolCallId } from "../domain/ids.js"
import { TaggedEnumClass } from "../domain/schema-tagged-enum-class.js"
import { AuthOauth, AuthStore, type AuthInfo, type AuthStoreService } from "../domain/auth-store.js"
import type { ProviderAuthInfo, ProviderHints } from "../domain/driver.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
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

// ── Stream Chunk Types ──

export const StreamChunk = TaggedEnumClass("StreamChunk", {
  TextChunk: {
    text: Schema.String,
  },
  ToolCallChunk: {
    toolCallId: ToolCallId,
    toolName: Schema.String,
    input: Schema.Unknown,
  },
  ReasoningChunk: {
    text: Schema.String,
  },
  FinishChunk: {
    finishReason: Schema.String,
    usage: Schema.optional(
      Schema.Struct({
        inputTokens: Schema.Number,
        outputTokens: Schema.Number,
      }),
    ),
  },
})
export type StreamChunk = Schema.Schema.Type<typeof StreamChunk>

export const TextChunk = StreamChunk.TextChunk
export type TextChunk = (typeof StreamChunk)["TextChunk"]["Type"]
export const ToolCallChunk = StreamChunk.ToolCallChunk
export type ToolCallChunk = (typeof StreamChunk)["ToolCallChunk"]["Type"]
export const ReasoningChunk = StreamChunk.ReasoningChunk
export type ReasoningChunk = (typeof StreamChunk)["ReasoningChunk"]["Type"]
export const FinishChunk = StreamChunk.FinishChunk
export type FinishChunk = (typeof StreamChunk)["FinishChunk"]["Type"]

// ── Provider Request ──

export interface ProviderRequest {
  readonly model: string
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<AnyToolDefinition>
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
  readonly stream: (
    request: ProviderRequest,
  ) => Effect.Effect<Stream.Stream<StreamChunk, ProviderError>, ProviderError>

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

// ── Tool Conversion (AnyToolDefinition → Toolkit.WithHandler) ──

// Tool JSON schema conversion — canonical implementation in domain/tool-schema.ts
import { buildToolJsonSchema } from "../domain/tool-schema.js"

/** @internal — exported for testing */
export function convertTools(
  tools: ReadonlyArray<AnyToolDefinition>,
): AiToolkit.WithHandler<Record<string, AiTool.Any>> {
  const toolsRecord: Record<string, AiTool.Any> = {}

  for (const t of tools) {
    const flat = buildToolJsonSchema(t)
    toolsRecord[t.name] = AiTool.dynamic(t.name, {
      description: t.description,
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

// ── StreamPart → StreamChunk mapping ──

/** @internal — exported for testing */
export type AnyStreamPart = Response.StreamPart<Record<string, AiTool.Any>>

/** @internal — exported for testing */
export const toStreamChunk =
  (model: string) =>
  (part: AnyStreamPart): Effect.Effect<StreamChunk | null, ProviderError> => {
    switch (part.type) {
      case "text-delta":
        return Effect.succeed<StreamChunk>(new TextChunk({ text: part.delta }))
      case "tool-call":
        return Effect.succeed<StreamChunk>(
          new ToolCallChunk({
            toolCallId: ToolCallId.of(part.id),
            toolName: part.name,
            input: part.params,
          }),
        )
      case "reasoning-delta":
        return Effect.succeed<StreamChunk>(new ReasoningChunk({ text: part.delta }))
      case "finish":
        return Effect.succeed<StreamChunk>(
          new FinishChunk({
            finishReason: part.reason,
            usage:
              part.usage !== undefined
                ? {
                    inputTokens: part.usage.inputTokens.total ?? 0,
                    outputTokens: part.usage.outputTokens.total ?? 0,
                  }
                : undefined,
          }),
        )
      case "error":
        return Effect.fail(
          new ProviderError({
            message: `API error: ${String(part)}`,
            model,
          }),
        )
      default:
        return Effect.succeed(null)
    }
  }

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
            Stream.mapEffect(toStreamChunk(request.model)),
            Stream.filter((chunk): chunk is StreamChunk => chunk !== null),
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
}
