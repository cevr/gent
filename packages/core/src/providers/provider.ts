import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Message, TextPart, ToolResultPart } from "../domain/message.js"
import type { AnyToolDefinition } from "../domain/tool.js"
import { ToolCallId, type ToolCallId as ToolCallIdType } from "../domain/ids.js"
import { AuthOauth, AuthStore, type AuthInfo, type AuthStoreService } from "../domain/auth-store.js"
import type { ProviderAuthInfo, ProviderHints } from "../domain/extension.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../runtime/extensions/registry"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as AiError from "effect/unstable/ai/AiError"

// ── Provider Resolution ──

/** What a migrated extension returns from resolveModel (typed as unknown at the boundary) */
export interface ProviderResolution {
  /** Layer<LanguageModel.LanguageModel, never, never> — fully provided including HttpClient */
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>
  /** Keychain/OAuth mode — triggers mcp_ tool prefix + system identity injection */
  readonly keychainMode?: boolean
}

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

const makeModelResolver = (
  authStore: AuthStoreService,
  extensionRegistry: ExtensionRegistryService,
) => {
  const resolveAuthFromStore = (providerName: string) =>
    authStore
      .get(providerName)
      .pipe(Effect.catchEager(() => Effect.sync(() => undefined as AuthInfo | undefined)))

  return Effect.fn("Provider.resolveModel")(function* (modelId: string, hints?: ProviderHints) {
    const parsed = parseModelId(modelId)
    if (parsed === undefined) {
      return yield* new ProviderError({
        message: "Invalid model id (expected provider/model)",
        model: modelId,
      })
    }
    const [providerName, modelName] = parsed
    const services = yield* Effect.context<never>()

    const extensionProvider = yield* extensionRegistry.getProvider(providerName)
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
          Effect.runPromiseWith(services)(
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
          ),
      }
    }

    const resolved = yield* Effect.try({
      try: () => extensionProvider.resolveModel(modelName, authParam, hints) as ProviderResolution,
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

export class TextChunk extends Schema.TaggedClass<TextChunk>()("TextChunk", {
  text: Schema.String,
}) {}

export class ToolCallChunk extends Schema.TaggedClass<ToolCallChunk>()("ToolCallChunk", {
  toolCallId: ToolCallId,
  toolName: Schema.String,
  input: Schema.Unknown,
}) {}

export class ReasoningChunk extends Schema.TaggedClass<ReasoningChunk>()("ReasoningChunk", {
  text: Schema.String,
}) {}

export class FinishChunk extends Schema.TaggedClass<FinishChunk>()("FinishChunk", {
  finishReason: Schema.String,
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
    }),
  ),
}) {}

export const StreamChunk = Schema.Union([TextChunk, ToolCallChunk, ReasoningChunk, FinishChunk])
export type StreamChunk = typeof StreamChunk.Type

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
}

// Simple generate request (no tools, no streaming)

export interface GenerateRequest {
  readonly model: string
  readonly prompt: string
  readonly systemPrompt?: string
  readonly maxTokens?: number
}

// ── Provider Service ──

export interface ProviderService {
  readonly stream: (
    request: ProviderRequest,
  ) => Effect.Effect<Stream.Stream<StreamChunk, ProviderError>, ProviderError>

  readonly generate: (request: GenerateRequest) => Effect.Effect<string, ProviderError>
}

// ── Message Conversion (our MessagePart → Prompt.Message) ──

interface ConvertOptions {
  readonly keychainMode: boolean
}

function convertMessages(messages: ReadonlyArray<Message>, opts: ConvertOptions): Prompt.Message[] {
  const result: Prompt.Message[] = []

  for (const msg of messages) {
    const parts = msg.parts

    if (msg.role === "system") {
      const textParts = parts.filter((p): p is TextPart => p.type === "text")
      if (textParts.length > 0) {
        const text = textParts.map((p) => p.text).join("\n")
        result.push(
          Prompt.systemMessage({
            content: text,
            ...(opts.keychainMode
              ? { options: { anthropic: { cacheControl: { type: "ephemeral" as const } } } }
              : {}),
          }),
        )
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

const MCP_PREFIX = "mcp_"

/**
 * Flatten allOf into parent object. Effect's `.check()` emits constraints
 * (minItems, maxItems, minLength, maxLength) as allOf entries, but some
 * providers reject allOf sub-schemas that lack required fields like `items`.
 * Merging them into the parent keeps the constraints while producing a flat,
 * provider-compatible schema.
 */
function flattenAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === "allOf" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null) {
          Object.assign(result, flattenAllOf(entry as Record<string, unknown>))
        }
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = flattenAllOf(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? flattenAllOf(item as Record<string, unknown>)
          : item,
      )
    } else {
      result[key] = value
    }
  }

  return result
}

function buildToolJsonSchema(t: AnyToolDefinition): Record<string, unknown> {
  const doc = Schema.toJsonSchemaDocument(t.params as Schema.Schema<unknown>)
  const merged =
    Object.keys(doc.definitions).length > 0 ? { ...doc.schema, $defs: doc.definitions } : doc.schema
  const flat = flattenAllOf(merged as Record<string, unknown>)
  // Ensure top-level type: "object" — Anthropic rejects schemas without it
  if (flat["type"] === undefined) {
    flat["type"] = "object"
    if (flat["properties"] === undefined) flat["properties"] = {}
    delete flat["anyOf"]
    delete flat["oneOf"]
  }
  return flat
}

/** @internal — exported for testing */
export function convertTools(
  tools: ReadonlyArray<AnyToolDefinition>,
  opts: ConvertOptions,
): AiToolkit.WithHandler<Record<string, AiTool.Any>> {
  const toolsRecord: Record<string, AiTool.Any> = {}

  for (const t of tools) {
    const name = opts.keychainMode ? `${MCP_PREFIX}${t.name}` : t.name
    const flat = buildToolJsonSchema(t)
    toolsRecord[name] = AiTool.dynamic(name, {
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

type AnyStreamPart = Response.StreamPart<Record<string, AiTool.Any>>

const toStreamChunk =
  (model: string, keychainMode: boolean) =>
  (part: AnyStreamPart): Effect.Effect<StreamChunk | null, ProviderError> => {
    switch (part.type) {
      case "text-delta":
        return Effect.succeed<StreamChunk>(new TextChunk({ text: part.delta }))
      case "tool-call": {
        const toolName =
          keychainMode && part.name.startsWith(MCP_PREFIX)
            ? part.name.slice(MCP_PREFIX.length)
            : part.name
        return Effect.succeed<StreamChunk>(
          new ToolCallChunk({
            toolCallId: part.id as ToolCallIdType,
            toolName,
            input: part.params,
          }),
        )
      }
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
  static Live: Layer.Layer<Provider, never, AuthStore | ExtensionRegistry> = Layer.effect(
    Provider,
    Effect.gen(function* () {
      const authStore = yield* AuthStore
      const registry = yield* ExtensionRegistry
      const getModel = makeModelResolver(authStore, registry)

      return {
        stream: Effect.fn("Provider.stream")(function* (request: ProviderRequest) {
          const hints: ProviderHints = {
            reasoning: request.reasoning,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
          }
          const resolution = yield* getModel(request.model, hints)
          const keychainMode = resolution.keychainMode === true
          const modelLayer = resolution.layer

          // Build prompt
          const msgs = convertMessages(request.messages, { keychainMode })
          const promptMessages: Prompt.Message[] =
            request.systemPrompt !== undefined && request.systemPrompt !== ""
              ? [Prompt.systemMessage({ content: request.systemPrompt }), ...msgs]
              : msgs

          // Build tools
          const withHandler =
            request.tools !== undefined ? convertTools(request.tools, { keychainMode }) : undefined

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
            Stream.mapEffect(toStreamChunk(request.model, keychainMode)),
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
          const resolution = yield* getModel(request.model, hints)
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

  static Test = (responses: ReadonlyArray<ReadonlyArray<StreamChunk>>): Layer.Layer<Provider> => {
    let index = 0
    return Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromIterable(responses[index++] ?? [new FinishChunk({ finishReason: "stop" })]),
        ),
      generate: () => Effect.succeed("test response"),
    })
  }
}
