import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { Storage } from "../../src/storage/sqlite-storage"

describe("SessionProfileCache", () => {
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
