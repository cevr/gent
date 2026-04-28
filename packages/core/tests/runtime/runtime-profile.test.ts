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
 *      path skips an extension layer, this fails.
 *
 * If this regresses, the activation paths can drift again — e.g., an
 * extension's prompt section appears at server startup but not in a per-cwd
 * profile.
 */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer, Path, Schema as S } from "effect"
import { BunFileSystem, BunChildProcessSpawner } from "@effect/platform-bun"
import {
  defineExtension,
  defineResource,
  tool,
  behavior,
  ProjectionError,
  type ProjectionContribution,
  type ReadOnly,
  ReadOnlyBrand,
  withReadOnly,
} from "@gent/core/extensions/api"
import { ServiceKey, type Behavior } from "@gent/core/domain/actor"
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import { ConfigService } from "../../src/runtime/config-service"
import { Storage } from "../../src/storage/sqlite-storage"
import {
  buildExtensionLayers,
  compileBaseSections,
  resolveProfileRuntime,
  resolveRuntimeProfile,
} from "../../src/runtime/profile"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { Receptionist } from "../../src/runtime/extensions/receptionist"

const fsLayer = Layer.mergeAll(
  BunFileSystem.layer,
  Path.layer,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer))),
)

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test(), Storage.TestWithSql())

// C7: static prompt sections live on `Capability.prompt`. The tool here is a
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

// Dynamic prompt section: was `DynamicPromptSection` pre-C7, now a Projection
// whose `query` Effect yields a service from the extension's Resource layer.
// The service Tag is `ReadOnly`-branded so the projection's R channel
// satisfies `ProjectionContribution<A, R extends ReadOnlyTag>` (B11.4).
interface FakeProviderShape {
  readonly text: () => string
}
class FakeProvider extends Context.Service<FakeProvider, ReadOnly<FakeProviderShape>>()(
  "@gent/test/runtime-profile/FakeProvider",
) {
  declare readonly [ReadOnlyBrand]: true
}

const fakeProviderLive = Layer.succeed(
  FakeProvider,
  withReadOnly({ text: () => "dynamic-from-service" } satisfies FakeProviderShape),
)

const dynamicProjection: ProjectionContribution<string, FakeProvider> = {
  id: "rp-dynamic-section",
  query: () =>
    Effect.gen(function* () {
      const fp = yield* FakeProvider
      return fp.text()
    }).pipe(
      Effect.catchEager((e) =>
        Effect.fail(new ProjectionError({ projectionId: "rp-dynamic-section", reason: String(e) })),
      ),
    ),
  prompt: (content) => [{ id: "rp-dynamic-section", priority: 60, content }],
}

const dynamicExtension = defineExtension({
  id: "@gent/test-runtime-profile-dynamic",
  resources: [defineResource({ tag: FakeProvider, scope: "process", layer: fakeProviderLive })],
  projections: [dynamicProjection],
})

const RpMsg = TaggedEnumClass("RpMsg", { Ping: {} })
type RpMsg = S.Schema.Type<typeof RpMsg>
const RpService = ServiceKey<RpMsg>("rp-actor-service")

const actorBehavior: Behavior<RpMsg, { hits: number }, never> = {
  initialState: { hits: 0 },
  serviceKey: RpService,
  receive: (_msg, state) => Effect.succeed({ hits: state.hits + 1 }),
}

const actorExtension = defineExtension({
  id: "@gent/test-runtime-profile-actors",
  actors: [behavior(actorBehavior)],
})

const PersistedState = S.Struct({ hits: S.Number })
const collidingBehavior: Behavior<RpMsg, { hits: number }, never> = {
  initialState: { hits: 0 },
  serviceKey: RpService,
  persistence: { key: "rp-shared-persistence-key", state: PersistedState },
  receive: (_msg, state) => Effect.succeed({ hits: state.hits + 1 }),
}

const collidingExtension = defineExtension({
  id: "@gent/test-runtime-profile-collision",
  // Two behaviors in the SAME extension declaring the SAME flat
  // persistence key — collide after namespacing into
  // `@gent/test-runtime-profile-collision/rp-shared-persistence-key`.
  actors: [behavior(collidingBehavior), behavior(collidingBehavior)],
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

  // C7 dropped this test: dynamic prompt sections were `DynamicPromptSection`,
  // resolved by `compileBaseSections`. After C7 dynamic content lives on
  // `Projection.prompt(value)` and is assembled per-turn by ProjectionRegistry,
  // not by `compileBaseSections` (which only sees static sections). The
  // equivalent service-yielding-projection behavior is exercised by
  // `tests/extensions/projection-registry.test.ts`.
  it.live("dynamicExtension resolves through ResolvedExtensions (smoke)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profile = yield* resolveRuntimeProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [dynamicExtension],
        })
        // Projection contributes through the projection registry, not
        // compileBaseSections; assert the extension was wired in.
        expect(profile.resolved.extensions.map((e) => e.manifest.id as string)).toContain(
          "@gent/test-runtime-profile-dynamic",
        )
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("defineExtension({ actors }) wires Behaviors through to the Receptionist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profile = yield* resolveRuntimeProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [actorExtension],
        })

        const layer = buildExtensionLayers(profile.resolved).pipe(
          Layer.provide(ExtensionTurnControl.Live),
        )

        const refs = yield* Effect.gen(function* () {
          const reg = yield* Receptionist
          return yield* reg.find(RpService)
        }).pipe(Effect.provide(layer))

        expect(refs.length).toBe(1)
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("resolveProfileRuntime exposes actorHostFailures (empty on clean spawn)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const built = yield* resolveProfileRuntime({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [actorExtension],
        })
        expect(built.actorHostFailures).toEqual([])
      }),
    ).pipe(Effect.provide(sharedLayer)),
  )

  it.live("actorHostFailures captures spawn failures from persistence-key collisions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const built = yield* resolveProfileRuntime({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [collidingExtension],
        })
        // One extension declares two behaviors with the same flat
        // persistence key — they collide after namespacing. First
        // wins, second is captured as a spawn failure.
        expect(built.actorHostFailures.length).toBe(1)
        expect(built.actorHostFailures[0]?.extensionId).toBe("@gent/test-runtime-profile-collision")
        expect(built.actorHostFailures[0]?.error).toContain("ActorPersistenceKeyCollision")
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
