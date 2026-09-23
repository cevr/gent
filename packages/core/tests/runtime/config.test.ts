import { describe, expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Logger,
  PlatformError,
  Path,
  Predicate,
  Ref,
  References,
  Schema,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  ModelId,
  resolveAgentDriver,
  RunSpecSchema,
} from "../../src/domain/agent"
import { ConfigService, RuntimeEnvironment, UserConfig } from "../../src/runtime/config"
import { test } from "bun:test"

// ── config-service.test ─────────────────────────────────────────────────────

/**
 * ConfigService tests - config persistence and first-run setup
 */

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
        DriverRef.make({ id: "anthropic-proxy" }),
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
        const projectConfigPath = path.join(cwd, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        // The project asks for its own trust; only the user config may grant it.
        yield* fs.writeFileString(projectConfigPath, encodeJson({ trustedProjects: [cwd] }))
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).trustedProjects).toBeUndefined()
          expect((yield* cfg.getFresh(cwd)).config.trustedProjects).toBeUndefined()
          // Trust arrives the way it really does: the user edits the file.
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects }))
          expect((yield* cfg.getFresh(cwd)).config.trustedProjects).toEqual(trustedProjects)
          yield* checkTrustPreservation
          expect((yield* cfg.getFresh(cwd)).config.trustedProjects).toEqual(trustedProjects)
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
            // A config write lands as a rename of a staged sibling over the file.
            return FileSystem.makeNoop({
              ...realFs,
              rename: (fromPath, filePath) =>
                Effect.gen(function* () {
                  if (filePath === path.join(home, ConfigService.CONFIG_RELATIVE)) {
                    yield* Ref.update(observedConfigWrites, (count) => count + 1)
                    const content = yield* realFs.readFileString(fromPath)
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
                  yield* realFs.rename(fromPath, filePath)
                }),
            })
          }),
        ).pipe(Layer.provide(BunServices.layer))
        const platformLayer = Layer.mergeAll(
          delayedFsLayer,
          Path.layer,
          RuntimeEnvironment.Live({ cwd, home }),
        )
        const live = ConfigService.Live.pipe(Layer.provide(platformLayer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* Effect.forEach(
            agents,
            (agent) => cfg.setDriverOverride(agent, DriverRef.make({ id: "anthropic" })),
            { concurrency: 16 },
          )
          const result = Object.keys((yield* cfg.get()).driverOverrides ?? {})
          expect(result.sort()).toEqual([...agents].sort())
          expect(yield* Ref.get(observedConfigWrites)).toBeGreaterThan(0)
          const persistedText = yield* fs.readFileString(
            path.join(home, ConfigService.CONFIG_RELATIVE),
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
          DriverRef.make({ id: "anthropic-proxy" }),
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
        const driver = DriverRef.make({ id: "anthropic-proxy" })
        yield* cfg.setDriverOverride(AgentName.make("cowork"), driver)
        const result = yield* cfg.get()
        const cowork = result.driverOverrides?.[AgentName.make("cowork")]
        if (Predicate.isUndefined(cowork))
          return yield* Effect.die(new Error("expected cowork override"))
        expect(cowork._tag).toBe("Model")
        expect(cowork.id).toBe("anthropic-proxy")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    // A config on disk can hold two retired driver shapes. `readConfigOrEmpty`
    // turns ANY decode failure into an empty config, and the next `set()`
    // encodes that empty config over the user's file — so a rejected shape
    // silently destroys unrelated settings.
    it.scopedLive(
      "a stored external driver override loads as no override and warns once; a lowercase model ref still loads",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const cwd = yield* fs.makeTempDirectoryScoped()
          const home = yield* fs.makeTempDirectoryScoped()
          const otherProject = yield* fs.makeTempDirectoryScoped()
          const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          // Written by hand, exactly as an older gent left it on disk.
          yield* fs.writeFileString(
            userConfigPath,
            '{"driverOverrides":{"cowork":{"_tag":"external","id":"acp-claude-code"},"helper":{"_tag":"External","id":"acp-opencode"},"legacy":{"_tag":"model","id":"anthropic"}},"disabledExtensions":["@gent/skills"]}',
          )
          const projectConfigPath = path.join(otherProject, ConfigService.CONFIG_RELATIVE)
          yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
          yield* fs.writeFileString(
            projectConfigPath,
            '{"driverOverrides":{"main":{"_tag":"External","id":"acp-claude-code"}}}',
          )
          const warnings: Array<string> = []
          const captureLogger = Logger.make(({ message }) => {
            let rendered = String(message)
            if (Array.isArray(message)) rendered = message.map((entry) => String(entry)).join(" ")
            if (rendered.includes("removed external driver")) warnings.push(rendered)
          })
          const live = ConfigService.Live.pipe(
            Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
            Layer.provide(BunServices.layer),
          )
          yield* Effect.gen(function* () {
            const cfg = yield* ConfigService
            const result = yield* cfg.get()
            // A removed driver is no override: the agent uses its default model.
            expect(result.driverOverrides?.[AgentName.make("cowork")]).toBeUndefined()
            expect(result.driverOverrides?.[AgentName.make("helper")]).toBeUndefined()
            expect(result.driverOverrides?.[AgentName.make("legacy")]).toEqual(
              DriverRef.make({ id: "anthropic" }),
            )
            // The sibling setting must survive: a dropped config takes it too.
            expect(result.disabledExtensions).toEqual(["@gent/skills"])
            // A project config is read on every call for its cwd; it warns once.
            const project = yield* cfg.get(otherProject)
            yield* cfg.get(otherProject)
            expect(project.driverOverrides?.[AgentName.make("main")]).toBeUndefined()
            expect(warnings).toHaveLength(2)
            // Re-encoding writes only live refs, in the current spelling.
            yield* cfg.setDriverOverride(
              AgentName.make("helper"),
              DriverRef.make({ id: "anthropic" }),
            )
            const persisted = yield* fs.readFileString(userConfigPath)
            expect(persisted).not.toContain("xternal")
            expect(persisted).not.toContain('"model"')
            expect(persisted).toContain("@gent/skills")
          }).pipe(
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            Effect.provide(
              Layer.provideMerge(
                live,
                // The test preload silences logs; this test reads the warning.
                Layer.merge(
                  Logger.layer([captureLogger]),
                  Layer.succeed(References.MinimumLogLevel, "Warn"),
                ),
              ),
            ),
          )
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
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        // Valid JSON, invalid against the schema: `disabledExtensions` must be
        // an array of strings. Everything else here is a real user setting.
        const original =
          '{"disabledExtensions":42,"trustedProjects":["/keep/me"],"agents":{"main":{"reasoningEffort":"high"}}}'
        yield* fs.writeFileString(userConfigPath, original)
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          // A mutation must not succeed against a config that never loaded.
          const outcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          expect(outcome._tag).toBe("Failure")
          // The user's settings are still on disk, byte for byte.
          const after = yield* fs.readFileString(userConfigPath)
          expect(after).toEqual(original)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a user config broken after startup is never overwritten by a later write", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        yield* fs.writeFileString(userConfigPath, '{"trustedProjects":["/keep/me"]}')
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          // The user edits the file while gent runs and leaves a trailing comma.
          const broken = '{"trustedProjects":["/keep/me", "/new"],}'
          yield* fs.writeFileString(userConfigPath, broken)
          const fresh = yield* cfg.getFresh(cwd)
          expect(fresh.failures.map((failure) => failure.path)).toEqual([userConfigPath])
          // Reads keep the last user config that loaded.
          expect(fresh.config.trustedProjects).toEqual(["/keep/me"])
          const outcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          expect(outcome._tag).toBe("Failure")
          expect(yield* fs.readFileString(userConfigPath)).toEqual(broken)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    /** A live service over `home`, with `fsLayer` in place of the real file system. */
    const liveConfigAt = (
      cwd: string,
      home: string,
      fsLayer: Layer.Layer<FileSystem.FileSystem> = BunServices.layer,
    ) =>
      ConfigService.Live.pipe(
        Layer.provide(Layer.mergeAll(fsLayer, Path.layer, RuntimeEnvironment.Live({ cwd, home }))),
      )

    const decodeUserConfig = Schema.decodeEffect(Schema.fromJsonString(UserConfig))

    it.scopedLive("a write without a fresh read keeps a valid edit made after startup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          // The user grants trust by hand while gent runs; nothing reads it yet.
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects: ["/keep/me"] }))
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          const persisted = yield* decodeUserConfig(yield* fs.readFileString(userConfigPath))
          expect(persisted.trustedProjects).toEqual(["/keep/me"])
          expect(persisted.driverOverrides?.[AgentName.make("main")]).toEqual(
            DriverRef.make({ id: "anthropic" }),
          )
          // The write also refreshes the snapshot reads use.
          expect((yield* cfg.get()).trustedProjects).toEqual(["/keep/me"])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // A newer build (a rift binary) can add a key this build does not know;
    // they share ~/.gent, so a write here must not erase it.
    it.scopedLive("a driver write keeps every key it did not change, known or not", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const readRaw = fs
          .readFileString(userConfigPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(
            userConfigPath,
            encodeJson({
              trustedProjects: ["/x"],
              futureField: { nested: [1, 2] },
              agents: { main: { reasoningEffort: "high", futureOverride: true } },
            }),
          )
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          expect(yield* readRaw).toEqual({
            trustedProjects: ["/x"],
            futureField: { nested: [1, 2] },
            agents: { main: { reasoningEffort: "high", futureOverride: true } },
            driverOverrides: { main: { _tag: "Model", id: "anthropic" } },
          })
          // Clearing the last override removes the key it owns, and only that.
          yield* cfg.clearDriverOverride(AgentName.make("main"))
          expect(yield* readRaw).toEqual({
            trustedProjects: ["/x"],
            futureField: { nested: [1, 2] },
            agents: { main: { reasoningEffort: "high", futureOverride: true } },
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a driver write keeps unknown keys inside the overrides it touches", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const readRaw = fs
          .readFileString(userConfigPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(
            userConfigPath,
            encodeJson({
              driverOverrides: {
                main: { _tag: "Model", id: "openai", futureOption: true },
                helper: { _tag: "Model", id: "openai", futureOption: "kept" },
              },
            }),
          )
          // One override changes; the other does not. Both keep their unknown key.
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          expect(yield* readRaw).toEqual({
            driverOverrides: {
              main: { _tag: "Model", id: "anthropic", futureOption: true },
              helper: { _tag: "Model", id: "openai", futureOption: "kept" },
            },
          })
          // Clearing one override deletes that entry, and only that entry.
          yield* cfg.clearDriverOverride(AgentName.make("main"))
          expect(yield* readRaw).toEqual({
            driverOverrides: { helper: { _tag: "Model", id: "openai", futureOption: "kept" } },
          })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive(
      "a driver write through a symlinked config writes the target and keeps the link",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const cwd = yield* fs.makeTempDirectoryScoped()
          const home = yield* fs.makeTempDirectoryScoped()
          const dotfiles = yield* fs.makeTempDirectoryScoped()
          const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
          const target = path.join(dotfiles, "gent-config.json")
          yield* fs.writeFileString(target, encodeJson({ trustedProjects: ["/x"] }))
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          yield* fs.symlink(target, userConfigPath)
          yield* Effect.gen(function* () {
            const cfg = yield* ConfigService
            yield* cfg.setDriverOverride(
              AgentName.make("main"),
              DriverRef.make({ id: "anthropic" }),
            )
            expect(yield* fs.readLink(userConfigPath)).toBe(target)
            const written = yield* fs
              .readFileString(target)
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
              )
            expect(written).toEqual({
              trustedProjects: ["/x"],
              driverOverrides: { main: { _tag: "Model", id: "anthropic" } },
            })
            // The staged file lands beside the target, then renames over it.
            expect(yield* fs.readDirectory(dotfiles)).toEqual(["gent-config.json"])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(liveConfigAt(cwd, home)))
        }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a write without a fresh read refuses a config broken after startup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const broken = '{"trustedProjects":["/keep/me"],}'
          yield* fs.writeFileString(userConfigPath, broken)
          const setOutcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          expect(setOutcome._tag).toBe("Failure")
          const clearOutcome = yield* Effect.exit(cfg.clearDriverOverride(AgentName.make("main")))
          expect(clearOutcome._tag).toBe("Failure")
          expect(yield* fs.readFileString(userConfigPath)).toEqual(broken)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a user config fixed after a broken start accepts writes at once", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        yield* fs.writeFileString(userConfigPath, '{"trustedProjects":["/keep/me"],}')
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects: ["/keep/me"] }))
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          const persisted = yield* decodeUserConfig(yield* fs.readFileString(userConfigPath))
          expect(persisted.trustedProjects).toEqual(["/keep/me"])
          expect(Object.keys(persisted.driverOverrides ?? {})).toEqual(["main"])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a write that cannot reach the disk fails and leaves the file whole", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const original = encodeJson({ trustedProjects: ["/keep/me"] })
        yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
        yield* fs.writeFileString(userConfigPath, original)
        // Every write fails, the way a full disk or a read-only home does.
        const denied = (method: string, target: string) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method,
              pathOrDescriptor: target,
            }),
          )
        const failingWrites = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFs = yield* FileSystem.FileSystem
            return FileSystem.makeNoop({
              ...realFs,
              writeFileString: (target) => denied("writeFileString", target),
              rename: (_from, target) => denied("rename", target),
            })
          }),
        ).pipe(Layer.provide(BunServices.layer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const outcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          expect(outcome._tag).toBe("Failure")
          expect(yield* fs.readFileString(userConfigPath)).toEqual(original)
          // A failed write leaves the snapshot as it was.
          expect((yield* cfg.get()).driverOverrides).toBeUndefined()
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home, failingWrites)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("an unchanged config file is not read again", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfigPath = path.join(cwd, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        yield* fs.writeFileString(projectConfigPath, encodeJson({ disabledExtensions: ["x"] }))
        const reads = yield* Ref.make<ReadonlyArray<string>>([])
        const countingReads = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFs = yield* FileSystem.FileSystem
            return FileSystem.makeNoop({
              ...realFs,
              readFileString: (target, encoding) =>
                Ref.update(reads, (all) => [...all, target]).pipe(
                  Effect.andThen(realFs.readFileString(target, encoding)),
                ),
            })
          }),
        ).pipe(Layer.provide(BunServices.layer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).disabledExtensions).toEqual(["x"])
          const before = (yield* Ref.get(reads)).length
          expect((yield* cfg.get()).disabledExtensions).toEqual(["x"])
          expect((yield* cfg.get(cwd)).disabledExtensions).toEqual(["x"])
          expect((yield* Ref.get(reads)).length).toBe(before)
          // A changed file is read at once.
          yield* fs.writeFileString(
            projectConfigPath,
            encodeJson({ disabledExtensions: ["y", "z"] }),
          )
          expect((yield* cfg.get()).disabledExtensions).toEqual(["y", "z"])
          expect((yield* Ref.get(reads)).slice(before)).toEqual([projectConfigPath])
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(liveConfigAt(cwd, home, countingReads)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("a launch project config that breaks drops its cached settings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfigPath = path.join(cwd, ConfigService.CONFIG_RELATIVE)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        yield* fs.writeFileString(projectConfigPath, encodeJson({ disabledExtensions: ["x"] }))
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).disabledExtensions).toEqual(["x"])
          yield* fs.writeFileString(projectConfigPath, '{ "disabledExtensions": ["x"], }')
          const fresh = yield* cfg.getFresh(cwd)
          expect(fresh.failures.map((failure) => failure.path)).toEqual([projectConfigPath])
          // The fresh read and the cached launch read agree: the broken file sets nothing.
          expect(fresh.config.disabledExtensions).toBeUndefined()
          expect((yield* cfg.get()).disabledExtensions).toBeUndefined()
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("re-setting an agent's driver replaces the prior override", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(AgentName.make("cowork"), DriverRef.make({ id: "anthropic" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("cowork")]?._tag).toBe("Model")
      }).pipe(Effect.provide(ConfigService.Test())),
    )

    it.live("setting one agent's driver leaves other agents' overrides intact", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("deepwork"),
          DriverRef.make({ id: "openai-proxy" }),
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
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(
          AgentName.make("deepwork"),
          DriverRef.make({ id: "openai-proxy" }),
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
          DriverRef.make({ id: "anthropic-proxy" }),
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
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(AgentName.make("helper"), DriverRef.make({ id: "anthropic" }))
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
          Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
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

    it.scopedLive("a hand edit reaches the next read without a restart", () =>
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
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
          Layer.provide(BunServices.layer),
        )
        const delegate = AgentName.make("delegate")
        const main = AgentName.make("main")
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect((yield* cfg.get()).agents).toBeUndefined()
          // The server is running when the files change, as in a live session.
          yield* write(project, { [delegate]: { maxSteps: 3 } })
          yield* write(home, { [main]: { reasoningEffort: "low" } })
          for (const read of [cfg.get(), cfg.get(project)]) {
            const agents = (yield* read).agents
            expect(agents?.[delegate]).toEqual({ maxSteps: 3 })
            expect(agents?.[main]).toEqual({ reasoningEffort: "low" })
          }
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("a write that does not name agents keeps the stored ones", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("cowork"),
          DriverRef.make({ id: "anthropic-proxy" }),
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
            driverOverrides: { [agent]: { _tag: "Model", id: driverId } },
          })
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(path.join(configDir, "config.json"), configText)
        })

      yield* writeProjectConfig(launch, "cowork", "launch-driver")
      yield* writeProjectConfig(projectA, "cowork", "projectA-driver")
      yield* writeProjectConfig(projectB, "cowork", "projectB-driver")

      const live = ConfigService.Live.pipe(
        Layer.provide(RuntimeEnvironment.Live({ cwd: launch, home })),
        Layer.provide(BunServices.layer),
      )
      return { live, projectA, projectB }
    })

    const expectDriverOverride = (cfg: UserConfig, agent: string, expectedId: string): void => {
      const override = cfg.driverOverrides?.[AgentName.make(agent)]
      if (Predicate.isUndefined(override)) {
        return Effect.runSync(Effect.die(new Error(`expected ${agent} override`)))
      }
      expect(override.id).toBe(expectedId)
    }

    it.scopedLive("launch-cwd reads the launch-cwd project config", () =>
      Effect.gen(function* () {
        const { live } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get()
          expectDriverOverride(result, "cowork", "launch-driver")
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
          expectDriverOverride(result, "cowork", "projectA-driver")
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
          expectDriverOverride(a, "cowork", "projectA-driver")
          expectDriverOverride(b, "cowork", "projectB-driver")
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

// ── driver-override-routing.test ────────────────────────────────────────────

/**
 * Driver override routing — integration test that ConfigService.driverOverrides
 * actually flows into `resolveAgentDriver` at the agent loop's resolution
 * boundary.
 *
 * Drives `ConfigService.Test(...)` with overrides, calls
 * `resolveAgentDriver` directly with the merged config, asserts source +
 * driver. Catches breakage between `ConfigService` and the resolver
 * without spinning up the full agent loop.
 */

const cowork = AgentDefinition.make({ name: AgentName.make("cowork") })
const hardcoded = AgentDefinition.make({
  name: AgentName.make("hardcoded"),
  driver: DriverRef.make({ id: "anthropic-proxy" }),
})

describe("configured driver override routing", () => {
  it.live("agent without hardcoded driver picks up config override (source: config)", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(cowork, driverOverrides)
      expect(result.source).toBe("config")
      expect(result.driver?._tag).toBe("Model")
      expect(result.driver?.id).toBe("anthropic-proxy")
    }).pipe(
      Effect.provide(
        ConfigService.Test(
          new UserConfig({
            driverOverrides: {
              [AgentName.make("cowork")]: DriverRef.make({ id: "anthropic-proxy" }),
            },
          }),
        ),
      ),
    ),
  )

  it.live("hardcoded agent.driver wins over config override (source: agent)", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(hardcoded, driverOverrides)
      expect(result.source).toBe("agent")
      expect(result.driver?.id).toBe("anthropic-proxy")
    }).pipe(
      Effect.provide(
        ConfigService.Test(
          new UserConfig({
            driverOverrides: {
              [AgentName.make("hardcoded")]: DriverRef.make({ id: "anthropic" }),
            },
          }),
        ),
      ),
    ),
  )

  it.live("no override returns source: default", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      const { driverOverrides } = yield* cfg.get()
      const result = resolveAgentDriver(cowork, driverOverrides)
      expect(result.source).toBe("default")
      expect(result.driver).toBeUndefined()
    }).pipe(Effect.provide(ConfigService.Test())),
  )

  it.live("clearing the override falls back to default on the next read", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      yield* cfg.setDriverOverride(
        AgentName.make("cowork"),
        DriverRef.make({ id: "anthropic-proxy" }),
      )
      const before = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, before).source).toBe("config")
      yield* cfg.clearDriverOverride(AgentName.make("cowork"))
      const after = (yield* cfg.get()).driverOverrides
      expect(resolveAgentDriver(cowork, after).source).toBe("default")
    }).pipe(Effect.provide(ConfigService.Test())),
  )
})

// ── execution-overrides.test ────────────────────────────────────────────────

/**
 * The run-spec JSON a session's stored admission carries.
 */

describe("stored run spec", () => {
  const codec = Schema.fromJsonString(RunSpecSchema)

  test("round-trips through JSON encode/decode", () => {
    const runSpec = {
      overrides: {
        modelId: ModelId.make("anthropic/claude-sonnet-4-6"),
        allowedTools: ["grep", "read"],
        deniedTools: ["bash"],
        reasoningEffort: "high",
        systemPromptAddendum: "Be concise.",
      },
    } satisfies Schema.Schema.Type<typeof RunSpecSchema>

    const json = Schema.encodeSync(codec)(runSpec)
    expect(Predicate.isString(json)).toBe(true)

    const decoded = Schema.decodeSync(codec)(json)
    expect(decoded).toEqual(runSpec)
  })

  test("a row that still carries the dropped parentToolCallId decodes", () => {
    const decoded = Schema.decodeSync(codec)(
      '{"overrides":{"maxModelAttempts":32},"parentToolCallId":"tc-old"}',
    )
    expect(decoded).toEqual({ overrides: { maxModelAttempts: 32 } })
  })

  test("round-trips empty runSpec", () => {
    const runSpec = {}
    const json = Schema.encodeSync(codec)(runSpec)
    const decoded = Schema.decodeSync(codec)(json)
    expect(decoded).toEqual({})
  })
})
