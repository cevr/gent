import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import { tool, type ToolCapability } from "@gent/core/extensions/api"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution, ProviderResolution } from "@gent/core/domain/driver"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import {
  DriverRegistry,
  type DriverRegistryService,
} from "../../src/runtime/extensions/driver-registry"
import { Auth, AuthError, type AuthInfo, type AuthService } from "@gent/core/domain/auth"
import { finishPart, LanguageModelLayers, toolCallPart } from "@gent/core/test-utils/language-model"
import type { ProviderError } from "@gent/core/domain/provider-error"
import { ModelResolver } from "@gent/core/providers/model-resolver"
import { convertTools } from "../../src/runtime/agent/tool-runner"
import { ProviderAuthError } from "@gent/core/domain/driver"
import { toPrompt } from "@gent/core/providers/ai-transcript"
import { dateFromMillis, Message } from "@gent/core/domain/message"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { toCodecAnthropic } from "effect/unstable/ai/AnthropicStructuredOutput"
import * as AiError from "effect/unstable/ai/AiError"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import type { ToolkitInput } from "effect/unstable/ai/LanguageModel"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { failingLanguageModel, makeLanguageModel } from "../helpers/failing-language-model"
const missingAuthInfo: AuthInfo | undefined = undefined
const testAuthStorage: AuthService = {
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
}
/** Create a fake upstream model with a stub LanguageModel layer */
const fakeResolution = (): ProviderResolution =>
  AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel))
const modelFromService = (provider: string, service: LanguageModel.Service): ProviderResolution =>
  AiModel.make(provider, "model", Layer.succeed(LanguageModel.LanguageModel, service))
const assertProviderResolutionRejectsBareLayer = () => {
  const bareLayer = Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel)
  // @ts-expect-error ProviderResolution must come from Effect AI Model.make metadata.
  const resolution: ProviderResolution = bareLayer
  return resolution
}
// If ProviderResolution ever stops requiring Model.make metadata, this
// assignment compiles and @ts-expect-error flips the guard red.
void assertProviderResolutionRejectsBareLayer
const makeProvider = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => fakeResolution(),
})
const EchoParams = Schema.Struct({ text: Schema.String })
const echoCapability: ToolCapability = tool({
  id: "echo",
  description: "Echo input",
  params: EchoParams,
  execute: () => Effect.succeed("echoed"),
})
const makeExt = (extId: string, modelDrivers: ModelDriverContribution[]): LoadedExtension => ({
  manifest: { id: ExtensionId.make(extId) },
  scope: "builtin",
  sourcePath: "test",
  contributions: { modelDrivers },
})
interface ModelRequest {
  readonly model: string
  readonly reasoning?: string
  readonly maxTokens?: number
  readonly temperature?: number
  readonly driverRegistry?: DriverRegistryService
  readonly driverId?: string
}

const buildProviderLayer = (
  extensions: LoadedExtension[],
  authStore: AuthService = testAuthStorage,
) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const driverRegistryLayer = DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
  const authLayer = Layer.succeed(Auth, authStore)
  return Layer.provide(
    ModelResolver.Live,
    Layer.mergeAll(authLayer, registryLayer, driverRegistryLayer),
  )
}
const resolveModel = (request: ModelRequest) =>
  Effect.gen(function* () {
    const resolver = yield* ModelResolver
    return yield* resolver.resolve({
      modelId: request.model,
      hints: {
        reasoning: request.reasoning,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      },
      driverRegistry: request.driverRegistry,
      driverId: request.driverId,
    })
  })
const streamResolvedModel = <Tools extends Record<string, AiTool.Any> = Record<string, AiTool.Any>>(
  request: ModelRequest & {
    readonly prompt: Prompt.RawInput
    readonly tools?: ReadonlyArray<ToolCapability>
    readonly toolkit?: ToolkitInput<Tools>
  },
) =>
  Effect.gen(function* () {
    const model = yield* resolveModel(request)
    if (request.toolkit !== undefined) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: request.toolkit,
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    if (request.tools !== undefined) {
      return yield* model
        .streamText({
          prompt: request.prompt,
          toolkit: convertTools(request.tools),
          disableToolCallResolution: true,
        })
        .pipe(Stream.runCollect)
    }
    return yield* model.streamText({ prompt: request.prompt }).pipe(Stream.runCollect)
  })
describe("Provider model resolution", () => {
  it.live("resolves model through extension-registered provider", () =>
    Effect.gen(function* () {
      const layer = buildProviderLayer([makeExt("test-ext", [makeProvider("custom")])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "custom/gpt-5",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Success")
    }),
  )
  it.live("ModelResolver resolves the LanguageModel service directly", () =>
    Effect.gen(function* () {
      const languageModel = makeLanguageModel({
        streamText: () => Stream.fromIterable([finishPart({ finishReason: "stop" })]),
      })
      const layer = buildProviderLayer([
        makeExt("direct-ext", [
          {
            id: "direct",
            name: "Direct",
            resolveModel: () => modelFromService("direct", languageModel),
          },
        ]),
      ])
      const model = yield* resolveModel({ model: "direct/gpt-5" }).pipe(Effect.provide(layer))
      const result = yield* model.streamText({ prompt: [] }).pipe(Stream.runCollect)
      expect(Array.from(result)).toEqual([expect.objectContaining({ type: "finish" })])
    }),
  )
  it.live("errors for unregistered provider", () =>
    Effect.gen(function* () {
      const layer = buildProviderLayer([])
      const result = yield* Effect.exit(
        resolveModel({
          model: "unknown-provider/some-model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
    }),
  )
  it.live("failing test provider resolves before failing at stream boundary", () =>
    Effect.gen(function* () {
      const resolver = yield* ModelResolver
      const model = yield* resolver.resolve({ modelId: "test/failing" })
      const result = yield* Effect.exit(model.streamText({ prompt: [] }).pipe(Stream.runCollect))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(Cause.pretty(result.cause)).toContain("provider exploded")
      }
    }).pipe(Effect.provide(ModelResolver.fromLanguageModel(LanguageModelLayers.failing))),
  )
  it.live("wraps extension resolveModel errors as ProviderError preserving cause", () =>
    Effect.gen(function* () {
      const original = new Error("kaboom")
      const throwingProvider: ModelDriverContribution = {
        id: "broken",
        name: "Broken",
        resolveModel: () => {
          throw original
        },
      }
      const layer = buildProviderLayer([makeExt("broken-ext", [throwingProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "broken/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value as ProviderError
          // The original `Error` thrown from the driver must be
          // preserved as `cause` so the upstream chain is debuggable.
          expect(err._tag).toBe("ProviderError")
          expect(err.cause).toBe(original)
        }
      }
    }),
  )
  it.live("driver ProviderAuthError surfaces typed at the provider boundary", () =>
    Effect.gen(function* () {
      // Drivers that fail closed at credential resolution throw
      // ProviderAuthError synchronously from `resolveModel`. The boundary
      // must re-raise it as-is so `GentRpcError` (which has
      // `ProviderAuthError` as a first-class union arm) receives the typed
      // tag — not a generic `ProviderError` with the auth error demoted to
      // a defect-encoded cause.
      const failingAuthProvider: ModelDriverContribution = {
        id: "auth-missing",
        name: "AuthMissing",
        resolveModel: () => {
          throw new ProviderAuthError({
            message: "credentials unavailable: no OAuth, API key, or env var",
          })
        },
      }
      const layer = buildProviderLayer([makeExt("auth-missing-ext", [failingAuthProvider])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-missing/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          const err = errOpt.value
          expect(Schema.is(ProviderAuthError)(err)).toBe(true)
          if (Schema.is(ProviderAuthError)(err)) {
            expect(err.message).toContain("credentials unavailable")
          }
        }
      }
    }),
  )
  it.live("BedrockExtension resolveModel fails closed as ProviderAuthError", () =>
    Effect.gen(function* () {
      // Bedrock has no @effect/ai provider at beta.47. The contribution
      // throws on resolveModel — that throw must surface as ProviderAuthError
      // (fail-closed) rather than being wrapped as transient ProviderError and
      // retried. Use a test contribution that mirrors the BedrockExtension
      // shape so this test is provider-boundary-only and stays in core.
      const bedrockShaped: ModelDriverContribution = {
        id: "bedrock",
        name: "AWS Bedrock",
        resolveModel: () => {
          throw new ProviderAuthError({
            message: "AWS Bedrock is temporarily unsupported.",
          })
        },
      }
      const layer = buildProviderLayer([makeExt("bedrock-shaped-ext", [bedrockShaped])])
      const result = yield* Effect.exit(
        resolveModel({
          model: "bedrock/some-model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(errOpt._tag).toBe("Some")
        if (errOpt._tag === "Some") {
          expect(Schema.is(ProviderAuthError)(errOpt.value)).toBe(true)
        }
      }
    }),
  )
  it.live("auth store read failures fail closed before resolving the model", () =>
    Effect.gen(function* () {
      let resolved = false
      const provider: ModelDriverContribution = {
        id: "auth-fails",
        name: "AuthFails",
        resolveModel: () => {
          resolved = true
          return fakeResolution()
        },
      }
      const authStore: AuthService = {
        ...testAuthStorage,
        get: () => Effect.fail(new AuthError({ message: "read failed" })),
      }
      const layer = buildProviderLayer([makeExt("auth-fails-ext", [provider])], authStore)
      const result = yield* Effect.exit(
        resolveModel({
          model: "auth-fails/model",
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      expect(resolved).toBe(false)
      expect(result.toString()).toContain('Failed to read auth for provider "auth-fails"')
    }),
  )
  // ── Per-turn driver registry override (per-cwd profile shadowing) ──
  it.live("per-request driverRegistry overrides the captured one for model resolution", () =>
    Effect.gen(function* () {
      // Captured registry has only "captured-only" — would fail to find "shadowed"
      const capturedLayer = buildProviderLayer([
        makeExt("captured", [makeProvider("captured-only", "Captured")]),
      ])
      // Per-turn registry has "shadowed" — should win
      const shadowedResolved = resolveExtensions([
        makeExt("shadowed", [makeProvider("shadowed", "Shadowed")]),
      ])
      const overrideRegistry = yield* Effect.service(DriverRegistry).pipe(
        Effect.provide(
          DriverRegistry.fromResolved({
            modelDrivers: shadowedResolved.modelDrivers,
            externalDrivers: shadowedResolved.externalDrivers,
          }),
        ),
      )
      const result = yield* Effect.exit(
        resolveModel({
          model: "shadowed/some-model",
          driverRegistry: overrideRegistry,
        }).pipe(Effect.provide(capturedLayer)),
      )
      // Resolution should NOT fail with "Unknown provider" — overrideRegistry has "shadowed".
      if (result._tag === "Failure") {
        const pretty = result.cause.toString()
        expect(pretty).not.toContain("Unknown provider")
      }
    }),
  )
  // ── ModelDriverRef.id override ──
  it.live("driverId override picks a driver other than the one parsed from modelId", () =>
    Effect.gen(function* () {
      // Both drivers registered. Default parse from "primary/foo" → "primary".
      // We force "alt" via driverId override and check `alt` was chosen by giving it
      // a recognizable resolveModel side effect.
      let chosenDriver: string | undefined
      const layer = buildProviderLayer([
        makeExt("primary-ext", [
          {
            id: "primary",
            name: "Primary",
            resolveModel: () => {
              chosenDriver = "primary"
              return fakeResolution()
            },
          },
        ]),
        makeExt("alt-ext", [
          {
            id: "alt",
            name: "Alt",
            resolveModel: () => {
              chosenDriver = "alt"
              return fakeResolution()
            },
          },
        ]),
      ])
      yield* Effect.exit(
        resolveModel({
          model: "primary/foo",
          driverId: "alt",
        }).pipe(Effect.provide(layer)),
      )
      expect(chosenDriver).toBe("alt")
    }),
  )
  it.live("runtime tools advertise capabilities through the live stream path", () =>
    Effect.gen(function* () {
      let captured:
        | {
            disableToolCallResolution: boolean | undefined
            toolkit:
              | AiToolkit.Toolkit<Record<string, AiTool.Any>>
              | AiToolkit.WithHandler<Record<string, AiTool.Any>>
              | undefined
          }
        | undefined
      const streamingProvider: ModelDriverContribution = {
        id: "tools-live",
        name: "ToolsLive",
        resolveModel: () =>
          modelFromService(
            "tools-live",
            makeLanguageModel<{
              readonly disableToolCallResolution?: boolean
              readonly toolkit?:
                | AiToolkit.Toolkit<Record<string, AiTool.Any>>
                | AiToolkit.WithHandler<Record<string, AiTool.Any>>
            }>({
              streamText: (options) => {
                captured = {
                  disableToolCallResolution: options.disableToolCallResolution,
                  toolkit: options.toolkit,
                }
                return Stream.fromIterable([
                  toolCallPart("echo", { text: "hi" }, { toolCallId: ToolCallId.make("tc-1") }),
                  finishPart({
                    finishReason: "tool-calls",
                    usage: { inputTokens: 10, outputTokens: 20 },
                  }),
                ])
              },
            }),
          ),
      }
      const layer = buildProviderLayer([makeExt("tools-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel({
        model: "tools-live/gpt-5",
        prompt: [],
        tools: [echoCapability],
      }).pipe(Effect.provide(layer))
      expect(captured?.disableToolCallResolution).toBe(true)
      const toolkit = captured?.toolkit
      expect(toolkit).toBeDefined()
      expect(Object.keys(toolkit?.tools ?? {})).toEqual(["echo"])
      expect(toolkit?.tools["echo"]?.name).toBe("echo")
      const advertisedTool = toolkit?.tools["echo"]
      expect(advertisedTool).toBeDefined()
      if (advertisedTool !== undefined) {
        expect(() => toCodecAnthropic(advertisedTool.parametersSchema)).not.toThrow()
      }
      const collected = Array.from(parts)
      expect(collected).toHaveLength(2)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "echo",
          params: { text: "hi" },
        }),
      )
      expect(collected[1]).toEqual(
        expect.objectContaining({
          type: "finish",
          reason: "tool-calls",
        }),
      )
    }),
  )
  it.live("runtime toolkit preserves typed Effect tool maps through the live stream path", () =>
    Effect.gen(function* () {
      const typedEchoTool = AiTool.dynamic("typedEcho", {
        description: "Typed echo input",
        parameters: Schema.Struct({ text: Schema.String }),
      })
      type TypedTools = {
        readonly typedEcho: typeof typedEchoTool
      }
      const typedToolkit = {
        tools: { typedEcho: typedEchoTool },
        handle: (name) =>
          Effect.fail(
            AiError.make({
              module: "Test",
              method: "typedToolkit.handle",
              reason: new AiError.ToolConfigurationError({
                toolName: String(name),
                description: "unused in provider advertising test",
              }),
            }),
          ),
      } satisfies AiToolkit.WithHandler<TypedTools>
      let capturedToolkit: AiToolkit.WithHandler<TypedTools> | undefined
      const streamingProvider: ModelDriverContribution = {
        id: "typed-toolkit-live",
        name: "TypedToolkitLive",
        resolveModel: () =>
          modelFromService(
            "typed-toolkit-live",
            makeLanguageModel<{
              readonly toolkit?: AiToolkit.WithHandler<TypedTools>
            }>({
              streamText: (options) => {
                capturedToolkit = options.toolkit
                return Stream.fromIterable([
                  toolCallPart(
                    "typedEcho",
                    { text: "hi" },
                    { toolCallId: ToolCallId.make("typed-tc-1") },
                  ),
                  finishPart({
                    finishReason: "tool-calls",
                    usage: { inputTokens: 1, outputTokens: 1 },
                  }),
                ])
              },
            }),
          ),
      }
      const layer = buildProviderLayer([makeExt("typed-toolkit-live-ext", [streamingProvider])])
      const parts = yield* streamResolvedModel<TypedTools>({
        model: "typed-toolkit-live/gpt-5",
        prompt: [],
        toolkit: typedToolkit,
      }).pipe(Effect.provide(layer))
      expect(capturedToolkit).toBe(typedToolkit)
      const collected = Array.from(parts)
      expect(collected[0]).toEqual(
        expect.objectContaining({
          type: "tool-call",
          name: "typedEcho",
          params: { text: "hi" },
        }),
      )
    }),
  )
  it.live("live stream path builds Effect Prompt with multimodal and reasoning parts", () =>
    Effect.gen(function* () {
      let capturedPrompt: Prompt.Prompt | undefined
      const streamingProvider: ModelDriverContribution = {
        id: "prompt-live",
        name: "PromptLive",
        resolveModel: () =>
          modelFromService(
            "prompt-live",
            makeLanguageModel<{
              readonly prompt?: Prompt.RawInput
            }>({
              streamText: (options) => {
                capturedPrompt = Prompt.make(options.prompt ?? [])
                return Stream.fromIterable([
                  finishPart({
                    finishReason: "stop",
                    usage: { inputTokens: 3, outputTokens: 1 },
                  }),
                ])
              },
            }),
          ),
      }
      const layer = buildProviderLayer([makeExt("prompt-live-ext", [streamingProvider])])
      yield* Effect.gen(function* () {
        const parts = yield* streamResolvedModel({
          model: "prompt-live/gpt-5",
          prompt: toPrompt(
            [
              Message.Regular.make({
                id: "user-image",
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [
                  Prompt.textPart({ text: "inspect" }),
                  Prompt.filePart({
                    data: "data:image/jpeg;base64,abc",
                    mediaType: "image/jpeg",
                  }),
                ],
                createdAt: dateFromMillis(0),
              }),
              Message.Regular.make({
                id: "assistant-reasoning",
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "assistant",
                parts: [Prompt.reasoningPart({ text: "look at image metadata" })],
                createdAt: dateFromMillis(0),
              }),
              Message.Regular.make({
                id: "hidden",
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "user",
                parts: [Prompt.textPart({ text: "should not reach model" })],
                createdAt: dateFromMillis(0),
                metadata: { hidden: true },
              }),
            ],
            { systemPrompt: "System policy." },
          ),
        })
        expect(parts.length).toBe(1)
      }).pipe(Effect.provide(layer))
      expect(capturedPrompt?.content.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ])
      const userMessage = capturedPrompt?.content[1]
      expect(userMessage?.role).toBe("user")
      if (userMessage?.role === "user") {
        expect(userMessage.content[1]).toEqual(
          expect.objectContaining({
            type: "file",
            mediaType: "image/jpeg",
            data: "data:image/jpeg;base64,abc",
          }),
        )
      }
      const assistantMessage = capturedPrompt?.content[2]
      expect(assistantMessage?.role).toBe("assistant")
      if (assistantMessage?.role === "assistant") {
        expect(assistantMessage.content[0]).toEqual(
          expect.objectContaining({
            type: "reasoning",
            text: "look at image metadata",
          }),
        )
      }
      expect(
        capturedPrompt?.content.some((message) =>
          message.role === "user"
            ? message.content.some(
                (part) => part.type === "text" && part.text === "should not reach model",
              )
            : false,
        ),
      ).toBe(false)
    }),
  )
})
