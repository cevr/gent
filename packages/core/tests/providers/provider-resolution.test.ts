import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { AuthStore, type AuthInfo } from "@gent/core/domain/auth-store"
import {
  Provider,
  type ProviderError,
  providerRequestFromMessages,
  type ProviderResolution,
} from "@gent/core/providers/provider"
import { toPrompt } from "@gent/core/providers/ai-transcript"
import { finishPart, toolCallPart } from "@gent/core/debug/provider"
import { ImagePart, Message, ReasoningPart, TextPart } from "@gent/core/domain/message"
import { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"

const emptyAuthInfo: Record<string, AuthInfo> = {}
const missingAuthInfo: AuthInfo | undefined = undefined

const testAuthStorage = {
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([] as ReadonlyArray<string>),
  listInfo: () => Effect.succeed(emptyAuthInfo),
}

const failingLanguageModel: LanguageModel.Service = {
  generateText: () =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    ),
  generateObject: () =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateObject",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    ),
  streamText: () =>
    Stream.fail(
      AiError.make({
        module: "Test",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    ),
}

/** Create a fake ProviderResolution with a stub LanguageModel layer */
const fakeResolution = (): ProviderResolution => ({
  layer: Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
})

const makeProvider = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: () => fakeResolution(),
})

const EchoParams = Schema.Struct({ text: Schema.String })
const echoCapability: AnyCapabilityContribution = {
  id: "echo",
  description: "Echo input",
  audiences: ["model"],
  intent: "write",
  input: EchoParams,
  output: Schema.Unknown,
  effect: () => Effect.succeed("echoed"),
}

const makeExt = (extId: string, modelDrivers: ModelDriverContribution[]): LoadedExtension => ({
  manifest: { id: extId },
  scope: "builtin",
  sourcePath: "test",
  contributions: { modelDrivers },
})

const buildProviderLayer = (extensions: LoadedExtension[]) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const driverRegistryLayer = DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
  const authLayer = Layer.succeed(AuthStore, testAuthStorage)
  return Layer.provide(Provider.Live, Layer.mergeAll(authLayer, registryLayer, driverRegistryLayer))
}

describe("Provider model resolution", () => {
  test("resolves model through extension-registered provider", async () => {
    const layer = buildProviderLayer([makeExt("test-ext", [makeProvider("custom")])])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        // Should resolve successfully (the stream will fail with stub error, not resolution error)
        const stream = yield* provider.stream({
          model: "custom/gpt-5",
          prompt: [],
        })
        // Consume one chunk to trigger the stream — expect the stub error, not "Unknown provider"
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(layer)),
    )
    if (result._tag === "Failure") {
      const pretty = result.cause.toString()
      expect(pretty).not.toContain("Unknown provider")
      // Stub LanguageModel fails with AiError — wrapped as ProviderError
      expect(pretty).toContain("stub")
    }
  })

  test("errors for unregistered provider", async () => {
    const layer = buildProviderLayer([])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "unknown-provider/some-model",
          prompt: [],
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })

  test("wraps extension resolveModel errors as ProviderError", async () => {
    const throwingProvider: ModelDriverContribution = {
      id: "broken",
      name: "Broken",
      resolveModel: () => {
        throw new Error("kaboom")
      },
    }
    const layer = buildProviderLayer([makeExt("broken-ext", [throwingProvider])])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "broken/model",
          prompt: [],
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })

  // ── Per-turn driver registry override (per-cwd profile shadowing) ──

  test("per-request driverRegistry overrides the captured one for model resolution", async () => {
    // Captured registry has only "captured-only" — would fail to find "shadowed"
    const capturedLayer = buildProviderLayer([
      makeExt("captured", [makeProvider("captured-only", "Captured")]),
    ])
    // Per-turn registry has "shadowed" — should win
    const shadowedResolved = resolveExtensions([
      makeExt("shadowed", [makeProvider("shadowed", "Shadowed")]),
    ])
    const overrideRegistry = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* DriverRegistry
      }).pipe(
        Effect.provide(
          DriverRegistry.fromResolved({
            modelDrivers: shadowedResolved.modelDrivers,
            externalDrivers: shadowedResolved.externalDrivers,
          }),
        ),
      ),
    )

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "shadowed/some-model",
          prompt: [],
          driverRegistry: overrideRegistry,
        })
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(capturedLayer)),
    )

    // Resolution should NOT fail with "Unknown provider" — overrideRegistry has "shadowed".
    if (result._tag === "Failure") {
      const pretty = result.cause.toString()
      expect(pretty).not.toContain("Unknown provider")
    }
  })

  // ── ModelDriverRef.id override ──

  test("driverId override picks a driver other than the one parsed from modelId", async () => {
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

    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "primary/foo",
          prompt: [],
          driverId: "alt",
        })
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(layer)),
    )

    expect(chosenDriver).toBe("alt")
  })

  test("request.tools advertises capabilities through the live stream path", async () => {
    let captured:
      | {
          disableToolCallResolution: boolean | undefined
          toolkit: AiToolkit.WithHandler<Record<string, AiTool.Any>> | undefined
        }
      | undefined

    const streamingProvider: ModelDriverContribution = {
      id: "tools-live",
      name: "ToolsLive",
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, {
          generateText: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateText",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          generateObject: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateObject",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          streamText: (options) => {
            captured = {
              disableToolCallResolution: options.disableToolCallResolution,
              toolkit: options.toolkit,
            }
            return Stream.fromIterable([
              toolCallPart("echo", { text: "hi" }, { toolCallId: "tc-1" }),
              finishPart({
                finishReason: "tool-calls",
                usage: { inputTokens: 10, outputTokens: 20 },
              }),
            ])
          },
        } satisfies LanguageModel.Service),
      }),
    }

    const layer = buildProviderLayer([makeExt("tools-live-ext", [streamingProvider])])

    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "tools-live/gpt-5",
          prompt: [],
          tools: [echoCapability],
        })
        return yield* Stream.runCollect(stream)
      }).pipe(Effect.provide(layer)),
    )

    expect(captured?.disableToolCallResolution).toBe(true)
    const toolkit = captured?.toolkit
    expect(toolkit).toBeDefined()
    expect(Object.keys(toolkit?.tools ?? {})).toEqual(["echo"])
    expect(toolkit?.tools["echo"]?.name).toBe("echo")

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
  })

  test("request.toolkit preserves typed Effect tool maps through the live stream path", async () => {
    const typedEchoTool = AiTool.dynamic("typedEcho", {
      description: "Typed echo input",
      parameters: Schema.Struct({ text: Schema.String }),
    })
    type TypedTools = { readonly typedEcho: typeof typedEchoTool }
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
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, {
          generateText: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateText",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          generateObject: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateObject",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          streamText: (options) => {
            capturedToolkit = options.toolkit
            return Stream.fromIterable([
              toolCallPart("typedEcho", { text: "hi" }, { toolCallId: "typed-tc-1" }),
              finishPart({
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            ])
          },
        } satisfies LanguageModel.Service),
      }),
    }

    const layer = buildProviderLayer([makeExt("typed-toolkit-live-ext", [streamingProvider])])

    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "typed-toolkit-live/gpt-5",
          prompt: [],
          toolkit: typedToolkit,
        })
        const typedStream: Stream.Stream<Response.StreamPart<TypedTools>, ProviderError> = stream
        return yield* Stream.runCollect(typedStream)
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedToolkit).toBe(typedToolkit)
    const collected = Array.from(parts)
    expect(collected[0]).toEqual(
      expect.objectContaining({
        type: "tool-call",
        name: "typedEcho",
        params: { text: "hi" },
      }),
    )
  })

  test("providerRequestFromMessages preserves typed Effect tool maps", async () => {
    const typedEchoTool = AiTool.dynamic("typedEcho", {
      description: "Typed echo input",
      parameters: Schema.Struct({ text: Schema.String }),
    })
    type TypedTools = { readonly typedEcho: typeof typedEchoTool }
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
      id: "typed-message-toolkit-live",
      name: "TypedMessageToolkitLive",
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, {
          generateText: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateText",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          generateObject: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateObject",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          streamText: (options) => {
            capturedToolkit = options.toolkit
            return Stream.fromIterable([
              toolCallPart("typedEcho", { text: "from-message" }, { toolCallId: "typed-tc-2" }),
              finishPart({
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            ])
          },
        } satisfies LanguageModel.Service),
      }),
    }

    const layer = buildProviderLayer([
      makeExt("typed-message-toolkit-live-ext", [streamingProvider]),
    ])

    const parts = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider
        const request = providerRequestFromMessages({
          model: "typed-message-toolkit-live/gpt-5",
          messages: [],
          toolkit: typedToolkit,
        })
        const stream = yield* provider.stream(request)
        const typedStream: Stream.Stream<Response.StreamPart<TypedTools>, ProviderError> = stream
        return yield* Stream.runCollect(typedStream)
      }).pipe(Effect.provide(layer)),
    )

    expect(capturedToolkit).toBe(typedToolkit)
    expect(Array.from(parts)[0]).toEqual(
      expect.objectContaining({
        type: "tool-call",
        name: "typedEcho",
        params: { text: "from-message" },
      }),
    )
  })

  test("live stream path builds Effect Prompt with multimodal and reasoning parts", async () => {
    let capturedPrompt: Prompt.Prompt | undefined

    const streamingProvider: ModelDriverContribution = {
      id: "prompt-live",
      name: "PromptLive",
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, {
          generateText: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateText",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          generateObject: () =>
            Effect.fail(
              AiError.make({
                module: "Test",
                method: "generateObject",
                reason: new AiError.UnknownError({ description: "unused" }),
              }),
            ),
          streamText: (options) => {
            capturedPrompt = options.prompt
            return Stream.fromIterable([
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 1 },
              }),
            ])
          },
        } satisfies LanguageModel.Service),
      }),
    }

    const layer = buildProviderLayer([makeExt("prompt-live-ext", [streamingProvider])])

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "prompt-live/gpt-5",
          prompt: toPrompt(
            [
              Message.Regular.make({
                id: "user-image",
                sessionId: "prompt-session",
                branchId: "prompt-branch",
                role: "user",
                parts: [
                  new TextPart({ type: "text", text: "inspect" }),
                  new ImagePart({
                    type: "image",
                    image: "data:image/jpeg;base64,abc",
                    mediaType: "image/jpeg",
                  }),
                ],
                createdAt: new Date(0),
              }),
              Message.Regular.make({
                id: "assistant-reasoning",
                sessionId: "prompt-session",
                branchId: "prompt-branch",
                role: "assistant",
                parts: [new ReasoningPart({ type: "reasoning", text: "look at image metadata" })],
                createdAt: new Date(0),
              }),
              Message.Regular.make({
                id: "hidden",
                sessionId: "prompt-session",
                branchId: "prompt-branch",
                role: "user",
                parts: [new TextPart({ type: "text", text: "should not reach model" })],
                createdAt: new Date(0),
                metadata: { hidden: true },
              }),
            ],
            { systemPrompt: "System policy." },
          ),
        })
        yield* Stream.runCollect(stream)
      }).pipe(Effect.provide(layer)),
    )

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
  })
})
