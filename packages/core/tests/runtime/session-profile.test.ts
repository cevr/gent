import { describe, it, expect } from "effect-bun-test"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import {
  ExtensionHost,
  defineExtension,
  defineResource,
  type GentExtension,
} from "@gent/core/extensions/api"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { ProcessRunnerLive } from "../../src/utils/run-process"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { ExtensionId } from "../../src/domain/ids"

const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class SessionProfileResourceMarker extends Context.Service<
  SessionProfileResourceMarker,
  { readonly value: string }
>()("@gent/core/tests/runtime/session-profile.test/SessionProfileResourceMarker") {}

class SessionProfileStartProbe extends Context.Service<
  SessionProfileStartProbe,
  { readonly value: string }
>()("@gent/core/tests/runtime/session-profile.test/SessionProfileStartProbe") {}

/** A process resource whose only behavior is its `start` effect. */
const startResource = (id: string, start: Effect.Effect<void>) =>
  defineResource({
    id,
    scope: "process",
    layer: Layer.succeed(SessionProfileStartProbe, SessionProfileStartProbe.of({ value: id })),
    start,
  })

const makeCacheLayer = (params: {
  readonly cwd: string
  readonly home: string
  readonly extensions: ReadonlyArray<GentExtension>
}) => {
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: params.cwd,
    home: params.home,
    platform: "darwin",
  })
  const configServiceLive = ConfigService.Live.pipe(
    Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
  )
  return SessionProfileCache.Live({
    home: params.home,
    platform: "darwin",
    extensions: params.extensions,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        BunServices.layer,
        processRunnerLive,
        configServiceLive,
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
      ),
    ),
  )
}

const markerExtension = (id: string, value: string, stop: Effect.Effect<void> = Effect.void) =>
  defineExtension({
    id,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      yield* host.register(
        "resource",
        defineResource({
          id: `${id}/marker`,
          scope: "process",
          layer: Layer.succeed(
            SessionProfileResourceMarker,
            SessionProfileResourceMarker.of({ value }),
          ),
          stop,
        }),
      )
    }),
  })

describe("session profile resolution", () => {
  it.scopedLive("isolates profiles by workspace and reuses one per key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspaceA = WorkspaceId.make("a".repeat(64))
      const workspaceB = WorkspaceId.make("b".repeat(64))
      const setups = yield* Ref.make(0)
      const counted = defineExtension({
        id: "@gent/test-session-profile/counted",
        setup: Ref.update(setups, (count) => count + 1),
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profileA = yield* cache
          .resolve(path.join(launch, "."))
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
        const profileB = yield* cache
          .resolve(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
        const again = yield* cache
          .resolve(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))

        expect(profileA).not.toBe(profileB)
        expect(again).toBe(profileA)
        expect(profileA.generationId).toBe(profileB.generationId)
        expect(yield* Ref.get(setups)).toBe(2)
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [counted] })),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("keeps permission rules scoped to the session cwd instead of the launch cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const secondary = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()

      const writeProjectConfig = (
        cwd: string,
        permissions: ReadonlyArray<Record<string, string>>,
      ) =>
        Effect.gen(function* () {
          const configDir = path.join(cwd, ".gent")
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(
            path.join(configDir, "config.json"),
            encodeJson({ permissions }),
          )
        })

      yield* writeProjectConfig(launch, [{ tool: "bash", action: "deny" }])
      yield* writeProjectConfig(secondary, [])

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const launchProfile = yield* cache.resolve(launch)
        const secondaryProfile = yield* cache.resolve(secondary)

        const launchPermission = yield* launchProfile.permissionService.check("bash", {
          command: "ls -la",
        })
        const secondaryPermission = yield* secondaryProfile.permissionService.check("bash", {
          command: "ls -la",
        })

        expect(launchPermission).toBe("denied")
        expect(secondaryPermission).toBe("allowed")
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("c".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("suspends only the extension whose process resource fails to start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const healthy = markerExtension("@gent/test-session-profile/healthy", "live")
      const broken = defineExtension({
        id: "@gent/test-session-profile/broken",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            startResource("test/session-profile/broken", Effect.die("boom")),
          )
        }),
      })

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profile = yield* cache.resolve(launch)
        expect(profile.resolved.extensions.map((extension) => extension.manifest.id)).toEqual([
          ExtensionId.make("@gent/test-session-profile/healthy"),
        ])
        expect(profile.resolved.failedExtensions).toMatchObject([
          {
            manifest: { id: ExtensionId.make("@gent/test-session-profile/broken") },
            phase: "startup",
          },
        ])
        expect(Context.get(profile.layerContext, SessionProfileResourceMarker).value).toBe("live")
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [healthy, broken] })),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("e".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("releases a partially built profile when its build is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspace = WorkspaceId.make("1".repeat(64))
      const stopped = yield* Deferred.make<void>()
      const startEntered = yield* Deferred.make<void>()
      const releaseStart = yield* Deferred.make<void>()
      const starts = yield* Ref.make(0)
      // Resources start in id order, so the healthy extension is built before
      // the blocking one enters its start effect.
      const healthy = markerExtension(
        "@gent/test-session-profile/built-first",
        "live",
        Deferred.succeed(stopped, void 0).pipe(Effect.asVoid),
      )
      const blocking = defineExtension({
        id: "@gent/test-session-profile/waiting-start",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            startResource(
              "test/session-profile/waiting-start",
              Effect.gen(function* () {
                yield* Ref.update(starts, (count) => count + 1)
                yield* Deferred.succeed(startEntered, void 0)
                yield* Deferred.await(releaseStart)
              }),
            ),
          )
        }),
      })

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const resolving = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspace), Effect.forkChild)
          yield* Deferred.await(startEntered)
          yield* Fiber.interrupt(resolving)
          expect(Exit.isFailure(yield* Fiber.await(resolving))).toBe(true)
          // The healthy extension's resource was already built and must be released.
          expect(Option.isSome(yield* Deferred.poll(stopped))).toBe(true)

          yield* Deferred.succeed(releaseStart, void 0)
          const profile = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
          expect(yield* Ref.get(starts)).toBe(2)
          expect(profile.resolved.failedExtensions).toEqual([])
          expect(Context.get(profile.layerContext, SessionProfileResourceMarker).value).toBe("live")
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This focused interruption test owns one isolated live cache layer.
          Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [healthy, blocking] })),
        ),
        Deferred.succeed(releaseStart, void 0).pipe(Effect.asVoid),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
})
