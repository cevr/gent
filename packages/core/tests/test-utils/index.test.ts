import { BunServices } from "@effect/platform-bun"
import { test } from "bun:test"
import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { AgentDefinition, AgentName } from "../../src/domain/agent"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  type E2ELayerConfig,
  hostProfileRegistry,
} from "../../src/test-utils/harness"
import { RuntimeEnvironment } from "../../src/runtime/config"
import { CurrentWorkspaceId } from "../../src/domain/ids"
import { workspaceIdForCwd } from "../../src/server/workspace-rpc"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { SessionProfileCache } from "../../src/runtime/extension-host"
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api"

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

test("branch tool storage tags require a branch tool feature", () => {
  const config = { providerLayer: LanguageModelLayers.debug(), agents: [], extensionInputs: [] }
  // @ts-expect-error -- omitted branch tools cannot promise a storage service
  createE2ELayer<ResourceInstance>(config)
  // @ts-expect-error -- a widened configuration cannot promise uninstalled storage
  const missingFeature: E2ELayerConfig<ResourceInstance> = config
  expect(missingFeature.agents).toEqual([])
})

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
