import { describe, it, expect } from "effect-bun-test"
import { Context, Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { Storage } from "../../src/storage/sqlite-storage"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { Receptionist } from "../../src/runtime/extensions/receptionist"

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
        ExtensionRuntime.fromExtensions([]).pipe(
          Layer.provide(ExtensionTurnControl.Live),
          Layer.provideMerge(ActorEngine.Live),
        ),
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
      extensionRuntime: Context.get(layerContext, ExtensionRuntime),
      actorEngine: Context.get(layerContext, ActorEngine),
      receptionist: Context.get(layerContext, Receptionist),
      baseSections: [],
      instructions: "",
    }
  })

describe("SessionProfileCache", () => {
  it.scopedLive("returns an initial launch profile instead of rebuilding that cwd", () => {
    const launch = mkdtempSync(join(tmpdir(), "gent-session-profile-initial-"))
    const home = mkdtempSync(join(tmpdir(), "gent-session-profile-initial-home-"))
    const runtimePlatformLive = RuntimePlatform.Live({
      cwd: launch,
      home,
      platform: "darwin",
    })
    const configServiceLive = ConfigService.Live.pipe(
      Layer.provide(Layer.merge(BunServices.layer, runtimePlatformLive)),
    )

    return Effect.scoped(
      Effect.gen(function* () {
        const initialProfile = yield* makeEmptyProfile(launch)
        const sessionProfileCacheLive = SessionProfileCache.Live({
          home,
          platform: "darwin",
          extensions: [],
          initialProfiles: [initialProfile],
        }).pipe(
          Layer.provide(
            Layer.mergeAll(BunServices.layer, configServiceLive, Storage.MemoryWithSql()),
          ),
        )
        const resolvedProfile = yield* Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          return yield* cache.resolve(join(launch, "."))
        }).pipe(Effect.provide(sessionProfileCacheLive))

        expect(resolvedProfile).toBe(initialProfile)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            rmSync(launch, { recursive: true, force: true })
            rmSync(home, { recursive: true, force: true })
          }),
        ),
      ),
    )
  })

  it.scopedLive(
    "keeps permission rules scoped to the session cwd instead of the launch cwd",
    () => {
      const launch = mkdtempSync(join(tmpdir(), "gent-session-profile-launch-"))
      const secondary = mkdtempSync(join(tmpdir(), "gent-session-profile-secondary-"))
      const home = mkdtempSync(join(tmpdir(), "gent-session-profile-home-"))

      const writeProjectConfig = (
        cwd: string,
        permissions: ReadonlyArray<Record<string, string>>,
      ) => {
        mkdirSync(join(cwd, ".gent"), { recursive: true })
        writeFileSync(join(cwd, ".gent", "config.json"), JSON.stringify({ permissions }))
      }

      writeProjectConfig(launch, [{ tool: "bash", action: "deny" }])
      writeProjectConfig(secondary, [])

      const runtimePlatformLive = RuntimePlatform.Live({
        cwd: launch,
        home,
        platform: "darwin",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimePlatformLive)),
      )
      const sessionProfileCacheLive = SessionProfileCache.Live({
        home,
        platform: "darwin",
        extensions: [],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(BunServices.layer, configServiceLive, Storage.MemoryWithSql()),
        ),
      )

      return Effect.scoped(
        Effect.gen(function* () {
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
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(launch, { recursive: true, force: true })
              rmSync(secondary, { recursive: true, force: true })
              rmSync(home, { recursive: true, force: true })
            }),
          ),
        ),
      ).pipe(Effect.provide(sessionProfileCacheLive))
    },
  )
})
