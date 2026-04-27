import { describe, test, expect } from "bun:test"
import { Cause, Effect, Layer, Schema, Stream } from "effect"
import type { AnyCapabilityContribution } from "@gent/core/domain/capability"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import {
  AuthStore,
  AuthStoreError,
  type AuthInfo,
  type AuthStoreService,
} from "@gent/core/domain/auth-store"
import {
  Provider,
  type ProviderError,
  providerRequestFromMessages,
  type ProviderResolution,
  finishPart,
  toolCallPart,
} from "@gent/core/providers/provider"
import { ProviderAuthError } from "@gent/core/domain/driver"
import { toPrompt } from "@gent/core/providers/ai-transcript"
import { ImagePart, Message, ReasoningPart, TextPart } from "@gent/core/domain/message"
import { LanguageModel } from "effect/unstable/ai"
import * as AiError from "effect/unstable/ai/AiError"
import * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import type * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core/domain/ids"

const emptyAuthInfo: Record<string, AuthInfo> = {}
const missingAuthInfo: AuthInfo | undefined = undefined

const testAuthStorage = {
  get: () => Effect.succeed(missingAuthInfo),
  set: () => Effect.void,
  remove: () => Effect.void,
  list: () => Effect.succeed([] as ReadonlyArray<string>),
  listInfo: () => Effect.succeed(emptyAuthInfo),
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub against opaque LanguageModel.Service generic shape
const failingLanguageModel: LanguageModel.Service = {
  generateText: (() =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
  generateObject: (() =>
    Effect.fail(
      AiError.make({
        module: "Test",
        method: "generateObject",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
  streamText: (() =>
    Stream.fail(
      AiError.make({
        module: "Test",
        method: "streamText",
        reason: new AiError.UnknownError({ description: "stub" }),
      }),
    )) as never,
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
  manifest: { id: ExtensionId.make(extId) },
  scope: "builtin",
  sourcePath: "test",
  contributions: { modelDrivers },
})

const buildProviderLayer = (
  extensions: LoadedExtension[],
  authStore: AuthStoreService = testAuthStorage,
) => {
  const resolved = resolveExtensions(extensions)
  const registryLayer = ExtensionRegistry.fromResolved(resolved)
  const driverRegistryLayer = DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
  const authLayer = Layer.succeed(AuthStore, authStore)
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

  test("wraps extension resolveModel errors as ProviderError preserving cause", async () => {
    const original = new Error("kaboom")
    const throwingProvider: ModelDriverContribution = {
      id: "broken",
      name: "Broken",
      resolveModel: () => {
        throw original
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
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(errOpt._tag).toBe("Some")
      if (errOpt._tag === "Some") {
        const err = errOpt.value as ProviderError
        // W6-13: the original `Error` thrown from the driver must be
        // preserved as `cause` so the upstream chain is debuggable.
        expect(err._tag).toBe("ProviderError")
        expect(err.cause).toBe(original)
      }
    }
  })

  test("driver ProviderAuthError surfaces typed at the provider boundary", async () => {
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

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "auth-missing/model",
          prompt: [],
        })
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
  })

  test("BedrockExtension resolveModel fails closed as ProviderAuthError (W6-14)", async () => {
    // W6-14: bedrock has no @effect/ai provider at beta.47. The contribution
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

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "bedrock/some-model",
          prompt: [],
        })
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
  })

  test("auth store read failures fail closed before resolving the model", async () => {
    let resolved = false
    const provider: ModelDriverContribution = {
      id: "auth-fails",
      name: "AuthFails",
      resolveModel: () => {
        resolved = true
        return fakeResolution()
      },
    }
    const authStore = {
      ...testAuthStorage,
      get: () => Effect.fail(new AuthStoreError({ message: "read failed" })),
    }
    const layer = buildProviderLayer([makeExt("auth-fails-ext", [provider])], authStore)

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.stream({
          model: "auth-fails/model",
          prompt: [],
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(result._tag).toBe("Failure")
    expect(resolved).toBe(false)
    expect(result.toString()).toContain('Failed to read auth for provider "auth-fails"')
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
          streamText: (options: any) => {
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
        } as unknown as LanguageModel.Service),
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
          streamText: (options: any) => {
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
        } as unknown as LanguageModel.Service),
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
          streamText: (options: any) => {
            capturedToolkit = options.toolkit
            return Stream.fromIterable([
              toolCallPart(
                "typedEcho",
                { text: "from-message" },
                { toolCallId: ToolCallId.make("typed-tc-2") },
              ),
              finishPart({
                finishReason: "tool-calls",
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            ])
          },
        } as unknown as LanguageModel.Service),
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typed toolkit narrows the generic
        const stream = yield* provider.stream(request as never)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- typed toolkit narrows the generic
        const typedStream: Stream.Stream<
          Response.StreamPart<TypedTools>,
          ProviderError
        > = stream as never
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
          streamText: (options: any) => {
            capturedPrompt = options.prompt
            return Stream.fromIterable([
              finishPart({
                finishReason: "stop",
                usage: { inputTokens: 3, outputTokens: 1 },
              }),
            ])
          },
        } as unknown as LanguageModel.Service),
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
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
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
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
                role: "assistant",
                parts: [new ReasoningPart({ type: "reasoning", text: "look at image metadata" })],
                createdAt: new Date(0),
              }),
              Message.Regular.make({
                id: "hidden",
                sessionId: SessionId.make("prompt-session"),
                branchId: BranchId.make("prompt-branch"),
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

  // Cause-preservation contract (provider.ts:631-639, provider.ts:673-680):
  // when the underlying LanguageModel fails, both `Provider.stream`'s
  // `Stream.catch` and `Provider.generate`'s `Effect.mapError` must wrap
  // the original error as `ProviderError.cause`. Loss of cause severs
  // the upstream chain — the resulting ProviderError reads as a generic
  // wrapper with the underlying AiError.reason / driver-specific detail
  // unrecoverable.
  test("Provider.stream preserves the underlying AiError as ProviderError.cause", async () => {
    const originalAiError = AiError.make({
      module: "Test",
      method: "streamText",
      reason: new AiError.UnknownError({ description: "stream-cause-marker" }),
    })
    const causeProvidingModel: LanguageModel.Service = {
      ...failingLanguageModel,
      streamText: () => Stream.fail(originalAiError),
    }
    const causeProvider: ModelDriverContribution = {
      id: "cause-stream",
      name: "CauseStream",
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, causeProvidingModel),
      }),
    }
    const layer = buildProviderLayer([makeExt("cause-stream-ext", [causeProvider])])

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        const stream = yield* provider.stream({
          model: "cause-stream/gpt-5",
          prompt: [],
        })
        yield* Stream.runHead(stream)
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(errOpt._tag).toBe("Some")
      if (errOpt._tag === "Some") {
        const err = errOpt.value as ProviderError
        expect(err._tag).toBe("ProviderError")
        // The original AiError must be preserved by reference. A future
        // refactor that constructed a fresh error or stringified the
        // cause would break this — and would silently sever the upstream
        // chain in production at the same time.
        expect(err.cause).toBe(originalAiError)
      }
    }
  })

  test("Provider.generate preserves the underlying AiError as ProviderError.cause", async () => {
    const originalAiError = AiError.make({
      module: "Test",
      method: "generateText",
      reason: new AiError.UnknownError({ description: "generate-cause-marker" }),
    })
    const causeProvidingModel: LanguageModel.Service = {
      ...failingLanguageModel,
      generateText: () => Effect.fail(originalAiError),
    }
    const causeProvider: ModelDriverContribution = {
      id: "cause-generate",
      name: "CauseGenerate",
      resolveModel: () => ({
        layer: Layer.succeed(LanguageModel.LanguageModel, causeProvidingModel),
      }),
    }
    const layer = buildProviderLayer([makeExt("cause-generate-ext", [causeProvider])])

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const provider = yield* Provider
        yield* provider.generate({
          model: "cause-generate/gpt-5",
          prompt: [],
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const errOpt = Cause.findErrorOption(result.cause)
      expect(errOpt._tag).toBe("Some")
      if (errOpt._tag === "Some") {
        const err = errOpt.value as ProviderError
        expect(err._tag).toBe("ProviderError")
        expect(err.cause).toBe(originalAiError)
      }
    }
  })
})
