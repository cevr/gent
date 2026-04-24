import { Context, Duration, Effect, Layer, Schema, Stream } from "effect"
import type { AnyCapabilityContribution } from "../domain/capability.js"
import type { Message } from "../domain/message.js"
import { AuthOauth, AuthStore, type AuthStoreService } from "../domain/auth-store.js"
import { ProviderAuthError, type ProviderAuthInfo, type ProviderHints } from "../domain/driver.js"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../runtime/extensions/driver-registry.js"
import { LanguageModel } from "effect/unstable/ai"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as AiTool from "effect/unstable/ai/Tool"
import * as AiError from "effect/unstable/ai/AiError"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import { toPrompt } from "./ai-transcript.js"

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

    const authInfo = yield* authStore.get(providerName).pipe(
      Effect.mapError(
        (e) =>
          new ProviderError({
            message: `Failed to read auth for provider "${providerName}"`,
            model: modelId,
            cause: e,
          }),
      ),
    )
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
            .pipe(
              Effect.mapError(
                (e) =>
                  new ProviderAuthError({
                    message: `Failed to persist refreshed auth for provider "${providerName}"`,
                    cause: e,
                  }),
              ),
            ),
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

export type ProviderToolMap = Record<string, AiTool.Any>
export type ProviderStreamPart<Tools extends ProviderToolMap = ProviderToolMap> =
  Response.StreamPart<Tools>
type ProviderStream<Tools extends ProviderToolMap = ProviderToolMap> = Stream.Stream<
  ProviderStreamPart<Tools>,
  ProviderError
>

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

const textDeltaPart = (text: string, id = makeStreamPartId("text")): ProviderStreamPart =>
  Response.makePart("text-delta", { id, delta: text })

const finishPart = (params: {
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

// ── Provider Request ──

interface ProviderRequestBase {
  readonly model: string
  readonly prompt: Prompt.RawInput
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

export interface ProviderRequest<
  Tools extends ProviderToolMap = ProviderToolMap,
> extends ProviderRequestBase {
  readonly tools?: ReadonlyArray<AnyCapabilityContribution>
  readonly toolkit?: AiToolkit.WithHandler<Tools>
}

export interface ProviderMessageRequest<
  Tools extends ProviderToolMap = ProviderToolMap,
> extends Omit<ProviderRequest<Tools>, "prompt"> {
  readonly messages: ReadonlyArray<Message>
  readonly systemPrompt?: string
}

export const providerRequestFromMessages = <Tools extends ProviderToolMap = ProviderToolMap>({
  messages,
  systemPrompt,
  ...request
}: ProviderMessageRequest<Tools>): ProviderRequest<Tools> => ({
  ...request,
  prompt: toPrompt(messages, { systemPrompt }),
})

// Simple generate request (no tools, no streaming)

export interface GenerateRequest {
  readonly model: string
  readonly prompt: Prompt.RawInput
  readonly maxTokens?: number
  /** Per-turn driver registry override (per-cwd profile). */
  readonly driverRegistry?: DriverRegistryService
  /** Per-agent driver id override (from `ModelDriverRef.id`). */
  readonly driverId?: string
}

// ── Provider Service ──

export interface ProviderService {
  readonly stream: {
    <Tools extends ProviderToolMap>(
      request: ProviderRequest<Tools> & { readonly toolkit: AiToolkit.WithHandler<Tools> },
    ): Effect.Effect<ProviderStream<Tools>, ProviderError>
    (
      request: ProviderRequest & { readonly tools: ReadonlyArray<AnyCapabilityContribution> },
    ): Effect.Effect<ProviderStream, ProviderError>
    (request: ProviderRequest): Effect.Effect<ProviderStream, ProviderError>
  }

  readonly generate: (request: GenerateRequest) => Effect.Effect<string, ProviderError>
}

// ── Tool Conversion (Capability → canonical Tool / advertise-only Toolkit) ──

// Tool JSON schema conversion — canonical implementation in domain/tool-schema.ts
import { buildToolJsonSchema } from "../domain/tool-schema.js"

const toCapabilityTool = (capability: AnyCapabilityContribution): AiTool.Any =>
  AiTool.dynamic(capability.id, {
    description: capability.description ?? "",
    parameters: buildToolJsonSchema(capability),
  })

const makeAdvertiseOnlyToolkit = <Tools extends Record<string, AiTool.Any>>(
  tools: Tools,
): AiToolkit.WithHandler<Tools> => ({
  tools,
  handle: (name) =>
    Effect.fail(
      AiError.make({
        module: "Provider",
        method: "makeAdvertiseOnlyToolkit.handle",
        reason: new AiError.ToolConfigurationError({
          toolName: String(name),
          description:
            "gent advertises capabilities to the model with disableToolCallResolution enabled; tool execution stays in SessionRuntime",
        }),
      }),
    ),
})

function convertTools(
  tools: ReadonlyArray<AnyCapabilityContribution>,
): AiToolkit.WithHandler<ProviderToolMap> {
  const toolsRecord: ProviderToolMap = {}

  for (const capability of tools) {
    toolsRecord[capability.id] = toCapabilityTool(capability)
  }

  return makeAdvertiseOnlyToolkit(toolsRecord)
}

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
          const latestUserText = _extractLatestUserText(request.prompt)
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
let _debugFailingProviderCache: Layer.Layer<Provider> | undefined
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
  return _debugFailingProviderCache
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

      function stream<Tools extends ProviderToolMap>(
        request: ProviderRequest<Tools> & { readonly toolkit: AiToolkit.WithHandler<Tools> },
      ): Effect.Effect<ProviderStream<Tools>, ProviderError>
      function stream(
        request: ProviderRequest & { readonly tools: ReadonlyArray<AnyCapabilityContribution> },
      ): Effect.Effect<ProviderStream, ProviderError>
      function stream(request: ProviderRequest): Effect.Effect<ProviderStream, ProviderError>
      function stream(request: ProviderRequest): Effect.Effect<ProviderStream, ProviderError> {
        return Effect.gen(function* () {
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

          const withHandler =
            request.toolkit ??
            (request.tools !== undefined ? convertTools(request.tools) : undefined)

          const rawStream =
            withHandler !== undefined
              ? LanguageModel.streamText({
                  prompt: request.prompt,
                  toolkit: withHandler,
                  disableToolCallResolution: true as const,
                })
              : LanguageModel.streamText({
                  prompt: request.prompt,
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
        })
      }
      return {
        stream,
        generate: Effect.fn("Provider.generate")(function* (request: GenerateRequest) {
          const resolution = yield* getModel(
            request.model,
            { maxTokens: request.maxTokens },
            request.driverRegistry,
            request.driverId,
          )
          const modelLayer = resolution.layer
          const result = yield* LanguageModel.generateText({ prompt: request.prompt }).pipe(
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

  // ── Debug provider statics ──

  /** Debug provider — canned text responses, optional delays/retries. */
  static Debug = _DebugProvider

  /** Always-failing provider for error path tests. */
  static get Failing() {
    return _DebugFailingProvider()
  }
}
