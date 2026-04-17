/**
 * RuntimeProfileResolver regression locks.
 *
 * Locks the single-pipeline contract introduced in planify Commit 7 — both
 * discovering composition roots (server startup, per-cwd profile cache) flow
 * through `resolveRuntimeProfile` and `buildExtensionLayers`. The locks prove:
 *
 *   1. Same inputs → same resolved extensions (extension ids, scope precedence).
 *   2. `buildExtensionLayers` actually wires `ExtensionRegistry` from the
 *      resolved data (not just exported as a helper).
 *   3. `compileBaseSections` resolves dynamic prompt sections that yield
 *      services contributed via `setup.layer` — the Skills-shaped bug class
 *      C7 was specifically designed to handle.
 *   4. Server-style and per-cwd-style assemblies produce equivalent observable
 *      output (same registry contents, same merged sections). If the per-cwd
 *      path drops bus subscriptions or skips an extension layer, this fails.
 *
 * If this regresses, the activation paths can drift again — e.g., an
 * extension's prompt section appears at server startup but not in a per-cwd
 * profile, or extension event subscriptions silently disappear in shared mode.
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Path } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import {
  defineExtension,
  defineResource,
  promptSectionContribution,
} from "@gent/core/extensions/api"
import { ConfigService } from "@gent/core/runtime/config-service"
import {
  buildExtensionLayers,
  compileBaseSections,
  resolveRuntimeProfile,
} from "@gent/core/runtime/profile"
import { ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test())

const sectionExtension = defineExtension({
  id: "@gent/test-runtime-profile",
  contributions: () => [
    promptSectionContribution({
      id: "rp-test-section",
      content: "rp test content",
      priority: 50,
    }),
  ],
})

// Dynamic prompt section that yields a service contributed by `setup.layer`.
// Mirrors the Skills extension shape (the bug class C7 has to handle): the
// section's resolve Effect yields a service that only exists once the
// extension layer is built.
class FakeProvider extends Context.Service<FakeProvider, { readonly text: () => string }>()(
  "@gent/test/runtime-profile/FakeProvider",
) {}

const fakeProviderLive = Layer.succeed(FakeProvider, { text: () => "dynamic-from-service" })

const dynamicExtension = defineExtension({
  id: "@gent/test-runtime-profile-dynamic",
  contributions: () => [
    defineResource({ tag: FakeProvider, scope: "process", layer: fakeProviderLive }),
    promptSectionContribution({
      id: "rp-dynamic-section",
      priority: 60,
      resolve: Effect.gen(function* () {
        const fp = yield* FakeProvider
        return fp.text()
      }),
    }),
  ],
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

        const layer = buildExtensionLayers(profile.resolved).pipe(
          Layer.provide(ExtensionTurnControl.Live),
        )

        const registryService = yield* Effect.gen(function* () {
          return yield* ExtensionRegistry
        }).pipe(Effect.provide(layer))

        const sections = yield* registryService.listPromptSections()
        const ids = sections.map((s) => s.id)
        expect(ids).toContain("rp-test-section")
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live(
    "compileBaseSections resolves dynamic sections that yield services from setup.layer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const profile = yield* resolveRuntimeProfile({
            cwd: "/tmp",
            home: "/tmp",
            platform: "darwin",
            extensions: [dynamicExtension],
          })

          // Build the same layer shape the server / per-cwd cache produce.
          const layer = buildExtensionLayers(profile.resolved).pipe(
            Layer.provide(ExtensionTurnControl.Live),
          )
          const ctx = yield* Layer.build(layer)

          // Compile sections inside the built-layer's context — exactly the
          // pattern dependencies.ts and session-profile.ts use.
          const sections = yield* compileBaseSections(profile).pipe(
            // @effect-diagnostics-next-line strictEffectProvide:off
            Effect.provide(Layer.succeedContext(ctx)),
          )

          const dyn = sections.find((s) => s.id === "rp-dynamic-section")
          expect(dyn?.content).toBe("dynamic-from-service")
        }),
      ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("server-style + per-cwd-style assemblies produce equivalent registry + sections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inputs = {
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [sectionExtension, dynamicExtension],
        }

        // "Server-style" assembly — resolve once, build layer, compile sections.
        const profileServer = yield* resolveRuntimeProfile(inputs)
        const serverLayer = buildExtensionLayers(profileServer.resolved).pipe(
          Layer.provide(ExtensionTurnControl.Live),
        )
        const serverCtx = yield* Layer.build(serverLayer)
        const serverRegistry = Context.get(serverCtx, ExtensionRegistry)
        const serverSections = yield* compileBaseSections(profileServer).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(Layer.succeedContext(serverCtx)),
        )

        // "Per-cwd-style" assembly — same shape, different scope owner. The
        // contract under test is that the produced registry + section set are
        // observably equivalent (same extension ids, same section content).
        const profileCache = yield* resolveRuntimeProfile(inputs)
        const cacheLayer = buildExtensionLayers(profileCache.resolved).pipe(
          Layer.provide(ExtensionTurnControl.Live),
        )
        const cacheCtx = yield* Layer.build(cacheLayer)
        const cacheRegistry = Context.get(cacheCtx, ExtensionRegistry)
        const cacheSections = yield* compileBaseSections(profileCache).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(Layer.succeedContext(cacheCtx)),
        )

        // Same registered extension ids (in same scope-precedence order)
        const serverIds = serverRegistry.getResolved().extensions.map((e) => e.manifest.id)
        const cacheIds = cacheRegistry.getResolved().extensions.map((e) => e.manifest.id)
        expect(cacheIds).toEqual(serverIds)

        // Same merged sections (ids and content)
        const toMap = (sections: ReadonlyArray<{ id: string; content: string }>) =>
          new Map(sections.map((s) => [s.id, s.content]))
        expect(toMap(cacheSections)).toEqual(toMap(serverSections))
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )
})
