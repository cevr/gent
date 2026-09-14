/**
 * ConfigService tests - config persistence and first-run setup
 */

import { describe, it, expect } from "effect-bun-test"
import { Predicate, Deferred, Effect, FileSystem, Layer, Path, Ref, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AgentName, ExternalDriverRef, ModelDriverRef } from "../../src/domain/agent"
import { ModelId } from "../../src/domain/model"
import { ConfigService, UserConfig } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("user configuration", () => {
  describe("in-memory reads and writes", () => {
    it.live("seeded initial config reads back unchanged", () => {
      const initial = new UserConfig({ disabledExtensions: ["@gent/todo"] })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.disabledExtensions).toEqual(["@gent/todo"])
          }),
        ),
        Effect.provide(ConfigService.Test(initial)),
      )
    })

    it.live("a written field is visible on next read", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/todo"] })
        const result = yield* cfg.get()
        expect(result.disabledExtensions).toEqual(["@gent/todo"])
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("trustedProjects", () => {
    const checkTrustPreservation = Effect.gen(function* () {
      const cfg = yield* ConfigService
      const trustedProjects = ["/trusted/project"]
      yield* cfg.set({ trustedProjects })
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
      yield* cfg.set({ disabledExtensions: ["@gent/todo"] })
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
      yield* cfg.setDriverOverride(
        AgentName.make("cowork"),
        ExternalDriverRef.make({ id: "acp-claude-code" }),
      )
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
      yield* cfg.clearDriverOverride(AgentName.make("cowork"))
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
    })

    it.live("in-memory updates preserve user trust and allow its removal", () =>
      Effect.gen(function* () {
        yield* checkTrustPreservation
        const cfg = yield* ConfigService
        yield* cfg.set({ trustedProjects: [] })
        expect((yield* cfg.get()).trustedProjects).toEqual([])
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.scopedLive("only user config grants trust and live updates preserve it on disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfigPath = path.join(cwd, ConfigService.PROJECT_CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        yield* fs.writeFileString(projectConfigPath, encodeJson({ trustedProjects: [cwd] }))
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home, platform: "darwin" })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).trustedProjects).toBeUndefined()
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toBeUndefined()
          yield* checkTrustPreservation
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toEqual(["/trusted/project"])
          const persistedText = yield* fs.readFileString(
            path.join(home, ConfigService.USER_CONFIG_RELATIVE),
          )
          const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
            persistedText,
          )
          expect(persisted.trustedProjects).toEqual(["/trusted/project"])
          yield* cfg.set({ trustedProjects: [] })
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toEqual([])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })

  describe("concurrent writes", () => {
    it.scopedLive("concurrent live writes preserve every user entry", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const agents = Array.from({ length: 24 }, (_, index) =>
          AgentName.make(`concurrent-agent-${index}`),
        )
        const allEntriesWriteStarted = yield* Deferred.make<void>()
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
                    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
                      content,
                    ).pipe(Effect.catchEager(() => Effect.succeed(new UserConfig({}))))
                    const count = Object.keys(decoded.driverOverrides ?? {}).length
                    if (count === agents.length) {
                      // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
                      yield* Deferred.succeed(allEntriesWriteStarted, undefined).pipe(
                        Effect.catchEager(() => Effect.void),
                      )
                    }
                    if (count === 1) {
                      yield* Deferred.await(allEntriesWriteStarted).pipe(
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
          RuntimeEnvironment.Live({ cwd, home, platform: "darwin" }),
        )
        const live = ConfigService.Live.pipe(Layer.provide(platformLayer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* Effect.forEach(
            agents,
            (agent) => cfg.setDriverOverride(agent, ModelDriverRef.make({ id: "anthropic" })),
            { concurrency: 16 },
          )
          const result = Object.keys((yield* cfg.get()).driverOverrides ?? {})
          expect(result.sort()).toEqual([...agents].sort())
          expect(yield* Ref.get(observedConfigWrites)).toBeGreaterThan(0)
          const persistedText = yield* fs.readFileString(
            path.join(home, ConfigService.USER_CONFIG_RELATIVE),
          )
          const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
            persistedText,
          )
          expect(Object.keys(persisted.driverOverrides ?? {}).sort()).toEqual([...agents].sort())
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })

  describe("disabledExtensions", () => {
    it.live("seeded disabledExtensions read back unchanged", () => {
      const initial = new UserConfig({
        disabledExtensions: ["@gent/todo", "@gent/auto"],
      })
      return ConfigService.use((cfg) => cfg.get()).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.disabledExtensions?.length).toBe(2)
            expect(result.disabledExtensions).toContain("@gent/todo")
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

    it.live("a later update preserves previously stored disabledExtensions", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ disabledExtensions: ["@gent/todo"] })
        yield* cfg.set({ trustedProjects: ["/trusted/project"] })
        const result = yield* cfg.get()
        expect(result.disabledExtensions?.length).toBe(1)
        expect(result.disabledExtensions?.[0]).toBe("@gent/todo")
        expect(result.trustedProjects).toEqual(["/trusted/project"])
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
        if (Predicate.isUndefined(cowork))
          return yield* Effect.die(new Error("expected cowork override"))
        expect(cowork._tag).toBe("external")
        expect(cowork.id).toBe("acp-claude-code")
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

    it.live("an unrelated update preserves driverOverrides", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.set({ disabledExtensions: ["@gent/todo"] })
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeDefined()
      }).pipe(Effect.provide(ConfigService.Test())),
    )
  })

  describe("agents", () => {
    it.scopedLive("project agent overrides shadow user overrides key by key", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const project = yield* fs.makeTempDirectoryScoped()
        const write = (root: string, agents: UserConfig["agents"]) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.join(root, ".gent"), { recursive: true })
            yield* fs.writeFileString(
              path.join(root, ".gent", "config.json"),
              encodeJson({ agents }),
            )
          })
        yield* write(home, {
          [AgentName.make("main")]: {
            modelId: ModelId.make("anthropic/claude-sonnet-5"),
            reasoningEffort: "low",
          },
          [AgentName.make("helper")]: { reasoningEffort: "minimal" },
        })
        yield* write(project, {
          [AgentName.make("main")]: { modelId: ModelId.make("openai/gpt-5.6-sol") },
        })
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd: project, home, platform: "darwin" })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get(project)
          // The project entry replaces the user entry for `main` as a whole.
          expect(result.agents?.[AgentName.make("main")]).toEqual({
            modelId: ModelId.make("openai/gpt-5.6-sol"),
          })
          expect(result.agents?.[AgentName.make("helper")]).toEqual({ reasoningEffort: "minimal" })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("a partial update without the field keeps the stored agents", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.set({ agents: { [AgentName.make("main")]: { reasoningEffort: "high" } } })
        yield* cfg.set({ disabledExtensions: ["@gent/skills"] })
        const result = yield* cfg.get()
        expect(result.agents?.[AgentName.make("main")]).toEqual({ reasoningEffort: "high" })
        expect(result.disabledExtensions).toEqual(["@gent/skills"])
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
        Layer.provide(RuntimeEnvironment.Live({ cwd: launch, home, platform: "darwin" })),
        Layer.provide(BunServices.layer),
      )
      return { live, projectA, projectB }
    })

    const expectExternalOverride = (cfg: UserConfig, agent: string, expectedId: string): void => {
      const override = cfg.driverOverrides?.[AgentName.make(agent)]
      if (Predicate.isUndefined(override)) {
        return Effect.runSync(Effect.die(new Error(`expected ${agent} override`)))
      }
      if (override._tag !== "external") {
        return Effect.runSync(Effect.die(new Error("expected external driver")))
      }
      expect(override.id).toBe(expectedId)
    }

    it.scopedLive("launch-cwd reads the launch-cwd project config", () =>
      Effect.gen(function* () {
        const { live } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get()
          expectExternalOverride(result, "cowork", "acp-launch-driver")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })
})
