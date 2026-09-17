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
  })

  describe("trustedProjects", () => {
    const trustedProjects = ["/trusted/project"]

    /** Trust is user-owned and hand-edited; a driver write must leave it alone. */
    const checkTrustPreservation = Effect.gen(function* () {
      const cfg = yield* ConfigService
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
      yield* cfg.setDriverOverride(
        AgentName.make("cowork"),
        ExternalDriverRef.make({ id: "acp-claude-code" }),
      )
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
      yield* cfg.clearDriverOverride(AgentName.make("cowork"))
      expect((yield* cfg.get()).trustedProjects).toEqual(trustedProjects)
    })

    it.live("in-memory driver writes preserve user trust", () =>
      checkTrustPreservation.pipe(
        Effect.provide(ConfigService.Test(new UserConfig({ trustedProjects }))),
      ),
    )

    it.scopedLive("only user config grants trust and live updates preserve it on disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfigPath = path.join(cwd, ConfigService.PROJECT_CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        // The project asks for its own trust; only the user config may grant it.
        yield* fs.writeFileString(projectConfigPath, encodeJson({ trustedProjects: [cwd] }))
        const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home, platform: "darwin" })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).trustedProjects).toBeUndefined()
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toBeUndefined()
          // Trust arrives the way it really does: the user edits the file.
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects }))
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toEqual(trustedProjects)
          yield* checkTrustPreservation
          expect((yield* cfg.getFresh(cwd)).trustedProjects).toEqual(trustedProjects)
          const persistedText = yield* fs.readFileString(userConfigPath)
          const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
            persistedText,
          )
          // The driver write rewrote the file and kept the hand-edited trust.
          expect(persisted.trustedProjects).toEqual(trustedProjects)
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

    it.live("a later write preserves previously stored disabledExtensions", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        const result = yield* cfg.get()
        expect(result.disabledExtensions).toEqual(["@gent/todo"])
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeDefined()
      }).pipe(
        Effect.provide(ConfigService.Test(new UserConfig({ disabledExtensions: ["@gent/todo"] }))),
      ),
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
        expect(cowork._tag).toBe("External")
        expect(cowork.id).toBe("acp-claude-code")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    // A config written before the PascalCase variant rename holds
    // `{"_tag":"external"}`. `readConfigOrEmpty` turns ANY decode failure into
    // an empty config, and the next `set()` encodes that empty config over the
    // user's file — so a rejected tag silently destroys unrelated settings.
    it.scopedLive("a config written with the pre-rename lowercase driver tag still loads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        // Written by hand, exactly as a pre-rename gent left it on disk.
        yield* fs.writeFileString(
          userConfigPath,
          '{"driverOverrides":{"cowork":{"_tag":"external","id":"acp-claude-code"}},"disabledExtensions":["@gent/skills"]}',
        )
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home, platform: "darwin" })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get()
          const cowork = result.driverOverrides?.[AgentName.make("cowork")]
          if (Predicate.isUndefined(cowork))
            return yield* Effect.die(new Error("expected cowork override"))
          expect(cowork._tag).toBe("External")
          expect(cowork.id).toBe("acp-claude-code")
          // The sibling setting must survive: a dropped config takes it too.
          expect(result.disabledExtensions).toEqual(["@gent/skills"])
          // Re-encoding writes only the new spelling back.
          yield* cfg.setDriverOverride(
            AgentName.make("helper"),
            ModelDriverRef.make({ id: "anthropic" }),
          )
          const persisted = yield* fs.readFileString(userConfigPath)
          expect(persisted).toContain('"External"')
          expect(persisted).not.toContain('"external"')
          expect(persisted).toContain("@gent/skills")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // `readConfigOrEmpty` maps ANY decode failure to an empty config, and the
    // next `set()` encodes that empty config over the file. A malformed user
    // config must therefore not be silently replaced — the bytes stay put and
    // the mutation refuses.
    it.scopedLive("a malformed user config is never overwritten by a later write", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        // Valid JSON, invalid against the schema: `disabledExtensions` must be
        // an array of strings. Everything else here is a real user setting.
        const original =
          '{"disabledExtensions":42,"trustedProjects":["/keep/me"],"agents":{"main":{"reasoningEffort":"high"}}}'
        yield* fs.writeFileString(userConfigPath, original)
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home, platform: "darwin" })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          // A mutation must not succeed against a config that never loaded.
          const outcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), ModelDriverRef.make({ id: "anthropic" })),
          )
          expect(outcome._tag).toBe("Failure")
          // The user's settings are still on disk, byte for byte.
          const after = yield* fs.readFileString(userConfigPath)
          expect(after).toEqual(original)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
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
        expect(result.driverOverrides?.[AgentName.make("cowork")]?._tag).toBe("Model")
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

    it.live("another agent's override leaves the first one alone", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("helper"),
          ModelDriverRef.make({ id: "anthropic" }),
        )
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeDefined()
        expect(result.driverOverrides?.[AgentName.make("helper")]).toBeDefined()
        // The hand-edited sibling setting is still there.
        expect(result.disabledExtensions).toEqual(["@gent/todo"])
      }).pipe(
        Effect.provide(ConfigService.Test(new UserConfig({ disabledExtensions: ["@gent/todo"] }))),
      ),
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

    it.live("a write that does not name agents keeps the stored ones", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          ExternalDriverRef.make({ id: "acp-claude-code" }),
        )
        const result = yield* cfg.get()
        expect(result.agents?.[AgentName.make("main")]).toEqual({ reasoningEffort: "high" })
        expect(result.disabledExtensions).toEqual(["@gent/skills"])
      }).pipe(
        Effect.provide(
          ConfigService.Test(
            new UserConfig({
              agents: { [AgentName.make("main")]: { reasoningEffort: "high" } },
              disabledExtensions: ["@gent/skills"],
            }),
          ),
        ),
      ),
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
            driverOverrides: { [agent]: { _tag: "External", id: driverId } },
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
      if (override._tag !== "External") {
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
