import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "@gent/core/runtime/gent-platform-bun"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const makeEmptyProfile = (cwd: string) =>
  Effect.gen(function* () {
    const resolved = resolveExtensions([])
    const layerContext = yield* Layer.build(
      Layer.mergeAll(
        ExtensionRegistry.fromResolved(resolved),
        DriverRegistry.fromResolved({
          modelDrivers: resolved.modelDrivers,
          externalDrivers: resolved.externalDrivers,
        }),
      ),
    )
    return {
      cwd,
      extensions: [],
      resolved,
      layerContext,
      permissionService: {
        check: () => Effect.succeed("allowed" as const),
        addRule: () => Effect.void,
        removeRule: () => Effect.void,
        getRules: () => Effect.succeed([]),
      },
      registryService: Context.get(layerContext, ExtensionRegistry),
      driverRegistryService: Context.get(layerContext, DriverRegistry),
      baseSections: [],
      instructions: "",
    }
  })

describe("SessionProfileCache", () => {
  it.scopedLive("returns an initial launch profile instead of rebuilding that cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: launch,
        home,
        platform: "darwin",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const initialProfile = yield* makeEmptyProfile(launch)
      const sessionProfileCacheLive = SessionProfileCache.Live({
        home,
        platform: "darwin",
        extensions: [],
        initialProfiles: [initialProfile],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(BunServices.layer, configServiceLive, SqliteStorage.MemoryWithSql()),
        ),
      )
      const resolvedProfile = yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        return yield* cache.resolve(path.join(launch, "."))
      }).pipe(Effect.provide(sessionProfileCacheLive))

      expect(resolvedProfile).toBe(initialProfile)
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

      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: launch,
        home,
        platform: "darwin",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const sessionProfileCacheLive = SessionProfileCache.Live({
        home,
        platform: "darwin",
        extensions: [],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(BunServices.layer, configServiceLive, SqliteStorage.MemoryWithSql()),
        ),
      )

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
      }).pipe(Effect.provide(sessionProfileCacheLive))
    }).pipe(Effect.provide(BunPlatformLive)),
  )
})
