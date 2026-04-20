import { Context, Effect, Layer, Ref, Schema, FileSystem, Path } from "effect"
import { DriverRef } from "../domain/agent.js"
import { PermissionRule } from "../domain/permission.js"
import { RuntimePlatform } from "./runtime-platform.js"

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  permissions: Schema.optional(Schema.Array(PermissionRule)),
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Per-agent driver routing overrides. Keyed by agent name; the value is
   * a `DriverRef` (model or external). Project config shadows user config
   * key-by-key — see `mergeConfigs`.
   *
   * Used by `resolveAgentDriver` (domain/agent.ts) to route an agent
   * through an alternative backend without editing its definition. E.g.
   * `{ cowork: { _tag: "external", id: "acp-claude-code" } }` makes
   * `cowork` dispatch through the Claude Code SDK executor.
   */
  driverOverrides: Schema.optional(Schema.Record(Schema.String, DriverRef)),
}) {}

/**
 * Merge user + project configs. Per-field semantics:
 *   - permissions: concatenated (project first, then user — historical order).
 *   - disabledExtensions: concatenated (user first — historical order).
 *   - driverOverrides: object spread; project entries shadow user entries
 *     key-by-key. Idempotent set/clear is the load-bearing property —
 *     `Record<agent, DriverRef>` (vs `Array`) means `driver.set` / `clear`
 *     map directly to `record[name] = ref` / `delete record[name]`.
 */
const mergeConfigsImpl = (user: UserConfig, project: UserConfig): UserConfig => {
  const permissions = [...(project.permissions ?? []), ...(user.permissions ?? [])]
  const disabledExtensions = [
    ...(user.disabledExtensions ?? []),
    ...(project.disabledExtensions ?? []),
  ]
  const driverOverrides: Record<string, DriverRef> = {
    ...(user.driverOverrides ?? {}),
    ...(project.driverOverrides ?? {}),
  }
  return new UserConfig({
    permissions: permissions.length > 0 ? permissions : undefined,
    disabledExtensions: disabledExtensions.length > 0 ? disabledExtensions : undefined,
    driverOverrides: Object.keys(driverOverrides).length > 0 ? driverOverrides : undefined,
  })
}

// ConfigService

export interface ConfigServiceService {
  /**
   * Resolve the merged user + project config. Pass `cwd` whenever the
   * consumer is acting *on behalf of a specific session* — a multi-cwd
   * server (sessions in /a, /b, /c) cannot rely on the launch-cwd's
   * `.gent/config.json` to carry project overrides for everyone
   * (counsel HIGH #1). The in-memory user config is reused; only the
   * project file changes between cwds, falling back to an empty
   * project config if the file is missing or unparsable. Without `cwd`,
   * returns the cached project config from the server's launch cwd.
   */
  readonly get: (cwd?: string) => Effect.Effect<UserConfig>
  readonly set: (config: Partial<UserConfig>) => Effect.Effect<void>
  readonly getPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
  readonly addPermissionRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void>
  /** Set a per-agent driver override. Replaces any existing entry for `agent`.
   *  Use this rather than `set({ driverOverrides })` so callers don't have
   *  to remember the partial-merge semantics — `set({ driverOverrides: undefined })`
   *  preserves the existing record, which is the wrong default for clears. */
  readonly setDriverOverride: (agent: string, driver: DriverRef) => Effect.Effect<void>
  /** Remove a per-agent driver override. No-op when the agent has none. */
  readonly clearDriverOverride: (agent: string) => Effect.Effect<void>
  readonly loadInstructions: (cwd: string) => Effect.Effect<string>
}

export class ConfigService extends Context.Service<ConfigService, ConfigServiceService>()(
  "@gent/core/src/runtime/config-service/ConfigService",
) {
  /** Relative path from $HOME for user config */
  static USER_CONFIG_RELATIVE = ".gent/config.json"
  /** Relative path from project root for project config */
  static PROJECT_CONFIG_RELATIVE = ".gent/config.json"

  static Live: Layer.Layer<
    ConfigService,
    never,
    FileSystem.FileSystem | Path.Path | RuntimePlatform
  > = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runtimePlatform = yield* RuntimePlatform
      const home = runtimePlatform.home
      const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
      const projectConfigPath = path.join(
        runtimePlatform.cwd,
        ConfigService.PROJECT_CONFIG_RELATIVE,
      )

      const UserConfigJson = Schema.fromJsonString(UserConfig)
      const defaultUserConfig = new UserConfig({ permissions: [] })

      // State: user + project configs
      const userConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))
      const projectConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))

      const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig =>
        mergeConfigsImpl(user, project)

      const ensureUserConfig = Effect.gen(function* () {
        const exists = yield* fs.exists(userConfigPath)
        if (exists) return
        const configDir = path.dirname(userConfigPath)
        yield* fs.makeDirectory(configDir, { recursive: true })
        const json = yield* Schema.encodeEffect(UserConfigJson)(defaultUserConfig)
        yield* fs.writeFileString(userConfigPath, json)
      }).pipe(
        Effect.catchEager((e) =>
          Effect.logWarning("Config init failed").pipe(Effect.annotateLogs({ error: String(e) })),
        ),
      )

      // Load config from disk (merges project over user)
      const loadConfig = Effect.gen(function* () {
        const readConfig = (filePath: string) =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) =>
              exists ? fs.readFileString(filePath) : Effect.succeed("{}"),
            ),
            Effect.flatMap((content) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(UserConfig))(content),
            ),
            Effect.catchEager(() => Effect.succeed(new UserConfig({}))),
          )

        const userConfig = yield* readConfig(userConfigPath)
        const projectConfig = yield* readConfig(projectConfigPath)

        yield* Ref.set(userConfigRef, userConfig)
        yield* Ref.set(projectConfigRef, projectConfig)

        return mergeConfigs(userConfig, projectConfig)
      }).pipe(Effect.asVoid)

      // Save user config to disk
      const saveUserConfig = (config: UserConfig) =>
        Effect.gen(function* () {
          const configDir = path.dirname(userConfigPath)
          yield* fs.makeDirectory(configDir, { recursive: true })
          const json = yield* Schema.encodeEffect(UserConfigJson)(config)
          yield* fs.writeFileString(userConfigPath, json)
        }).pipe(
          Effect.catchEager((e) =>
            Effect.logWarning("Config save failed").pipe(Effect.annotateLogs({ error: String(e) })),
          ),
        )

      // Initial load
      yield* ensureUserConfig
      yield* loadConfig

      // Read a project config from an arbitrary cwd. Used by `getForCwd`
      // so consumers acting on behalf of a session in `<sessionCwd>` see
      // the right per-project overrides instead of the server's launch
      // cwd. Falls back to an empty UserConfig on missing / unparsable
      // file so a misconfigured project never blocks dispatch.
      const readProjectConfigAt = (cwd: string): Effect.Effect<UserConfig> => {
        const filePath = path.join(cwd, ConfigService.PROJECT_CONFIG_RELATIVE)
        return fs.exists(filePath).pipe(
          Effect.flatMap((exists) => (exists ? fs.readFileString(filePath) : Effect.succeed("{}"))),
          Effect.flatMap((content) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(UserConfig))(content),
          ),
          Effect.catchEager(() => Effect.succeed(new UserConfig({}))),
        )
      }

      const service: ConfigServiceService = {
        get: Effect.fn("ConfigService.get")(function* (cwd) {
          const user = yield* Ref.get(userConfigRef)
          // No cwd, or cwd matches the server's launch cwd: short-circuit
          // to the cached project ref so launch-cwd callers don't pay an
          // extra disk read per request.
          if (cwd === undefined || cwd === runtimePlatform.cwd) {
            const project = yield* Ref.get(projectConfigRef)
            return mergeConfigs(user, project)
          }
          const project = yield* readProjectConfigAt(cwd)
          return mergeConfigs(user, project)
        }),

        set: Effect.fn("ConfigService.set")(function* (partial) {
          const current = yield* Ref.get(userConfigRef)
          const updated = new UserConfig({
            permissions: partial.permissions ?? current.permissions,
            disabledExtensions: partial.disabledExtensions ?? current.disabledExtensions,
            driverOverrides: partial.driverOverrides ?? current.driverOverrides,
          })
          yield* Ref.set(userConfigRef, updated)
          yield* saveUserConfig(updated)
        }),

        getPermissionRules: Effect.fn("ConfigService.getPermissionRules")(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return [...(project.permissions ?? []), ...(user.permissions ?? [])]
        }),

        addPermissionRule: Effect.fn("ConfigService.addPermissionRule")(function* (rule) {
          const current = yield* Ref.get(userConfigRef)
          const permissions = [...(current.permissions ?? []), rule]
          const updated = new UserConfig({
            permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides: current.driverOverrides,
          })
          yield* Ref.set(userConfigRef, updated)
          yield* saveUserConfig(updated)
        }),

        removePermissionRule: Effect.fn("ConfigService.removePermissionRule")(
          function* (tool, pattern) {
            const current = yield* Ref.get(userConfigRef)
            const permissions = (current.permissions ?? []).filter(
              (r) => !(r.tool === tool && r.pattern === pattern),
            )
            const updated = new UserConfig({
              permissions: permissions.length > 0 ? permissions : undefined,
              disabledExtensions: current.disabledExtensions,
              driverOverrides: current.driverOverrides,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
          },
        ),

        setDriverOverride: Effect.fn("ConfigService.setDriverOverride")(function* (agent, driver) {
          const current = yield* Ref.get(userConfigRef)
          const driverOverrides = { ...(current.driverOverrides ?? {}), [agent]: driver }
          const updated = new UserConfig({
            permissions: current.permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides,
          })
          yield* Ref.set(userConfigRef, updated)
          yield* saveUserConfig(updated)
        }),

        clearDriverOverride: Effect.fn("ConfigService.clearDriverOverride")(function* (agent) {
          const current = yield* Ref.get(userConfigRef)
          const existing = current.driverOverrides ?? {}
          if (!(agent in existing)) return
          const next = { ...existing }
          delete next[agent]
          const updated = new UserConfig({
            permissions: current.permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides: Object.keys(next).length > 0 ? next : undefined,
          })
          yield* Ref.set(userConfigRef, updated)
          yield* saveUserConfig(updated)
        }),

        loadInstructions: Effect.fn("ConfigService.loadInstructions")(function* (cwd) {
          const readIfExists = (filePath: string): Effect.Effect<string> =>
            fs.exists(filePath).pipe(
              Effect.flatMap((exists) =>
                exists ? fs.readFileString(filePath) : Effect.succeed(""),
              ),
              Effect.map((content) => content.trim()),
              Effect.catchEager(() => Effect.succeed("")),
            )

          const readWithFallback = (primary: string, fallback: string): Effect.Effect<string> =>
            readIfExists(primary).pipe(
              Effect.flatMap((content) =>
                content.length > 0 ? Effect.succeed(content) : readIfExists(fallback),
              ),
            )

          const locations = [
            {
              primary: path.join(home, ".gent", "AGENTS.md"),
              fallback: path.join(home, ".gent", "CLAUDE.md"),
            },
            { primary: path.join(cwd, "AGENTS.md"), fallback: path.join(cwd, "CLAUDE.md") },
            {
              primary: path.join(cwd, ".gent", "AGENTS.md"),
              fallback: path.join(cwd, ".gent", "CLAUDE.md"),
            },
          ]

          const contents: string[] = []
          for (const loc of locations) {
            const content = yield* readWithFallback(loc.primary, loc.fallback)
            if (content.length > 0) contents.push(content)
          }

          if (contents.length === 0) {
            const globalFallback = path.join(home, ".claude", "CLAUDE.md")
            const content = yield* readIfExists(globalFallback)
            if (content.length > 0) contents.push(content)
          }

          return contents.join("\n---\n")
        }),
      }

      return service
    }),
  )

  static Test = (initialConfig: UserConfig = new UserConfig({})): Layer.Layer<ConfigService> => {
    const userConfigRef = Ref.makeUnsafe(initialConfig)
    const projectConfigRef = Ref.makeUnsafe(new UserConfig({}))

    return Layer.succeed(ConfigService, {
      // Test impl: `cwd` is ignored — no filesystem to read. Tests that
      // need per-cwd behavior should drive it through `Live` with a
      // tmpdir cwd, since `Test` is for hermetic units.
      get: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigsImpl(user, project)
        }),
      set: (partial) =>
        Ref.update(
          userConfigRef,
          (current) =>
            new UserConfig({
              permissions: partial.permissions ?? current.permissions,
              disabledExtensions: partial.disabledExtensions ?? current.disabledExtensions,
              driverOverrides: partial.driverOverrides ?? current.driverOverrides,
            }),
        ),
      getPermissionRules: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return [...(project.permissions ?? []), ...(user.permissions ?? [])]
        }),
      addPermissionRule: (rule) =>
        Ref.update(userConfigRef, (current) => {
          const permissions = [...(current.permissions ?? []), rule]
          return new UserConfig({
            permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides: current.driverOverrides,
          })
        }).pipe(Effect.asVoid),
      removePermissionRule: (tool, pattern) =>
        Ref.update(userConfigRef, (current) => {
          const permissions = (current.permissions ?? []).filter(
            (r) => !(r.tool === tool && r.pattern === pattern),
          )
          return new UserConfig({
            permissions: permissions.length > 0 ? permissions : undefined,
            disabledExtensions: current.disabledExtensions,
            driverOverrides: current.driverOverrides,
          })
        }).pipe(Effect.asVoid),
      setDriverOverride: (agent, driver) =>
        Ref.update(userConfigRef, (current) => {
          const driverOverrides = { ...(current.driverOverrides ?? {}), [agent]: driver }
          return new UserConfig({
            permissions: current.permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides,
          })
        }).pipe(Effect.asVoid),
      clearDriverOverride: (agent) =>
        Ref.update(userConfigRef, (current) => {
          const existing = current.driverOverrides ?? {}
          if (!(agent in existing)) return current
          const next = { ...existing }
          delete next[agent]
          return new UserConfig({
            permissions: current.permissions,
            disabledExtensions: current.disabledExtensions,
            driverOverrides: Object.keys(next).length > 0 ? next : undefined,
          })
        }).pipe(Effect.asVoid),
      loadInstructions: () => Effect.succeed(""),
    })
  }
}
