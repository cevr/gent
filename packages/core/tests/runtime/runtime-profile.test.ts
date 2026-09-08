import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
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
import { testExtensionHostContext } from "@gent/core-internal/test-utils"
import { ConfigService } from "../../src/runtime/config-service"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import {
  buildExtensionLayers,
  loadRuntimeProfileDeclarations,
  type RuntimeProfileInputs,
} from "../../src/runtime/profile"
import { CurrentExtensionHostContext } from "../../src/runtime/agent/current-extension-host-context"
import { ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { CronRuntime } from "../../src/runtime/extensions/resource-host/schedule-engine"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ProcessRunnerLive } from "../../src/utils/run-process"

const childProcessSpawnerLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, Path.layer)),
)

const fsLayer = Layer.provideMerge(
  Layer.mergeAll(BunFileSystem.layer, Path.layer, ProcessRunnerLive, BunGentPlatformLive),
  childProcessSpawnerLive,
)

const sharedLayer = Layer.mergeAll(fsLayer, ConfigService.Test(), SqliteStorage.TestWithSql())

// Build a fresh production cache in the test's owning scope.
const openProfile = Effect.fn("RuntimeProfileTest.openProfile")(function* (
  inputs: RuntimeProfileInputs,
) {
  const context = yield* Layer.build(SessionProfileCache.Live(inputs))
  const cache = Context.get(context, SessionProfileCache)
  const profile = yield* cache.resolve(inputs.cwd)
  if (!profile.publication) return yield* Effect.die("Live profile has no publication")
  return { ...profile.publication.value, publication: profile.publication }
})

// Static prompt sections live on capability leaf `prompt`. The tool here is a
// no-op carrier — its only purpose is to bring the prompt section into scope.
const sectionTool = tool({
  id: "rp-test-tool",
  description: "carrier for rp-test-section",
  params: S.Struct({}),
  output: S.String,
  prompt: { id: "rp-test-section", content: "rp test content", priority: 50 },
  execute: () => Effect.succeed("ok"),
})

const sectionExtension = defineExtension({
  id: "@gent/test-runtime-profile",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", sectionTool)
  }),
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
        tag: FakeProvider,
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

  test("loads declarations without lifecycle or scheduler work before boot activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        let nextInstance = 0
        let schedulerInstalls = 0
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
                start: Effect.gen(function* () {
                  const probe = yield* ScopedProbe
                  events.push(["start", probe.instance])
                }),
                stop: Effect.gen(function* () {
                  const probe = yield* ScopedProbe
                  events.push(["stop", probe.instance])
                }),
              }) as never,
            )
            yield* host.register("job", {
              id: "declaration-resource",
              cron: "0 21 * * 1-5",
              target: {
                agent: AgentName.make("cowork"),
                prompt: "Check declaration loading.",
              },
            })
            yield* host.register(
              "tool",
              tool({
                id: "rp-declaration-prompt",
                description: "declaration prompt fixture",
                params: S.Struct({}),
                output: S.String,
                prompt: {
                  id: "rp-declaration-prompt-section",
                  content: "loaded during declaration setup",
                  priority: 1,
                },
                execute: () => Effect.succeed("ok"),
              }),
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
          scheduledJobCommand: ["/usr/local/bin/gent"] satisfies readonly [
            string,
            ...ReadonlyArray<string>,
          ],
        }
        const schedulerLayer = Layer.succeed(
          CronRuntime,
          CronRuntime.of({
            install: () =>
              Effect.sync(() => {
                schedulerInstalls += 1
              }),
            remove: () => Effect.void,
          }),
        )

        const declarations = yield* loadRuntimeProfileDeclarations(inputs).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This test provides a local scheduler spy for the declaration boundary.
          Effect.provide(schedulerLayer),
        )
        expect(events).toEqual([])
        expect(schedulerInstalls).toBe(0)
        expect(declarations.extensionSectionInputs).toEqual([
          {
            id: "rp-declaration-prompt-section",
            content: "loaded during declaration setup",
            priority: 1,
          },
        ])
        expect(declarations.resolved.failedExtensions).toContainEqual(
          expect.objectContaining({
            manifest: { id: "@gent/test-runtime-profile/declaration-invalid" },
            phase: "validation",
          }),
        )

        const runtimeExit = yield* Effect.exit(
          // oxlint-disable-next-line effect/noInlineProvide -- This test provides a local scheduler spy for the boot boundary.
          Effect.scoped(openProfile(inputs).pipe(Effect.provide(schedulerLayer))),
        )
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
          ["start", 1],
          ["stop", 1],
          ["release", 1],
        ])
        expect(schedulerInstalls).toBe(1)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("live Profile starts process resources once and skips duplicate lifecycle hooks", () =>
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
                layer: Layer.empty,
                start: Effect.sync(() => {
                  starts += 1
                }),
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
              start: Effect.gen(function* () {
                const probe = yield* ScopedProbe
                events.push(["start", probe.instance])
              }),
              stop: Effect.gen(function* () {
                const probe = yield* ScopedProbe
                events.push(["stop", probe.instance])
              }),
            }) as never,
            // oxlint-disable-next-line effect/noAs -- The contribution array intentionally erases a resource's private service and scope types.
            defineResource({
              id: "test/runtime-profile/resource-identity/pure",
              tag: PureProbe,
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
                cwd: "/tmp",
                home: "/tmp",
                turn: {
                  sessionId: SessionId.make("s"),
                  branchId: BranchId.make("b"),
                  agent: getBuiltinAgent("cowork")!,
                  agentName: AgentName.make("cowork"),
                  allTools: [],
                },
              },
              host: testExtensionHostContext({
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                cwd: "/tmp",
                home: "/tmp",
              }),
            }

            const result = yield* runtime.registryService.extensionHooks
              .resolveTurnProjection(hookCtx.projection)
              .pipe(
                Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
                runtime.publication.run,
              )
            expect(result.promptSections).toEqual([
              { id: "pure-probe", priority: 1, content: "pure" },
            ])
            expect(events).toEqual([
              ["acquire", 1],
              ["start", 1],
              ["capability", 1],
            ])
          }),
        ),
      )

      expect(exit._tag).toBe("Success")
      expect(events).toEqual([
        ["acquire", 1],
        ["start", 1],
        ["capability", 1],
        ["stop", 1],
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
                tag: PrecedenceProbe,
                scope: "process",
                layer: Layer.succeed(PrecedenceProbe, {
                  value: "activated",
                } satisfies PrecedenceProbeApi),
                start: Effect.sync(() => {
                  starts += 1
                }),
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
                tag: PrecedenceProbe,
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

          const builderContext = yield* Layer.build(
            buildExtensionLayers(runtime.profile.resolved, {
              lifecycle: "skip",
            }),
          ).pipe(Effect.scoped)
          expect(Context.get(builderContext, PrecedenceProbe).value).toBe(expected)
        }

        expect(starts).toBe(2)
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("buildExtensionLayers wires ExtensionRegistry from resolved data", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { profile } = yield* openProfile({
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

        const sections = [...registryService.getResolved().promptSections.values()]
        const ids = sections.map((s) => s.id)
        expect(ids).toContain("rp-test-section")
      }),
    ).pipe(Effect.provide(sharedLayer)))

  test("resource-backed turnProjection resolves through buildExtensionLayers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { profile } = yield* openProfile({
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

        const hookCtx = {
          projection: {
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            cwd: "/tmp",
            home: "/tmp",
            turn: {
              sessionId: SessionId.make("s"),
              branchId: BranchId.make("b"),
              agent: getBuiltinAgent("cowork")!,
              agentName: AgentName.make("cowork"),
              allTools: [],
            },
          },
          host: testExtensionHostContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            cwd: "/tmp",
            home: "/tmp",
          }),
        }
        const result = yield* registryService.extensionHooks
          .resolveTurnProjection(hookCtx.projection)
          .pipe(
            Effect.provideService(CurrentExtensionHostContext, hookCtx.host),
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            Effect.provide(layer),
          )

        expect(result.promptSections).toContainEqual({
          id: "rp-dynamic-section",
          priority: 60,
          content: "dynamic-from-service",
        })
      }),
    ).pipe(Effect.provide(sharedLayer)))
})
