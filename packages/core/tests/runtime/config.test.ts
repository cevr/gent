import { describe, expect, it } from "effect-bun-test"
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Order,
  PlatformError,
  Path,
  Predicate,
  Ref,
  References,
  Schema,
  Stream,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  AgentDefinition,
  AgentName,
  DriverRef,
  ModelId,
  resolveAgentRoster,
} from "../../src/domain/agent"
import {
  ConfigService,
  isProjectExtensionDirectoryTrusted,
  type ProviderConfig,
  readDisabledExtensions,
  RuntimeEnvironment,
  UserConfig,
} from "../../src/runtime/config"
import { resolveSessionRoute } from "../../src/runtime/turn"
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"
import type { ProviderOptions } from "effect/ai/LanguageModel"
import {
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  type SequenceStep,
  systemTextOf,
  TEST_MODEL_ID,
  waitFor,
} from "../../src/test-utils/harness"
import { textStep } from "../../src/runtime/provider"
import { messagePartsText } from "../../src/domain/message"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"

// ── user configuration ──────────────────────────────────────────────────────

/**
 * ConfigService tests - config persistence and first-run setup
 */

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

describe("user configuration", () => {
  it.live("rejects empty, duplicate and invalid credential orders", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(UserConfig)
      for (const authOrder of [
        [],
        ["personal", "personal"],
        ["UPPER"],
        ["../escape"],
        ["x".repeat(33)],
      ]) {
        expect(Option.isNone(decode({ providers: { anthropic: { authOrder } } }))).toBe(true)
      }
      expect(
        Option.isSome(decode({ providers: { anthropic: { authOrder: ["default", "personal"] } } })),
      ).toBe(true)
    }),
  )
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
    it.scopedLive("only user config grants trust and driver writes preserve it on disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const projectConfigPath = path.join(cwd, ConfigService.CONFIG_RELATIVE)
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const directories = {
          userDir: path.join(path.dirname(userConfigPath), "extensions"),
          projectDir: path.join(path.dirname(projectConfigPath), "extensions"),
        }
        const projectRoot = yield* fs.realPath(cwd)
        yield* fs.makeDirectory(path.dirname(projectConfigPath), { recursive: true })
        // The project asks for its own trust; only the user config may grant it.
        yield* fs.writeFileString(projectConfigPath, encodeJson({ trustedProjects: [projectRoot] }))
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          expect(yield* isProjectExtensionDirectoryTrusted(directories)).toBe(false)
          // Trust arrives the way it really does: the user edits the file.
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects: [projectRoot] }))
          expect(yield* isProjectExtensionDirectoryTrusted(directories)).toBe(true)
          // Trust is user-owned and hand-edited; a driver write must leave it alone.
          yield* cfg.setDriverOverride(
            AgentName.make("primary"),
            DriverRef.make({ id: "anthropic-proxy" }),
          )
          expect(yield* isProjectExtensionDirectoryTrusted(directories)).toBe(true)
          yield* cfg.clearDriverOverride(AgentName.make("primary"))
          expect(yield* isProjectExtensionDirectoryTrusted(directories)).toBe(true)
          const persisted = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
            yield* fs.readFileString(userConfigPath),
          )
          // The driver writes rewrote the file and kept the hand-edited trust.
          expect(persisted.trustedProjects).toEqual([projectRoot])
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })

  describe("concurrent writes", () => {
    it.scopedLive("first-run setup preserves a config created before its default write", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const createdConfig = encodeJson({
          trustedProjects: ["/owner/project"],
          disabledExtensions: ["@owner/disabled"],
          ownerSetting: "keep verbatim",
        })
        const firstWrite = yield* Ref.make(true)
        const competingCreator = FileSystem.makeNoop({
          ...fs,
          writeFileString: (filePath, content, options) =>
            Effect.gen(function* () {
              if (filePath === userConfigPath && (yield* Ref.getAndSet(firstWrite, false))) {
                // A separate real writer wins after the initializer saw no file.
                yield* fs.writeFileString(userConfigPath, createdConfig)
              }
              yield* fs.writeFileString(filePath, content, options)
            }),
        })
        const live = ConfigService.Live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, competingCreator),
              Path.layer,
              RuntimeEnvironment.Live({ cwd, home }),
            ),
          ),
        )
        const loaded = yield* ConfigService.use((cfg) => cfg.get()).pipe(Effect.provide(live))
        expect(loaded.disabledExtensions).toEqual(["@owner/disabled"])
        expect(yield* fs.readFileString(userConfigPath)).toBe(createdConfig)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("5 seconds")),
    )

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
                      yield* Deferred.succeed(allEntriesWriteStarted, void 0).pipe(
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
          AgentName.make("primary"),
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        const result = yield* cfg.get()
        expect(result.disabledExtensions).toEqual(["@gent/todo"])
        expect(result.driverOverrides?.[AgentName.make("primary")]).toBeDefined()
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
        yield* cfg.setDriverOverride(AgentName.make("primary"), driver)
        const result = yield* cfg.get()
        const primary = result.driverOverrides?.[AgentName.make("primary")]
        if (Predicate.isUndefined(primary))
          return yield* Effect.die(new Error("expected primary override"))
        expect(primary._tag).toBe("Model")
        expect(primary.id).toBe("anthropic-proxy")
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
            '{"driverOverrides":{"primary":{"_tag":"external","id":"acp-claude-code"},"helper":{"_tag":"External","id":"acp-opencode"},"legacy":{"_tag":"model","id":"anthropic"}},"disabledExtensions":["@gent/skills"]}',
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
            expect(result.driverOverrides?.[AgentName.make("primary")]).toBeUndefined()
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
        yield* fs.writeFileString(userConfigPath, '{"disabledExtensions":["@x/keep"]}')
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          // The user edits the file while gent runs and leaves a trailing comma.
          const broken = '{"disabledExtensions":["@x/keep", "@x/new"],}'
          yield* fs.writeFileString(userConfigPath, broken)
          const fresh = yield* cfg.getFresh(cwd)
          expect(fresh.failures.map((failure) => failure.path)).toEqual([userConfigPath])
          // Reads keep the last user config that loaded.
          expect(fresh.config.disabledExtensions).toEqual(["@x/keep"])
          const outcome = yield* Effect.exit(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          expect(outcome._tag).toBe("Failure")
          expect(yield* fs.readFileString(userConfigPath)).toEqual(broken)
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive(
      "launched from home, the user config is read once, not again as the project's",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const home = yield* fs.makeTempDirectoryScoped()
          const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          yield* fs.writeFileString(userConfigPath, '{"disabledExtensions":["@x/off"]}')
          const live = ConfigService.Live.pipe(
            Layer.provide(RuntimeEnvironment.Live({ cwd: home, home })),
            Layer.provide(BunServices.layer),
          )
          yield* Effect.gen(function* () {
            const cfg = yield* ConfigService
            expect((yield* cfg.getFresh(home)).config.disabledExtensions).toEqual(["@x/off"])
            // A broken user file is one failure: the project scope is not a second copy of it.
            yield* fs.writeFileString(userConfigPath, "{broken")
            const fresh = yield* cfg.getFresh(home)
            expect(fresh.failures.map((failure) => failure.path)).toEqual([userConfigPath])
          }).pipe(Effect.provide(live))
          yield* fs.writeFileString(userConfigPath, '{"disabledExtensions":["@x/off"]}')
          expect([...(yield* readDisabledExtensions({ home, cwd: home }))]).toEqual(["@x/off"])
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
          // The user edits the file by hand while gent runs; nothing reads it yet.
          yield* fs.writeFileString(userConfigPath, encodeJson({ disabledExtensions: ["@x/keep"] }))
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          const persisted = yield* decodeUserConfig(yield* fs.readFileString(userConfigPath))
          expect(persisted.disabledExtensions).toEqual(["@x/keep"])
          expect(persisted.driverOverrides?.[AgentName.make("main")]).toEqual(
            DriverRef.make({ id: "anthropic" }),
          )
          // The write also refreshes the snapshot reads use.
          expect((yield* cfg.get()).disabledExtensions).toEqual(["@x/keep"])
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // The last decoded user config stands in for a user file that stops
    // decoding; a read that raced a write must not put the older one back.
    it.scopedLive("a read that finishes after a write never restores the older config", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const armed = yield* Ref.make(false)
        const held = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        // The armed read of the user file holds its text until the test releases it.
        const heldRead = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFs = yield* FileSystem.FileSystem
            return FileSystem.makeNoop({
              ...realFs,
              readFileString: (target, encoding) =>
                realFs.readFileString(target, encoding).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (target !== userConfigPath) return
                      if (!(yield* Ref.getAndSet(armed, false))) return
                      yield* Deferred.succeed(held, void 0)
                      yield* Deferred.await(release)
                    }),
                  ),
                ),
            })
          }),
        ).pipe(Layer.provide(BunServices.layer))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(userConfigPath, encodeJson({ trustedProjects: ["/old"] }))
          yield* Ref.set(armed, true)
          const reader = yield* Effect.forkChild(cfg.get())
          yield* Deferred.await(held)
          const writer = yield* Effect.forkChild(
            cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" })),
          )
          // A writer that does not wait for the held read finishes here.
          yield* Fiber.await(writer).pipe(Effect.timeoutOption("200 millis"))
          yield* Deferred.succeed(release, void 0)
          yield* Fiber.join(reader)
          yield* Fiber.join(writer)
          yield* fs.writeFileString(userConfigPath, "{ broken")
          const fallback = yield* cfg.get()
          expect(fallback.driverOverrides?.[AgentName.make("main")]).toEqual(
            DriverRef.make({ id: "anthropic" }),
          )
        }).pipe(Effect.provide(liveConfigAt(cwd, home, heldRead)))
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
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
              agents: { main: { reasoningEffort: "high" } },
            }),
          )
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          expect(yield* readRaw).toEqual({
            trustedProjects: ["/x"],
            futureField: { nested: [1, 2] },
            agents: { main: { reasoningEffort: "high" } },
            driverOverrides: { main: { _tag: "Model", id: "anthropic" } },
          })
          // Clearing the last override removes the key it owns, and only that.
          yield* cfg.clearDriverOverride(AgentName.make("main"))
          expect(yield* readRaw).toEqual({
            trustedProjects: ["/x"],
            futureField: { nested: [1, 2] },
            agents: { main: { reasoningEffort: "high" } },
          })
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // A config file is the user's: a write leaves each agent entry as the
    // user wrote it, with no key the stored-row codec adds for older readers.
    it.scopedLive("a driver write leaves each agent entry as the user wrote it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const agents = {
          painter: {
            model: "anthropic/claude-sonnet-4-6",
            tools: ["film.*", "!film.check", "read"],
            paths: ["films", { path: "skills", access: "read" }],
          },
          reviewer: { tools: ["read", "grep"] },
          main: { deniedTools: ["bash"], modelId: "openai/gpt-5" },
        }
        const agentsText = (text: string) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ agents: Schema.Unknown })))(
            text,
          ).pipe(Effect.map((config) => encodeJson(config.agents)))
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(userConfigPath, encodeJson({ agents }))
          yield* cfg.setDriverOverride(AgentName.make("main"), DriverRef.make({ id: "anthropic" }))
          const written = yield* fs.readFileString(userConfigPath)
          expect(yield* agentsText(written)).toBe(encodeJson(agents))
          yield* cfg.clearDriverOverride(AgentName.make("main"))
          expect(yield* agentsText(yield* fs.readFileString(userConfigPath))).toBe(
            encodeJson(agents),
          )
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
        }).pipe(Effect.provide(liveConfigAt(cwd, home)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // The first `/model` pick names the user's model: `model` in the user
    // file, written once and never over the user's own.
    it.scopedLive("the first model pick names the user's model and keeps every other key", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
        const readRaw = fs
          .readFileString(userConfigPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
        const written = {
          agents: { main: { deniedTools: ["bash"], modelId: "openai/gpt-5" } },
          futureKey: { kept: true },
        }
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.writeFileString(userConfigPath, encodeJson(written))
          yield* cfg.setModelIfUnset(ModelId.make("anthropic/claude-opus-5-5"))
          const named = { ...written, model: "anthropic/claude-opus-5-5" }
          expect(yield* readRaw).toEqual(named)
          expect((yield* cfg.get()).model).toBe(ModelId.make("anthropic/claude-opus-5-5"))
          // The user's model stands: a later pick writes nothing.
          yield* cfg.setModelIfUnset(ModelId.make("anthropic/claude-sonnet-5-5"))
          expect(yield* readRaw).toEqual(named)
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
        const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
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
          // A stamp as recent as its mtime is not trusted, so the first read
          // after the files age reads them once; then the stamps hold.
          const aged = DateTime.toDate(DateTime.subtract(yield* DateTime.now, { minutes: 1 }))
          yield* fs.utimes(projectConfigPath, aged, aged)
          yield* fs.utimes(userConfigPath, aged, aged)
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
        }).pipe(Effect.provide(liveConfigAt(cwd, home, countingReads)))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // An in-place save sets the file's mtime before it copies the bytes, and
    // the file clock ticks coarser than a millisecond. A read inside that
    // window stats the new stamp and reads the old bytes; the save then ends
    // in the same tick, so size, mtime and inode stay what the read saw.
    for (const file of ["project", "user"] as const) {
      it.scopedLive(
        `a same-size ${file} config save in the clock tick of the last read reaches the next read`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const cwd = yield* fs.makeTempDirectoryScoped()
            const home = yield* fs.makeTempDirectoryScoped()
            const configPath = path.join(
              { project: cwd, user: home }[file],
              ConfigService.CONFIG_RELATIVE,
            )
            yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
            // In place, the inode kept: "one" and "two" save the same size.
            const save = (value: "one" | "two") =>
              fs.writeFileString(configPath, encodeJson({ disabledExtensions: [value] }))
            yield* save("one")
            yield* Effect.gen(function* () {
              const cfg = yield* ConfigService
              expect((yield* cfg.get()).disabledExtensions).toEqual(["one"])
              // The save's tick, a minute ahead, so it is never older than the
              // read however long the test takes.
              const tick = DateTime.toDate(DateTime.add(yield* DateTime.now, { minutes: 1 }))
              // The save began: the stamp moved, the bytes did not.
              yield* fs.utimes(configPath, tick, tick)
              expect((yield* cfg.get()).disabledExtensions).toEqual(["one"])
              // It ends in the same tick: new bytes, the same size, mtime and inode.
              yield* save("two")
              yield* fs.utimes(configPath, tick, tick)
              expect((yield* cfg.get()).disabledExtensions).toEqual(["two"])
            }).pipe(Effect.provide(liveConfigAt(cwd, home)))
          }).pipe(Effect.provide(BunServices.layer)),
      )
    }

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
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("re-setting an agent's driver replaces the prior override", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("primary"),
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(AgentName.make("primary"), DriverRef.make({ id: "anthropic" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("primary")]?.id).toBe("anthropic")
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
          AgentName.make("primary"),
          DriverRef.make({ id: "anthropic-proxy" }),
        )
        yield* cfg.setDriverOverride(AgentName.make("helper"), DriverRef.make({ id: "anthropic" }))
        const result = yield* cfg.get()
        expect(result.driverOverrides?.[AgentName.make("primary")]).toBeDefined()
        expect(result.driverOverrides?.[AgentName.make("helper")]).toBeDefined()
        // The hand-edited sibling setting is still there.
        expect(result.disabledExtensions).toEqual(["@gent/todo"])
      }).pipe(
        Effect.provide(ConfigService.Test(new UserConfig({ disabledExtensions: ["@gent/todo"] }))),
      ),
    )
  })

  describe("providers", () => {
    it.scopedLive(
      "project provider entries shadow user entries key by key; disabled providers add up",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const home = yield* fs.makeTempDirectoryScoped()
          const project = yield* fs.makeTempDirectoryScoped()
          const write = (root: string, config: ProviderConfig) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(path.join(root, ".gent"), { recursive: true })
              yield* fs.writeFileString(path.join(root, ".gent", "config.json"), encodeJson(config))
            })
          yield* write(home, {
            providers: { deepseek: {}, proxy: { class: "openai-chat", api: "https://a.test/v1" } },
            disabledProviders: ["nano-gpt"],
          })
          yield* write(project, {
            providers: { proxy: { api: "https://b.test/v1" } },
            disabledProviders: ["vercel"],
          })
          const live = ConfigService.Live.pipe(
            Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
            Layer.provide(BunServices.layer),
          )
          yield* Effect.gen(function* () {
            const result = yield* (yield* ConfigService).get(project)
            expect(result.providers).toEqual({
              deepseek: {},
              proxy: { api: "https://b.test/v1" },
            })
            expect(result.disabledProviders).toEqual(["nano-gpt", "vercel"])
          }).pipe(Effect.provide(live))
        }).pipe(Effect.provide(BunServices.layer)),
    )
  })

  describe("agents", () => {
    it.scopedLive("a project agent entry replaces only the fields it names", () =>
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
            model: ModelId.make("anthropic/claude-sonnet-5"),
            reasoningEffort: "low",
          },
          [AgentName.make("helper")]: { reasoningEffort: "minimal" },
        })
        yield* write(project, {
          [AgentName.make("main")]: { model: ModelId.make("openai/gpt-5.6-sol") },
        })
        const live = ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
          Layer.provide(BunServices.layer),
        )
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get(project)
          // The project entry names the model; the user entry's effort stays.
          expect(result.agents?.[AgentName.make("main")]).toEqual({
            model: ModelId.make("openai/gpt-5.6-sol"),
            reasoningEffort: "low",
          })
          expect(result.agents?.[AgentName.make("helper")]).toEqual({ reasoningEffort: "minimal" })
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    // A config file written before `tools` names `modelId` and the two tool
    // lists. It still decodes, as `model` and tool patterns: a field the
    // schema rejects would fail the whole file.
    it.live("a config entry with the old tool lists reads as tool patterns", () =>
      Effect.gen(function* () {
        const config = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
          encodeJson({
            agents: {
              main: { modelId: "openai/gpt-5", deniedTools: ["bash"] },
              painter: { allowedTools: ["film.look", "read"] },
            },
          }),
        )
        const roster = resolveAgentRoster([], Option.fromUndefinedOr(config.agents))
        const held = (name: string) =>
          ["film.look", "read", "bash"].filter((id) =>
            roster.get(AgentName.make(name))?.admitsTool(id),
          )
        expect(roster.get(AgentName.make("main"))?.model).toBe(ModelId.make("openai/gpt-5"))
        expect(held("main")).toEqual(["film.look", "read"])
        expect(held("painter")).toEqual(["film.look", "read"])
      }),
    )

    // A config file is the user's, not a row an older gent reads: an entry
    // encodes with the keys it decoded from, never the ones a stored row adds.
    it.live("a config agent entry encodes back with the keys it was written with", () =>
      Effect.gen(function* () {
        const ConfigJson = Schema.fromJsonString(UserConfig)
        const agents = {
          painter: { model: "anthropic/claude-sonnet-4-6", tools: ["film.*", "!film.check"] },
          main: { deniedTools: ["bash"] },
          helper: { allowedTools: ["read"] },
        }
        const config = yield* Schema.decodeEffect(ConfigJson)(encodeJson({ agents }))
        const encoded = yield* Schema.encodeEffect(ConfigJson)(config)
        expect(parseJson(encoded)).toEqual({ agents })
      }),
    )

    // A misspelled field would be dropped, and the entry would make an agent
    // with every tool; the file fails to load instead.
    it.live("a config agent entry with an unknown key fails, naming the agent and the key", () =>
      Effect.gen(function* () {
        const error = yield* Schema.decodeEffect(Schema.fromJsonString(UserConfig))(
          encodeJson({ agents: { painter: { toolz: ["read"] } } }),
        ).pipe(Effect.flip)
        expect(String(error)).toContain('["agents"]["painter"]["toolz"]')
        expect(String(error)).toContain("is not an agent field")
      }),
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
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.live("a write that does not name agents keeps the stored ones", () =>
      Effect.gen(function* () {
        const cfg = yield* ConfigService
        yield* cfg.setDriverOverride(
          AgentName.make("primary"),
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

      yield* writeProjectConfig(launch, "primary", "launch-driver")
      yield* writeProjectConfig(projectA, "primary", "projectA-driver")
      yield* writeProjectConfig(projectB, "primary", "projectB-driver")

      const live = ConfigService.Live.pipe(
        Layer.provide(RuntimeEnvironment.Live({ cwd: launch, home })),
        Layer.provide(BunServices.layer),
      )
      return { live, projectA, projectB }
    })

    const expectDriverOverride = (cfg: UserConfig, agent: string, expectedId: string): void => {
      expect(cfg.driverOverrides?.[AgentName.make(agent)]?.id).toBe(expectedId)
    }

    // A read that failed is not a decode: the stat does not change when a
    // permission comes back, so the next read must try the file again.
    it.scopedLive("a project config read that failed is tried again, not cached", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { live, projectA } = yield* makeLive
        const projectConfig = path.join(projectA, ".gent", "config.json")
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          yield* fs.chmod(projectConfig, 0o000)
          const unreadable = yield* cfg.getFresh(projectA)
          expect(unreadable.failures.map((failure) => failure.path)).toEqual([projectConfig])
          yield* fs.chmod(projectConfig, 0o644)
          const readable = yield* cfg.getFresh(projectA)
          expect(readable.failures).toEqual([])
          expectDriverOverride(readable.config, "primary", "projectA-driver")
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )

    it.scopedLive("launch-cwd reads the launch-cwd project config", () =>
      Effect.gen(function* () {
        const { live } = yield* makeLive
        yield* Effect.gen(function* () {
          const cfg = yield* ConfigService
          const result = yield* cfg.get()
          expectDriverOverride(result, "primary", "launch-driver")
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
          expectDriverOverride(a, "primary", "projectA-driver")
          expectDriverOverride(b, "primary", "projectB-driver")
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
          expect(result.driverOverrides?.[AgentName.make("primary")]).toBeUndefined()
        }).pipe(Effect.provide(live))
      }).pipe(Effect.provide(BunServices.layer)),
    )
  })
})

// ── driver override routing ─────────────────────────────────────────────────

/**
 * Driver override routing: `ConfigService.driverOverrides` flows into
 * `resolveSessionRoute`, the one place a turn's driver is chosen. The
 * precedence itself is tested in tests/runtime/turn.test.ts.
 */

const primary = AgentDefinition.make({ name: AgentName.make("primary") })

/** The driver id a session running `agent` dispatches through under the config. */
const routedDriver = (agent: AgentDefinition, config: UserConfig) =>
  resolveSessionRoute({
    agents: [agent],
    admission: Option.some({ agent: agent.name }),
    config,
    session: { modelId: ModelId.make("anthropic/claude-sonnet-5") },
  }).modelDriver.pipe(Option.flatMap((driver) => driver.driverId))

describe("configured driver override routing", () => {
  it.live("clearing the override routes through the provider on the next read", () =>
    Effect.gen(function* () {
      const cfg = yield* ConfigService
      yield* cfg.setDriverOverride(
        AgentName.make("primary"),
        DriverRef.make({ id: "anthropic-proxy" }),
      )
      expect(routedDriver(primary, yield* cfg.get())).toEqual(Option.some("anthropic-proxy"))
      yield* cfg.clearDriverOverride(AgentName.make("primary"))
      expect(routedDriver(primary, yield* cfg.get())).toEqual(Option.some("anthropic"))
    }).pipe(Effect.provide(ConfigService.Test())),
  )
})

// ── agents from config ──────────────────────────────────────────────────────

/**
 * An agent written as JSON in a config file, over the full RPC path: the
 * session names it at creation, its turn runs on its model, prompt and tools.
 * The extension registers the tools and, where named, the agent the config
 * reshapes.
 */
const filmTools = (agents: ReadonlyArray<AgentDefinition>) =>
  defineExtension({
    id: "test/film-tools",
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      if (agents.length > 0) yield* host.register("agent", ...agents)
      for (const name of ["film.look", "film.check", "read", "bash"]) {
        yield* host.register(
          "tool",
          tool({
            id: name,
            description: `Run ${name}`,
            params: Schema.Struct({ value: Schema.String }),
            output: Schema.String,
            execute: ({ value }) => Effect.succeed(`${name}:${value}`),
          }),
        )
      }
    }),
  })

/** A config file as it is written: plain JSON, the old and new shapes alike. */
type ConfigFile = typeof UserConfig.Encoded

const writeConfig = (root: string, config: ConfigFile) => writeConfigJson(root, config)

/** A config file as JSON: a written shape, or a hand edit that misspells `tools`. */
type ConfigJson =
  | ConfigFile
  | {
      readonly agents: Readonly<
        Record<
          string,
          { readonly tools: ReadonlyArray<string>; readonly toolz: ReadonlyArray<string> }
        >
      >
    }

/** A config file as JSON, a key no schema names included. */
const writeConfigJson = (root: string, config: ConfigJson) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.join(root, ".gent"), { recursive: true })
    yield* fs.writeFileString(path.join(root, ".gent", "config.json"), encodeJson(config))
  })

/** The wire names a request advertises, sorted: each dot is `__` there. */
const advertised = (options: ProviderOptions) =>
  options.tools.map((entry) => entry.name).toSorted(Order.String)

const runOneTurn = (params: {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly user: ConfigFile
  readonly project: ConfigFile
  readonly agent: Option.Option<AgentName>
  readonly step: SequenceStep
}) =>
  Effect.gen(function* () {
    const home = yield* makeTempDirectoryScoped("gent-agent-config-home-")
    const cwd = yield* makeTempDirectoryScoped("gent-agent-config-cwd-")
    yield* writeConfig(home, params.user)
    yield* writeConfig(cwd, params.project)
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([params.step])
    const { client, sessionId, branchId } = yield* createRpcHarness({
      agents: [],
      extensionInputs: [filmTools(params.agents)],
      providerLayer,
      cwd,
      home,
      configServiceLayer: ConfigService.Live.pipe(
        Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
        Layer.provide(BunPlatformLive),
      ),
      ...Option.match(params.agent, {
        onNone: () => ({}),
        onSome: (agent) => ({ admission: { agent } }),
      }),
    })
    yield* client.message.send({ sessionId, branchId, content: "Paint the scene." })
    yield* waitFor(
      client.message.list({ branchId }),
      (messages) =>
        messages.some(
          (message) => message.role === "assistant" && messagePartsText(message.parts) === "done",
        ),
      3000,
      "reply",
    )
    yield* controls.assertDone
    return { client, sessionId }
  })

/** The ```json block under `## Agents` in the extension guide, read as a config file. */
const guideAgentsConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const guide = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL("../../../../docs/extensions.md", import.meta.url)),
  )
  const section = guide.slice(guide.indexOf("## Agents\n"))
  const block = section.slice(section.indexOf("```json\n") + "```json\n".length)
  return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.toEncoded(UserConfig)))(
    block.slice(0, block.indexOf("```")),
  )
})

describe("agents from config over RPC", () => {
  it.scopedLive("a project config entry with a new name creates an agent a session runs as", () =>
    Effect.gen(function* () {
      const painter = AgentName.make("scene-painter")
      const { client, sessionId } = yield* runOneTurn({
        agents: [],
        user: {},
        project: {
          agents: {
            [painter]: {
              description: "Paints one scene",
              model: "test/painter-model",
              systemPromptAddendum: "PAINTER-BRIEF",
              tools: ["film.*", "!film.check", "read"],
            },
          },
        },
        agent: Option.some(painter),
        step: {
          ...textStep("done"),
          assertRequest: (request) => expect(request.model).toBe("test/painter-model"),
          assertOptions: (options) => {
            expect(advertised(options)).toEqual(["film__look", "read"])
            expect(systemTextOf(options.prompt)).toContain("PAINTER-BRIEF")
          },
        },
      })
      // The roster a client reads lists the agent with its fields.
      const listed = (yield* client.driver.list({ sessionId })).agents.find(
        (agent) => agent.name === painter,
      )
      expect(listed?.description).toBe("Paints one scene")
      expect(listed?.tools).toEqual(["film.*", "!film.check", "read"])
    }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("the JSON agent in the extension guide runs as written", () =>
    Effect.gen(function* () {
      const painter = AgentName.make("painter")
      const { client, sessionId } = yield* runOneTurn({
        agents: [],
        user: {},
        project: yield* guideAgentsConfig,
        agent: Option.some(painter),
        step: {
          ...textStep("done"),
          assertRequest: (request) => expect(request.model).toBe("anthropic/claude-sonnet-4-6"),
          assertOptions: (options) => expect(advertised(options)).toEqual(["film__look", "read"]),
        },
      })
      const listed = (yield* client.driver.list({ sessionId })).agents.find(
        (agent) => agent.name === painter,
      )
      expect(listed?.paths).toEqual([
        { path: "apps/animations/src/films", access: "write" },
        { path: ".claude/skills/film", access: "read" },
      ])
    }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("an old project deny list takes tools away from the user's allow list", () =>
    Effect.gen(function* () {
      const painter = AgentName.make("painter")
      yield* runOneTurn({
        agents: [],
        user: {
          model: TEST_MODEL_ID,
          agents: { [painter]: { allowedTools: ["film.look", "film.check", "read"] } },
        },
        project: { agents: { [painter]: { deniedTools: ["film.check"] } } },
        agent: Option.some(painter),
        step: {
          ...textStep("done"),
          assertOptions: (options) => expect(advertised(options)).toEqual(["film__look", "read"]),
        },
      })
    }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive(
    "project config beats user config, and both beat the extension, field by field",
    () =>
      Effect.gen(function* () {
        const main = AgentName.make("main")
        yield* runOneTurn({
          agents: [
            AgentDefinition.make({
              name: main,
              model: ModelId.make("test/extension-model"),
              reasoningEffort: "high",
              tools: ["*"],
              systemPromptAddendum: "EXTENSION-BRIEF",
            }),
          ],
          user: {
            agents: {
              [main]: { model: "test/user-model", tools: ["read", "film.look"] },
            },
          },
          project: { agents: { [main]: { model: "test/project-model" } } },
          agent: Option.none(),
          step: {
            ...textStep("done"),
            assertRequest: (request) => {
              expect(request.model).toBe("test/project-model")
              expect(request.reasoning).toBe("high")
            },
            assertOptions: (options) => {
              expect(advertised(options)).toEqual(["film__look", "read"])
              expect(systemTextOf(options.prompt)).toContain("EXTENSION-BRIEF")
            },
          },
        })
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )
})

// ── a config file that does not load ────────────────────────────────────────

/**
 * A config file for the session's cwd that does not load stops its turns: a
 * file that fails sets none of its fields, so a `tools` restriction in it
 * would fall away and the agent would run with every tool. The root runs as
 * the SDK runs it, where a failed load does not stop the server.
 */
describe("a config file that does not load", () => {
  const main = AgentName.make("main")
  const everyTool = AgentDefinition.make({ name: main, tools: ["*"], model: TEST_MODEL_ID })
  const readOnly = { agents: { [main]: { tools: ["read"] } } }
  const misspelled = { agents: { [main]: { tools: ["read"], toolz: ["read"] } } }

  /** The config roots, the RPC client, and the scripted model. */
  const startRoot = (params: { readonly user: ConfigJson; readonly project: ConfigJson }) =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("gent-broken-config-home-")
      const cwd = yield* makeTempDirectoryScoped("gent-broken-config-cwd-")
      yield* writeConfigJson(home, params.user)
      yield* writeConfigJson(cwd, params.project)
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("done"),
          assertOptions: (options) => expect(advertised(options)).toEqual(["read"]),
        },
      ])
      const harness = yield* createRpcHarness({
        agents: [],
        extensionInputs: [filmTools([everyTool])],
        providerLayer,
        cwd,
        home,
        allowFailedExtensions: true,
        configServiceLayer: ConfigService.Live.pipe(
          Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
          Layer.provide(BunPlatformLive),
        ),
      })
      return { ...harness, controls, home, cwd }
    })

  type Root = Effect.Success<ReturnType<typeof startRoot>>

  /** The branch's events so far: the stream replays them, then synchronizes. */
  const branchEvents = (root: Root) =>
    root.client.session.events({ sessionId: root.sessionId, branchId: root.branchId }).pipe(
      Stream.takeUntil(({ event }) => event._tag === "StreamSynchronized"),
      Stream.map(({ event }) => event),
      Stream.runCollect,
      Effect.map((all) => Array.from(all)),
    )

  /** Sends a message and waits for its turn to end; returns the turn's errors. */
  const refusedTurn = (root: Root) =>
    Effect.gen(function* () {
      yield* root.client.message.send({
        sessionId: root.sessionId,
        branchId: root.branchId,
        content: "Paint the scene.",
      })
      const events = yield* waitFor(
        branchEvents(root),
        (all) => all.some((event) => event._tag === "TurnCompleted"),
        3000,
        "the turn ended",
      )
      return events.filter((event) => event._tag === "ErrorOccurred").map((event) => event.error)
    })

  /** Fixes the file, then a turn runs with only the tools the file names. */
  const fixedTurnRuns = (root: Root, configRoot: string) =>
    Effect.gen(function* () {
      yield* writeConfigJson(configRoot, readOnly)
      yield* root.client.message.send({
        sessionId: root.sessionId,
        branchId: root.branchId,
        content: "Paint it again.",
      })
      yield* waitFor(
        root.client.message.list({ branchId: root.branchId }),
        (messages) =>
          messages.some(
            (message) => message.role === "assistant" && messagePartsText(message.parts) === "done",
          ),
        3000,
        "reply",
      )
      yield* root.controls.assertDone
    })

  it.scopedLive("a project file with a misspelled key stops the turn until it is fixed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const root = yield* startRoot({ user: {}, project: misspelled })
      const errors = yield* refusedTurn(root)
      expect(yield* root.controls.callCount).toBe(0)
      const file = path.join(root.cwd, ".gent", "config.json")
      expect(errors.some((error) => error.includes(file) && error.includes("toolz"))).toBe(true)
      yield* fixedTurnRuns(root, root.cwd)
    }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("a user file that breaks after it loaded stops the turn until it is fixed", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      // The last user file that loaded holds bash; the broken one takes it away.
      const root = yield* startRoot({
        user: { agents: { [main]: { tools: ["read", "bash"] } } },
        project: {},
      })
      yield* writeConfigJson(root.home, misspelled)
      const errors = yield* refusedTurn(root)
      expect(yield* root.controls.callCount).toBe(0)
      const file = path.join(root.home, ".gent", "config.json")
      expect(errors.some((error) => error.includes(file) && error.includes("toolz"))).toBe(true)
      yield* fixedTurnRuns(root, root.home)
    }).pipe(Effect.timeout("8 seconds"), Effect.provide(BunPlatformLive)),
  )
})
