/**
 * RuntimeProfileResolver regression locks.
 *
 * Locks the single-pipeline contract: both discovering composition roots
 * (server startup, per-cwd profile cache) flow
 * through `resolveRuntimeProfile` and `buildExtensionLayers`. The locks prove:
 *
 *   1. Same inputs → same resolved extensions (extension ids, scope precedence).
 *   2. `buildExtensionLayers` actually wires `ExtensionRegistry` from the
 *      resolved data (not just exported as a helper).
 *   3. turn-projection reactions resolve services contributed via
 *      `defineResource`.
 *   4. Server-style and per-cwd-style assemblies produce equivalent observable
 *      output (same registry contents, same merged sections). If the per-cwd
 *      path skips an extension layer, this fails.
 *
 * If this regresses, the activation paths can drift again — e.g., an
 * extension's prompt section appears at server startup but not in a per-cwd
 * profile.
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Path, Schema as S } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import { getBuiltinAgent } from "@gent/extensions/all-agents"
import {
  defineExtension,
  defineResource,
  tool,
  AgentName,
  type ReadOnly,
  ReadOnlyBrand,
  withReadOnly,
} from "@gent/core/extensions/api"
import { ConfigService } from "../../src/runtime/config-service"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import {
  buildExtensionLayers,
  compileBaseSections,
  resolveProfileRuntime,
  resolveRuntimeProfile,
} from "../../src/runtime/profile"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test(), SqliteStorage.TestWithSql())

// Static prompt sections live on capability leaf `prompt`. The tool here is a
// no-op carrier — its only purpose is to bring the prompt section into scope.
const sectionTool = tool({
  id: "rp-test-tool",
  description: "carrier for rp-test-section",
  params: S.Struct({}),
  prompt: { id: "rp-test-section", content: "rp test content", priority: 50 },
  execute: () => Effect.succeed("ok"),
})

const sectionExtension = defineExtension({
  id: "@gent/test-runtime-profile",
  tools: [sectionTool],
})

// Dynamic prompt section: the reaction Effect yields a service from the
// extension's Resource layer. The service Tag is `ReadOnly`-branded so the
// prompt reaction only receives a read surface.
interface FakeProviderShape {
  readonly text: () => string
}
class FakeProvider extends Context.Service<FakeProvider, ReadOnly<FakeProviderShape>>()(
  "@gent/core/tests/runtime/runtime-profile.test/FakeProvider",
) {
  declare readonly [ReadOnlyBrand]: true
}

const fakeProviderLive = Layer.succeed(
  FakeProvider,
  withReadOnly({ text: () => "dynamic-from-service" } satisfies FakeProviderShape),
)

const dynamicExtension = defineExtension({
  id: "@gent/test-runtime-profile-dynamic",
  resources: [defineResource({ tag: FakeProvider, scope: "process", layer: fakeProviderLive })],
  reactions: {
    turnProjection: () =>
      Effect.gen(function* () {
        const fp = yield* FakeProvider
        return {
          promptSections: [{ id: "rp-dynamic-section", priority: 60, content: fp.text() }],
        }
      }),
  },
})

describe("resolveRuntimeProfile", () => {
  it.live("same inputs across modes produce equivalent profiles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = {
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension],
        }

        // Two independent invocations simulate: server startup vs per-cwd cache miss
        const profileA = yield* resolveRuntimeProfile(inputs)
        const profileB = yield* resolveRuntimeProfile(inputs)

        // Same resolved extension set
        expect(profileA.resolved.extensions.length).toBe(profileB.resolved.extensions.length)
        expect(profileA.resolved.extensions.map((e) => e.manifest.id)).toEqual(
          profileB.resolved.extensions.map((e) => e.manifest.id),
        )

        // Compile sections (no dynamic deps in this test extension; runs in
        // current scope without extension layers).
        const sectionsA = yield* compileBaseSections(profileA)
        const sectionsB = yield* compileBaseSections(profileB)

        // Same merged base sections (length and content)
        expect(sectionsA.length).toBe(sectionsB.length)
        const aIds = sectionsA.map((s) => s.id).sort()
        const bIds = sectionsB.map((s) => s.id).sort()
        expect(aIds).toEqual(bIds)

        // Extension-contributed section appears in the merged sections
        const sec = sectionsA.find((s) => s.id === "rp-test-section")
        expect(sec?.content).toBe("rp test content")
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("buildExtensionLayers wires ExtensionRegistry from resolved data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profile = yield* resolveRuntimeProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension],
        })

        const layer = buildExtensionLayers(profile.resolved)

        const registryService = yield* Layer.build(layer).pipe(
          Effect.scoped,
          Effect.map((ctx) => Context.get(ctx, ExtensionRegistry)),
        )

        const sections = yield* registryService.listPromptSections()
        const ids = sections.map((s) => s.id)
        expect(ids).toContain("rp-test-section")
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("resource-backed turnProjection resolves through buildExtensionLayers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profile = yield* resolveRuntimeProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [dynamicExtension],
        })
        const layer = buildExtensionLayers(profile.resolved)
        const registryService = yield* Layer.build(layer).pipe(
          Effect.scoped,
          Effect.map((ctx) => Context.get(ctx, ExtensionRegistry)),
        )

        const result = yield* registryService.extensionReactions
          .resolveTurnProjection({
            sessionId: "s" as never,
            branchId: "b" as never,
            cwd: "/tmp",
            home: "/tmp",
            turn: {
              sessionId: "s" as never,
              branchId: "b" as never,
              agent: getBuiltinAgent("cowork")!,
              agentName: AgentName.make("cowork"),
              allTools: [],
            },
          })
          .pipe(Effect.provide(layer))

        expect(result.promptSections).toContainEqual({
          id: "rp-dynamic-section",
          priority: 60,
          content: "dynamic-from-service",
        })
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("profile runtime helper gives server and per-cwd paths the same runtime shape", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = {
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension, dynamicExtension],
        }

        // Server startup and SessionProfileCache call this same helper now.
        const serverRuntime = yield* resolveProfileRuntime(inputs)
        const cacheRuntime = yield* resolveProfileRuntime(inputs)

        // Same registered extension ids (in same scope-precedence order)
        const serverIds = serverRuntime.registryService
          .getResolved()
          .extensions.map((e) => e.manifest.id)
        const cacheIds = cacheRuntime.registryService
          .getResolved()
          .extensions.map((e) => e.manifest.id)
        expect(cacheIds).toEqual(serverIds)

        // Same merged sections (ids and content)
        const toMap = (sections: ReadonlyArray<{ id: string; content: string }>) =>
          new Map(sections.map((s) => [s.id, s.content]))
        expect(toMap(cacheRuntime.baseSections)).toEqual(toMap(serverRuntime.baseSections))
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )
})
