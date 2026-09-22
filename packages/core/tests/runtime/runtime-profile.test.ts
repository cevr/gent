import { BranchId, SessionId } from "../../src/domain/ids"
/** Profile behavior through the production live cache and child adapter. */
import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, FileSystem, Layer, Path, Schema as S } from "effect"
import { BunFileSystem, BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { getBuiltinAgent } from "../../../extensions/tests/helpers/builtin-agents.js"
import {
  AgentName,
  ExtensionHost,
  defineExtension,
  defineResource,
  tool,
} from "@gent/core/extensions/api"
import { testExtensionHostContext } from "../../src/test-utils"
import { ConfigService } from "../../src/runtime/config"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { SqliteStorage } from "../../src/storage/storage"
import {
  CurrentExtensionHostContext,
  ExtensionRegistry,
  loadRuntimeProfileDeclarations,
  type RuntimeProfileInputs,
  SessionProfileCache,
} from "../../src/runtime/extension-host"

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, BunGentPlatformLive),
  childProcessSpawnerLive,
)

const sharedLayer = Layer.mergeAll(
  fsLayer,
  ConfigService.Test(),
  SqliteStorage.TestWithSql(() => Layer.empty, {}),
)

// Build a fresh production cache in the test's owning scope.
const openProfile = Effect.fn("RuntimeProfileTest.openProfile")(function* (
  inputs: RuntimeProfileInputs,
  // Only a test about a failing extension turns this off.
  failOnExtensionFailure = true,
) {
  const context = yield* Layer.build(
    SessionProfileCache.Live({ ...inputs, failOnExtensionFailure }),
  )
  const cache = Context.get(context, SessionProfileCache)
  const profile = yield* cache.resolve(inputs.cwd)
  return { ...profile, profile }
})

// Dynamic prompt section: the hook Effect yields a service from the
// extension's Resource layer. The service Tag is `ReadOnly`-branded so the
// prompt hook only receives a read surface.
interface FakeProviderApi {
  readonly text: () => string
}
class FakeProvider extends Context.Service<FakeProvider, FakeProviderApi>()(
  "@gent/core/tests/runtime/runtime-profile.test/FakeProvider",
) {}

interface ScopedProbeApi {
  readonly instance: number
}
class ScopedProbe extends Context.Service<ScopedProbe, ScopedProbeApi>()(
  "@gent/core/tests/runtime/runtime-profile.test/ScopedProbe",
) {}

interface PureProbeApi {
  readonly value: string
}
class PureProbe extends Context.Service<PureProbe, PureProbeApi>()(
  "@gent/core/tests/runtime/runtime-profile.test/PureProbe",
) {}

interface PrecedenceProbeApi {
  readonly value: string
}
class PrecedenceProbe extends Context.Service<PrecedenceProbe, PrecedenceProbeApi>()(
  "@gent/core/tests/runtime/runtime-profile.test/PrecedenceProbe",
) {}

const fakeProviderLive = Layer.succeed(FakeProvider, {
  text: () => "dynamic-from-service",
} satisfies FakeProviderApi)

const dynamicExtension = defineExtension({
  id: "@gent/test-runtime-profile-dynamic",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "test/runtime-profile/fake-provider",
        scope: "process",
        layer: fakeProviderLive,
      }),
    )
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const fp = yield* FakeProvider
        return {
          promptSections: [{ id: "rp-dynamic-section", priority: 60, content: fp.text() }],
        }
      }),
    )
  }),
})

describe("live Profile", () => {
  const test = it.live.layer(BunServices.layer)

  test("loads declarations without building resource layers before boot activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        let nextInstance = 0
        const events: Array<readonly [string, number]> = []

        const resourceExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-resource",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/declaration-resource",
                scope: "process",
                layer: Layer.effect(
                  ScopedProbe,
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      const instance = ++nextInstance
                      events.push(["acquire", instance])
                      return ScopedProbe.of({ instance })
                    }),
                    (probe) => Effect.sync(() => events.push(["release", probe.instance])),
                  ),
                ),
              }) as never,
            )
          }),
        })
        const validTool = tool({
          id: "rp-declaration-collision",
          description: "valid collision fixture",
          params: S.Struct({}),
          output: S.String,
          execute: () => Effect.succeed("ok"),
        })
        const invalidTool = tool({
          id: "rp-declaration-collision",
          description: "invalid collision fixture",
          params: S.Struct({}),
          output: S.String,
          execute: () => Effect.succeed("ok"),
        })
        const validExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-valid",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", validTool)
          }),
        })
        const invalidExtension = defineExtension({
          id: "@gent/test-runtime-profile/declaration-invalid",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("tool", invalidTool)
          }),
        })
        const inputs = {
          cwd: home,
          home,
          platform: "darwin",
          extensions: [resourceExtension, validExtension, invalidExtension],
        }
        const declarations = yield* loadRuntimeProfileDeclarations(inputs)
        expect(events).toEqual([])
        expect(declarations.extensionDeclarations.failed).toContainEqual(
          expect.objectContaining({
            manifest: { id: "@gent/test-runtime-profile/declaration-invalid" },
            phase: "validation",
          }),
        )

        // The collision is the subject, so the build keeps going past it.
        const runtimeExit = yield* Effect.exit(Effect.scoped(openProfile(inputs, false)))
        expect(runtimeExit._tag).toBe("Success")
        if (runtimeExit._tag === "Success") {
          expect(runtimeExit.value.profile.resolved.failedExtensions).toContainEqual(
            expect.objectContaining({
              manifest: { id: "@gent/test-runtime-profile/declaration-invalid" },
              phase: "validation",
            }),
          )
        }
        expect(events).toEqual([
          ["acquire", 1],
          ["release", 1],
        ])
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("live Profile builds a process resource layer once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0
        const extension = defineExtension({
          id: "@gent/test-runtime-profile-start-once",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/start-once",
                scope: "process",
                layer: Layer.effectDiscard(
                  Effect.sync(() => {
                    starts += 1
                  }),
                ),
              }) as never,
            )
          }),
        })

        yield* openProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [extension],
        })

        expect(starts).toBe(1)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("live Profile preserves one scoped resource instance for hooks and shutdown", () =>
    Effect.gen(function* () {
      let nextInstance = 0
      const events: Array<readonly [string, number]> = []
      const extension = defineExtension({
        id: "@gent/test-runtime-profile-resource-identity",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/runtime-profile/resource-identity",
              scope: "process",
              layer: Layer.effect(
                ScopedProbe,
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const instance = ++nextInstance
                    events.push(["acquire", instance])
                    return ScopedProbe.of({ instance })
                  }),
                  (probe) => Effect.sync(() => events.push(["release", probe.instance])),
                ),
              ),
            }) as never,
            // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/runtime-profile/resource-identity/pure",
              scope: "process",
              layer: Layer.succeed(PureProbe, { value: "pure" } satisfies PureProbeApi),
            }) as never,
          )
          yield* host.on("turnProjection", () =>
            Effect.gen(function* () {
              const probe = yield* ScopedProbe
              const pureProbe = yield* PureProbe
              events.push(["capability", probe.instance])
              return {
                promptSections: [{ id: "pure-probe", priority: 1, content: pureProbe.value }],
              }
            }),
          )
        }),
      })

      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* openProfile({
              cwd: "/tmp",
              home: "/tmp",
              platform: "darwin",
              extensions: [extension],
            })

            const hookCtx = {
              projection: {
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                agent: getBuiltinAgent("cowork")!,
                agentName: AgentName.make("cowork"),
                allTools: [],
              },
              host: testExtensionHostContext({
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                cwd: "/tmp",
                home: "/tmp",
              }),
            }

            // The turn provides the profile's layer context, which carries the
            // built process resources, exactly as the agent loop does.
            const result = yield* runtime.registryService
              .getResolved()
              .extensionHooks.resolveTurnProjection(hookCtx.projection)
              .pipe(
                Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
                Effect.provideContext(runtime.layerContext),
              )
            expect(result.promptSections).toEqual([
              { id: "pure-probe", priority: 1, content: "pure" },
            ])
            expect(events).toEqual([
              ["acquire", 1],
              ["capability", 1],
            ])
          }),
        ),
      )

      expect(exit._tag).toBe("Success")
      expect(events).toEqual([
        ["acquire", 1],
        ["capability", 1],
        ["release", 1],
      ])
    }).pipe(Effect.provide(sharedLayer)))

  test("resource assembly follows resolved extension order for acquired and pure services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let starts = 0
        const activatedExtension = defineExtension({
          id: "@gent/test-runtime-profile-precedence/activated",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/precedence/activated",
                scope: "process",
                layer: Layer.effect(
                  PrecedenceProbe,
                  Effect.sync(() => {
                    starts += 1
                    return { value: "activated" } satisfies PrecedenceProbeApi
                  }),
                ),
              }) as never,
            )
          }),
        })
        const pureExtension = defineExtension({
          id: "@gent/test-runtime-profile-precedence/pure",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
              defineResource({
                id: "test/runtime-profile/precedence/pure",
                scope: "process",
                layer: Layer.succeed(PrecedenceProbe, {
                  value: "pure",
                } satisfies PrecedenceProbeApi),
              }) as never,
            )
          }),
        })

        for (const { extensions, expected } of [
          { extensions: [activatedExtension, pureExtension], expected: "pure" },
          { extensions: [pureExtension, activatedExtension], expected: "pure" },
        ]) {
          const runtime = yield* openProfile({
            cwd: "/tmp",
            home: "/tmp",
            platform: "darwin",
            extensions,
          })
          expect(Context.get(runtime.layerContext, PrecedenceProbe).value).toBe(expected)
        }

        expect(starts).toBe(2)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("resource-backed turnProjection resolves through the profile registry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layerContext } = yield* openProfile({
          cwd: "/tmp",
          home: "/tmp",
          platform: "darwin",
          extensions: [dynamicExtension],
        })
        const registryService = Context.get(layerContext, ExtensionRegistry)

        const hookCtx = {
          projection: {
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            agent: getBuiltinAgent("cowork")!,
            agentName: AgentName.make("cowork"),
            allTools: [],
          },
          host: testExtensionHostContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            cwd: "/tmp",
            home: "/tmp",
          }),
        }
        const result = yield* registryService
          .getResolved()
          .extensionHooks.resolveTurnProjection(hookCtx.projection)
          .pipe(
            Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
            Effect.provideContext(layerContext),
          )

        expect(result.promptSections).toContainEqual({
          id: "rp-dynamic-section",
          priority: 60,
          content: "dynamic-from-service",
        })
      }),
    ).pipe(Effect.provide(sharedLayer)))
})
