import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { AgentDefinition, AgentName } from "../../src/domain/agent"
import { ExtensionId, SessionId } from "../../src/domain/ids"
import type { Session } from "../../src/domain/message"
import {
  createE2ELayer,
  createRpcHarness,
  ensureStorageParents,
  type E2ELayerConfig,
} from "../../src/test-utils/harness"
import { RuntimeEnvironment } from "../../src/runtime/config"
import { LanguageModelLayers } from "../../src/test-utils/language-model"
import { SessionStorage, type SessionStorageService } from "../../src/storage/storage"
import { ExtensionRegistry } from "../../src/runtime/extension-host"
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"

// ── ensure storage parents ──────────────────────────────────────────────────

const sessionOnlyLayer = (sessions: Ref.Ref<ReadonlyMap<SessionId, Session>>) =>
  Layer.succeed(SessionStorage, {
    createSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    getSession: (id) => Ref.get(sessions).pipe(Effect.map((map) => map.get(id))),
    listSessions: Ref.get(sessions).pipe(Effect.map((map) => [...map.values()])),
    renameSession: () => Effect.void,
    updateSessionSettings: () => Effect.void,
    setActiveBranch: () => Effect.void,
    deleteSession: (id) =>
      Ref.modify(sessions, (map) => {
        const next = new Map(map)
        next.delete(id)
        return [[id], next]
      }),
  } satisfies SessionStorageService)

/** The server root with the stub tool runner, the scripted model, and no agents. */
const toolLayer = (config: Pick<E2ELayerConfig, "extensionInputs" | "allowFailedExtensions">) =>
  createE2ELayer({
    ...config,
    providerLayer: LanguageModelLayers.debug(),
    agents: [],
    toolRunner: "test",
  })

describe("ensureStorageParents", () => {
  it.live("creates a session without requiring branch storage", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyMap<SessionId, Session>>(new Map())
      const sessionId = SessionId.make("session-only")

      yield* ensureStorageParents({ sessionId }).pipe(Effect.provide(sessionOnlyLayer(sessions)))

      const stored = yield* Ref.get(sessions)
      expect(stored.has(sessionId)).toBe(true)
    }),
  )
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
        const instance = yield* ResourceInstance
        expect(instance.id).toBe(1)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(Effect.provide(toolLayer({ extensionInputs: [extension] })), Effect.scoped)
      expect(released).toBe(1)
    }),
  )

  it.scopedLive("excludes both extensions when tools collide in the same scope", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const resolved = registry.getResolved()
      expect([...resolved.modelCapabilities.values()]).toEqual([])
      expect(resolved.failedExtensions.map((failure) => failure.manifest.id).sort()).toEqual([
        ExtensionId.make("ext-a"),
        ExtensionId.make("ext-b"),
      ])
      expect(resolved.failedExtensions.every((failure) => failure.phase === "validation")).toBe(
        true,
      )
    }).pipe(
      Effect.provide(
        toolLayer({
          // The collision is the subject, so the layer keeps both failures to inspect.
          allowFailedExtensions: true,
          extensionInputs: ["ext-a", "ext-b"].map((id) =>
            defineExtension({
              id,
              setup: Effect.gen(function* () {
                const host = yield* ExtensionHost
                yield* host.register(
                  "tool",
                  tool({
                    id: "conflict",
                    description: id,
                    params: Schema.Struct({}),
                    output: Schema.Void,
                    execute: () => Effect.void,
                  }),
                )
              }),
            }),
          ),
        }),
      ),
    ),
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
      const registry = yield* ExtensionRegistry
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
})
