import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Cause, Context, Effect, Fiber, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type * as Response from "effect/ai/Response"
import { AgentDefinition, AgentName, ModelId } from "../../src/domain/agent"
import { GentPlatform } from "../../src/runtime/gent-platform"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  type E2ELayerConfig,
  hostProfileRegistry,
  LanguageModelLayers,
  runToolWithCtx,
  testToolContext,
  type SequenceStep,
} from "../../src/test-utils/harness"
import { convertTools } from "../../src/runtime/tools"
import { ModelResolver, textStep, toolCallStep } from "../../src/runtime/provider"
import { RuntimeEnvironment } from "../../src/runtime/config"
import { CurrentWorkspaceId } from "../../src/domain/ids"
import { workspaceIdForCwd } from "../../src/server/workspace-rpc"
import {
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"

/** The server root with the stub tool runner, the scripted model, and no agents. */
const toolLayer = (config: {
  readonly extensionInputs: NonNullable<E2ELayerConfig["extensionInputs"]>
}) =>
  createE2ELayer({
    ...config,
    providerLayer: LanguageModelLayers.debug(),
    agents: [],
    toolRunner: "test",
  })

// ── extension tool layer ────────────────────────────────────────────────────

class ResourceInstance extends Context.Service<ResourceInstance, { readonly id: number }>()(
  "@gent/core/tests/test-utils/index.test/ResourceInstance",
) {}

describe("extension tool test layer", () => {
  it.live("uses the one built resource instance and releases it once", () =>
    Effect.gen(function* () {
      let acquired = 0
      let released = 0
      const extension = defineExtension({
        id: "resource-instance",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/resource-instance",
              scope: "process",
              layer: Layer.effect(
                ResourceInstance,
                Effect.acquireRelease(
                  Effect.sync(() => ({ id: ++acquired })),
                  () =>
                    Effect.sync(() => {
                      released++
                    }),
                ),
              ),
            }),
          )
        }),
      })
      yield* Effect.gen(function* () {
        // A resource lives in its profile, not in the server context: the
        // launch profile is the one of the launch cwd in its workspace.
        const { cwd } = yield* RuntimeEnvironment
        const profile = yield* (yield* SessionProfileCache)
          .resolve(cwd)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceIdForCwd(cwd)))
        const instance = Context.get(profile.layerContext, ResourceInstance)
        expect(instance.id).toBe(1)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(Effect.provide(toolLayer({ extensionInputs: [extension] })), Effect.scoped)
      expect(released).toBe(1)
    }),
  )
})

// ── e2e layer agents ────────────────────────────────────────────────────────

describe("createE2ELayer agents", () => {
  const reviewer = AgentDefinition.make({
    name: AgentName.make("reviewer"),
    description: "Agent named only in the layer config",
  })

  it.scopedLive("registers the configured agents beside extension inputs", () =>
    Effect.gen(function* () {
      const registry = yield* hostProfileRegistry
      expect(registry.getResolved().agents.get("reviewer")).toBe(reviewer)
    }).pipe(
      Effect.provide(
        createE2ELayer({
          providerLayer: LanguageModelLayers.debug(),
          agents: [reviewer],
          extensionInputs: [defineExtension({ id: "no-agents", setup: Effect.void })],
          toolRunner: "test",
        }),
      ),
    ),
  )
})

// ── tool test runner ────────────────────────────────────────────────────────

/** A tool that reports the host name its platform gives. */
const HostNameTool = tool({
  id: "host-name",
  description: "Report the host name",
  params: Schema.Struct({}),
  output: Schema.String,
  execute: () =>
    Effect.flatMap(GentPlatform, (platform) =>
      Effect.map(platform.osInfo, (info) => info.hostname),
    ),
})

describe("a tool run over a stub host", () => {
  it.live("a platform service the test provides replaces the harness one", () =>
    runToolWithCtx(HostNameTool, {}, testToolContext()).pipe(
      Effect.provide(GentPlatform.Test()),
      Effect.map((hostname) => expect(hostname).toBe("test-host")),
      Effect.timeout("5 seconds"),
    ),
  )
})

// ── the test root's working directory ───────────────────────────────────────

describe("the test root's working directory", () => {
  const fsTest = it.scopedLive.layer(BunServices.layer)
  const bareConfig = {
    providerLayer: LanguageModelLayers.debug(),
    agents: [],
    extensionInputs: [],
  } satisfies E2ELayerConfig

  /** The layer's cwd and home while it runs, and whether the cwd exists then. */
  const whileRunning = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const environment = yield* RuntimeEnvironment
    return {
      cwd: environment.cwd,
      home: environment.home,
      existed: yield* fs.exists(environment.cwd),
    }
  }).pipe(Effect.provide(createE2ELayer({ ...bareConfig, toolRunner: "test" })))

  fsTest("each layer runs in a temp directory of its own, removed with the layer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const first = yield* whileRunning
      const second = yield* whileRunning
      expect(first.existed).toBe(true)
      expect(path.basename(first.cwd)).toStartWith("gent-test-cwd-")
      expect(first.cwd).not.toBe(first.home)
      expect(second.cwd).not.toBe(first.cwd)
      expect(yield* fs.exists(first.cwd)).toBe(false)
    }).pipe(Effect.timeout("10 seconds")),
  )

  fsTest("the RPC harness seeds its session in a temp working directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { client, sessionId } = yield* createRpcHarness(bareConfig)
      const cwd = (yield* client.session.get({ sessionId }))?.cwd ?? ""
      expect(path.basename(cwd)).toStartWith("gent-test-cwd-")
      expect(yield* fs.exists(cwd)).toBe(true)
    }).pipe(Effect.timeout("10 seconds")),
  )

  fsTest("a layer runs in the cwd and home it is given", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-given-cwd-" })
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-given-home-" })
      const environment = yield* RuntimeEnvironment.pipe(
        Effect.provide(createE2ELayer({ ...bareConfig, cwd, home, toolRunner: "test" })),
      )
      expect({ cwd: environment.cwd, home: environment.home }).toEqual({ cwd, home })
      // A given directory is the test's: the layer leaves it in place.
      expect(yield* fs.exists(home)).toBe(true)
    }).pipe(Effect.timeout("10 seconds")),
  )

  fsTest("a layer restarted on the same database and home lists the sessions made before", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-restart-" })
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-test-restart-home-" })
      // No environment override: the database's directory is the working
      // directory of both layers, as it is for a host restarted in place.
      const layer = createE2ELayer({
        ...bareConfig,
        storagePath: `${directory}/gent.db`,
        home,
        toolRunner: "test",
      })
      const created = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(layer)
          return yield* client.session.create({ cwd: directory })
        }),
      )
      const listed = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(layer)
          return yield* client.session.list()
        }),
      )
      expect(listed.map((session) => session.id)).toEqual([created.sessionId])
    }).pipe(Effect.timeout("10 seconds")),
  )
})

// ── sequence language model ─────────────────────────────────────────────────

const testToolkit = convertTools([
  tool({
    id: "my_tool",
    description: "Test tool",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
  tool({
    id: "tool_a",
    description: "Test tool A",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
  tool({
    id: "tool_b",
    description: "Test tool B",
    params: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.Void,
    execute: () => Effect.void,
  }),
])

const callProvider = Effect.gen(function* () {
  const parts = yield* LanguageModel.streamText({
    prompt: [],
    toolkit: testToolkit,
    disableToolCallResolution: true,
  }).pipe(Stream.runCollect)
  return Array.from(parts) satisfies ReadonlyArray<Response.AnyPart>
})

describe("LanguageModelLayers.sequence", () => {
  it.scoped("single text step emits correctly", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([textStep("hello")])
      const parts = yield* Effect.provide(callProvider, layer)

      expect(parts).toMatchObject([
        { type: "text-delta", delta: "hello" },
        { type: "finish", reason: "stop" },
      ])

      yield* controls.assertDone
    }),
  )

  it.scoped("multi-step returns correct parts per call", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first"),
        textStep("second"),
        toolCallStep("my_tool", { key: "value" }),
      ])

      const c1 = yield* Effect.provide(callProvider, layer)
      expect(c1[0]).toMatchObject({ type: "text-delta", delta: "first" })

      const c2 = yield* Effect.provide(callProvider, layer)
      expect(c2[0]).toMatchObject({ type: "text-delta", delta: "second" })

      const c3 = yield* Effect.provide(callProvider, layer)
      expect(c3).toMatchObject([{ type: "tool-call" }, { type: "finish", reason: "tool-calls" }])

      yield* controls.assertDone
    }),
  )

  it.scoped("waitForCall resolves on model stream #n", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.sequence([
        textStep("a"),
        textStep("b"),
      ])

      // Start waiting for call 1 (hasn't happened yet)
      const fiber = yield* Effect.forkScoped(controls.waitForCall(1))

      // Call 0
      yield* Effect.provide(callProvider, layer)

      // Call 1 — should resolve waitForCall(1)
      const streamFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))
      yield* Fiber.join(fiber)

      yield* Fiber.join(streamFiber)
    }),
  )

  it.scoped("gated step holds until emitAll", () =>
    Effect.gen(function* () {
      const gatedStep: SequenceStep = { ...textStep("gated"), gated: true }
      const { layer, controls } = yield* LanguageModelLayers.sequence([gatedStep])

      // Start stream — will block on gate
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callProvider, layer))

      // Confirm call started
      yield* controls.waitForCall(0)

      // Release the gate
      yield* controls.emitAll(0)

      const parts = yield* Fiber.join(collectFiber)
      expect(parts).toMatchObject([{ type: "text-delta", delta: "gated" }, { type: "finish" }])
    }),
  )

  it.scoped("extra model stream call fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* LanguageModelLayers.sequence([textStep("only")])

      // Consume the one step
      yield* Effect.provide(callProvider, layer)

      // Second call should fail
      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("2 times but only 1 steps")
      }
    }),
  )

  it.scoped("assertOptions fires and can fail the stream", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertOptions: (options) => {
          expect(options.tools).not.toHaveLength(3)
        },
      }
      const { layer } = yield* LanguageModelLayers.sequence([step])

      const exit = yield* Effect.exit(Effect.provide(callProvider, layer))
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const pretty = Cause.pretty(exit.cause)
        expect(pretty).toContain("assertOptions failed at step 0")
      }
    }),
  )

  it.scoped("assertDone fails after an assertOptions failure the loop swallowed", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertOptions: () => {
          expect("sent").toBe("expected")
        },
      }
      const { layer, controls } = yield* LanguageModelLayers.sequence([step])

      // A turn reads the failed stream as a provider error and goes on, so the
      // failure must reach the test through `assertDone`.
      yield* Effect.exit(Effect.provide(callProvider, layer))
      const done = yield* Effect.exit(controls.assertDone)
      expect(done._tag).toBe("Failure")
      if (done._tag === "Failure") {
        expect(Cause.pretty(done.cause)).toContain("assertOptions failed at step 0")
      }
    }),
  )

  it.scoped("assertDone fails after an assertRequest failure", () =>
    Effect.gen(function* () {
      const step: SequenceStep = {
        ...textStep("guarded"),
        assertRequest: () => {
          expect("sent-model").toBe("expected-model")
        },
      }
      const { layer, controls } = yield* LanguageModelLayers.sequence([step])
      const resolve = Effect.gen(function* () {
        const resolver = yield* ModelResolver
        return yield* resolver.resolve({ modelId: ModelId.make("test/model") })
      }).pipe(
        Effect.provideService(
          ExtensionRegistry,
          ExtensionRegistry.of({
            getResolved: () => resolveExtensions([]),
            providerConfig: Effect.succeed({}),
          }),
        ),
      )

      yield* Effect.exit(Effect.provide(resolve, LanguageModelLayers.resolver(layer)))
      yield* Effect.provide(callProvider, layer)
      const done = yield* Effect.exit(controls.assertDone)
      expect(done._tag).toBe("Failure")
      if (done._tag === "Failure") {
        expect(Cause.pretty(done.cause)).toContain("assertRequest failed at step 0")
      }
    }),
  )

  it.scoped("assertDone fails on unconsumed steps", () =>
    Effect.gen(function* () {
      const { controls } = yield* LanguageModelLayers.sequence([textStep("a"), textStep("b")])

      const result = yield* Effect.exit(controls.assertDone)
      expect(result._tag).toBe("Failure")
    }),
  )
})

// ── signal language model ───────────────────────────────────────────────────

const callSignalProvider = LanguageModel.streamText({ prompt: [] }).pipe(Stream.runCollect)

describe("LanguageModelLayers.signal", () => {
  it.scoped("waitForStreamStart resolves once LanguageModel stream is invoked", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.signal("hi.")
      // Drain in the background — gate stays closed but the model stream is called.
      yield* Effect.forkScoped(Effect.provide(callSignalProvider, layer))
      yield* controls.waitForStreamStart
    }),
  )

  it.scoped("emitAll releases every gated chunk in order", () =>
    Effect.gen(function* () {
      const { layer, controls } = yield* LanguageModelLayers.signal("hi.")
      const collectFiber = yield* Effect.forkScoped(Effect.provide(callSignalProvider, layer))
      yield* controls.waitForStreamStart
      yield* controls.emitAll
      const collected = yield* Fiber.join(collectFiber)

      // One text-delta + one finish part for "hi.".
      expect(collected.length).toBe(2)
      expect(collected[0]?.type).toBe("text-delta")
      expect(collected[1]?.type).toBe("finish")
    }),
  )
})
