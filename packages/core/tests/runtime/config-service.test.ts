/**
 * ConfigService tests - permission persistence and first-run setup
 */

import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { PermissionRule } from "@gent/core/domain/permission"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "@gent/core/domain/agent"
import { ConfigService, UserConfig } from "../../src/runtime/config-service"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("ConfigService", () => {
  describe("Test implementation", () => {
    it.live("seeded initial config reads back unchanged", () => {
      const initial = new UserConfig({
        permissions: [new PermissionRule({ tool: "Bash", action: "deny" })],
      })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.permissions?.length).toBe(1)
            expect(result.permissions?.[0]?.tool).toBe("Bash")
          }),
        ),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("written permission rule is visible on next read", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ permissions: [new PermissionRule({ tool: "Read", action: "allow" })] })
        const result = yield* cfg.get()
        expect(result.permissions?.length).toBe(1)
        expect(result.permissions?.[0]?.tool).toBe("Read")
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("Permission rules", () => {
    it.live("seeded permission rules are exposed verbatim", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      return ConfigService.use((cfg) => cfg.getPermissionRules()).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.length).toBe(2))),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("appended permission rule appears on next read", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Add rule
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))

        // Verify
        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.tool).toBe("Bash")
        expect(result[0]?.action).toBe("deny")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("repeated appends accumulate rules in order", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService

        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Read", action: "allow" }))
        yield* cfg.addPermissionRule(
          new PermissionRule({ tool: "Write", pattern: "/etc", action: "deny" }),
        )

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(3)
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.scopedLive("concurrent live appends preserve every user rule", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const tools = Array.from({ length: 24 }, (_, index) => `ConcurrentTool${index}`)
        const allRulesWriteStarted = yield* Deferred.make<void>()
        const observedConfigWrites = yield* Ref.make(0)
        const delayedFsLayer = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFs = yield* FileSystem.FileSystem
            return FileSystem.makeNoop({
              ...realFs,
              writeFileString: (filePath, content, options) =>
                Effect.gen(function* () {
                  if (filePath === path.join(home, ConfigService.USER_CONFIG_RELATIVE)) {
                    yield* Ref.update(observedConfigWrites, (count) => count + 1)
                    const decoded = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(UserConfig),
                    )(content).pipe(Effect.catchEager(() => Effect.succeed(new UserConfig({}))))
                    const count = decoded.permissions?.length ?? 0
                    if (count === tools.length) {
                      yield* Deferred.succeed(allRulesWriteStarted, undefined).pipe(
                        Effect.catchEager(() => Effect.void),
                      )
                    }
                    if (count === 1) {
                      yield* Deferred.await(allRulesWriteStarted).pipe(
                        Effect.timeoutOption("50 millis"),
                      )
                    }
                  }
                  yield* realFs.writeFileString(filePath, content, options)
                }),
            })
          }),
        ).pipe(Layer.provide(BunServices.layer))
        const platformLayer = Layer.mergeAll(
          delayedFsLayer,
          Path.layer,
          RuntimePlatform.Live({ cwd, home, platform: "darwin" }),
        )
        const live = ConfigService.Live.pipe(Layer.provide(platformLayer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* Effect.all(
            tools.map((tool) =>
              cfg.addPermissionRule(new PermissionRule({ tool, action: "allow" })),
            ),
            { concurrency: "unbounded" },
          )
          const result = yield* cfg.getPermissionRules()
          expect(result.map((rule) => rule.tool).sort()).toEqual([...tools].sort())
          expect(yield* Ref.get(observedConfigWrites)).toBeGreaterThan(0)
          const persistedText = yield* fs.readFileString(
            path.join(home, ConfigService.USER_CONFIG_RELATIVE),
          )
          const persisted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(UserConfig))(
            persistedText,
          )
          expect(persisted.permissions?.map((rule) => rule.tool).sort()).toEqual([...tools].sort())
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("removing a rule by tool drops the matching entry", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", action: "deny" }),
          new PermissionRule({ tool: "Read", action: "allow" }),
        ],
      })
      return Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Remove Bash rule
        yield* cfg.removePermissionRule("Bash", undefined)

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.tool).toBe("Read")
      }).pipe(Effect.provide(ConfigService.Test(initial)))
    })

    it.live("pattern-scoped removal leaves the unpatterned rule intact", () => {
      const initial = new UserConfig({
        permissions: [
          new PermissionRule({ tool: "Bash", pattern: "rm", action: "deny" }),
          new PermissionRule({ tool: "Bash", action: "allow" }),
        ],
      })
      return Effect.gen(function* () {
        const cfg = yield* ConfigService

        // Remove only the pattern-specific rule
        yield* cfg.removePermissionRule("Bash", "rm")

        const result = yield* cfg.getPermissionRules()
        expect(result.length).toBe(1)
        expect(result[0]?.pattern).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test(initial)))
    })

    it.live("removing a missing rule is a no-op", () =>
      ConfigService.use((cfg) => cfg.removePermissionRule("NonExistent", undefined)).pipe(
        Effect.provide(ConfigService.Test()),
      ),
    )
  })

  describe("disabledExtensions", () => {
    it.live("seeded disabledExtensions read back unchanged", () => {
      const initial = new UserConfig({
        disabledExtensions: ["@gent/task-tools", "@gent/auto"],
      })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.disabledExtensions?.length).toBe(2)
            expect(result.disabledExtensions).toContain("@gent/task-tools")
            expect(result.disabledExtensions).toContain("@gent/auto")
          }),
        ),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("written disabledExtensions appear on next read", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/memory"] })
        const result = yield* cfg.get()
        expect(result.disabledExtensions?.length).toBe(1)
        expect(result.disabledExtensions?.[0]).toBe("@gent/memory")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("permission updates preserve previously stored disabledExtensions", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/task-tools"] })
        yield* cfg.set({
          permissions: [new PermissionRule({ tool: "Bash", action: "deny" })],
        })
        const result = yield* cfg.get()
        expect(result.disabledExtensions?.length).toBe(1)
        expect(result.disabledExtensions?.[0]).toBe("@gent/task-tools")
        expect(result.permissions?.length).toBe(1)
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("driverOverrides", () => {
    it.live("a single agent's driver override is persisted", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        const driver = ExternalDriverRef.make({ id: "acp-claude-code" })
        yield* cfg.setDriverOverride(AgentName.make("cowork"), driver)
        const result = yield* cfg.get()
        const cowork = result.driverOverrides?.[AgentName.make("cowork")]
        if (cowork === undefined) throw new Error("expected cowork override")
        expect(cowork._tag).toBe("external")
        expect((cowork as ExternalDriverRef).id).toBe("acp-claude-code")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("re-setting an agent's driver replaces the prior override", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ModelDriverRef.make({ id: "anthropic" }),
        )
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]?._tag).toBe("model")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("setting one agent's driver leaves other agents' overrides intact", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("deepwork"),
          ExternalDriverRef.make({ id: "acp-opencode" }),
        )
        const result = yield* cfg.get()
        expect(Object.keys(result.driverOverrides ?? {})).toHaveLength(2)
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearing one agent's driver removes only that entry", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("deepwork"),
          ExternalDriverRef.make({ id: "acp-opencode" }),
        )
        yield* cfg.clearDriverOverride(AgentName.make("cowork"))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeUndefined()
        expect(result.driverOverrides?.[AgentName.make("deepwork")]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearing the last driver override drops the record entirely", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.clearDriverOverride(AgentName.make("cowork"))
        const result = yield* cfg.get()
        expect(result.driverOverrides).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("clearing an unknown agent's driver is a no-op", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.clearDriverOverride(AgentName.make("does-not-exist"))
        const result = yield* cfg.get()
        expect(result.driverOverrides).toBeUndefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("appending a permission rule preserves driverOverrides", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("removing a permission rule preserves driverOverrides", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.addPermissionRule(new PermissionRule({ tool: "Bash", action: "deny" }))
        yield* cfg.removePermissionRule("Bash", undefined)
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("per-session project config resolution", () => {
    const makeLive = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const projectA = yield* fs.makeTempDirectoryScoped()
      const projectB = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()

      const writeProjectConfig = (cwd: string, agent: string, driverId: string) =>
        Effect.gen(function* () {
          const configDir = path.join(cwd, ".gent")
          const configText = encodeJson({
            driverOverrides: { [agent]: { _tag: "external", id: driverId } },
          })
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(path.join(configDir, "config.json"), configText)
        })

      yield* writeProjectConfig(launch, "cowork", "acp-launch-driver")
      yield* writeProjectConfig(projectA, "cowork", "acp-projectA-driver")
      yield* writeProjectConfig(projectB, "cowork", "acp-projectB-driver")

      const live = ConfigService.Live.pipe(
        Layer.provide(RuntimePlatform.Live({ cwd: launch, home, platform: "darwin" })),
        Layer.provide(BunServices.layer),
      )
      return { live, projectA, projectB }
    })

    const expectExternalOverride = (cfg: UserConfig, agent: string, expectedId: string): void => {
      const override = cfg.driverOverrides?.[AgentName.make(agent)]
      if (override === undefined) throw new Error(`expected ${agent} override`)
      if (override._tag !== "external") throw new Error("expected external driver")
      expect(override.id).toBe(expectedId)
    }

    it.scopedLive("launch-cwd reads the launch-cwd project config", () =>
      Effect.gen(function* () {
        const { live } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get()
          expectExternalOverride(result, "cowork", "acp-launch-driver")
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a project cwd resolves its own .gent/config.json, not the launch cwd's", () =>
      Effect.gen(function* () {
        const { live, projectA } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get(projectA)
          expectExternalOverride(result, "cowork", "acp-projectA-driver")
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("two project cwds resolve independently — no cross-contamination", () =>
      Effect.gen(function* () {
        const { live, projectA, projectB } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const a = yield* cfg.get(projectA)
          const b = yield* cfg.get(projectB)
          expectExternalOverride(a, "cowork", "acp-projectA-driver")
          expectExternalOverride(b, "cowork", "acp-projectB-driver")
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("an unknown cwd falls back to user-only config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { live } = yield* makeLive
        const empty = yield* fs.makeTempDirectoryScoped()
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get(empty)
          expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeUndefined()
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })
})
