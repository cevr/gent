import {
  Predicate,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  SynchronizedRef,
} from "effect"
import { AgentName, DriverRef } from "../domain/agent.js"
import { PermissionRule } from "../domain/permission.js"
import { RuntimeEnvironment } from "./runtime-environment.js"

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
  driverOverrides: Schema.optional(Schema.Record(AgentName, DriverRef)),
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
  const projectPermissions = Option.getOrElse(Option.fromUndefinedOr(project.permissions), () => [])
  const userPermissions = Option.getOrElse(Option.fromUndefinedOr(user.permissions), () => [])
  const permissions = [...projectPermissions, ...userPermissions]
  const userDisabledExtensions = Option.getOrElse(
    Option.fromUndefinedOr(user.disabledExtensions),
    () => [],
  )
  const projectDisabledExtensions = Option.getOrElse(
    Option.fromUndefinedOr(project.disabledExtensions),
    () => [],
  )
  const disabledExtensions = [...userDisabledExtensions, ...projectDisabledExtensions]
  const userDriverOverrides = Option.getOrElse(
    Option.fromUndefinedOr(user.driverOverrides),
    () => ({}),
  )
  const projectDriverOverrides = Option.getOrElse(
    Option.fromUndefinedOr(project.driverOverrides),
    () => ({}),
  )
  const driverOverrides = {
    ...userDriverOverrides,
    ...projectDriverOverrides,
  }

  let mergedPermissions = Option.none<ReadonlyArray<PermissionRule>>()
  if (permissions.length > 0) mergedPermissions = Option.some(permissions)
  let mergedDisabledExtensions = Option.none<ReadonlyArray<string>>()
  if (disabledExtensions.length > 0) mergedDisabledExtensions = Option.some(disabledExtensions)
  let mergedDriverOverrides = Option.none<Readonly<Record<AgentName, DriverRef>>>()
  if (Object.keys(driverOverrides).length > 0) mergedDriverOverrides = Option.some(driverOverrides)
  return userConfigFromOptions(mergedPermissions, mergedDisabledExtensions, mergedDriverOverrides)
}

const selectConfigField = <A>(partial?: A, current?: A): Option.Option<A> =>
  Option.match(Option.fromUndefinedOr(partial), {
    onNone: () => Option.fromUndefinedOr(current),
    onSome: Option.some,
  })

const userConfigFromOptions = (
  permissions: Option.Option<ReadonlyArray<PermissionRule>>,
  disabledExtensions: Option.Option<ReadonlyArray<string>>,
  driverOverrides: Option.Option<Readonly<Record<AgentName, DriverRef>>>,
): UserConfig => {
  const config = Object.assign(
    {},
    Option.match(permissions, {
      onNone: () => ({}),
      onSome: (value) => ({ permissions: value }),
    }),
    Option.match(disabledExtensions, {
      onNone: () => ({}),
      onSome: (value) => ({ disabledExtensions: value }),
    }),
    Option.match(driverOverrides, {
      onNone: () => ({}),
      onSome: (value) => ({ driverOverrides: value }),
    }),
  )
  return new UserConfig(config)
}

// ConfigService

export interface ConfigServiceService {
  /**
   * Resolve the merged user + project config. Pass `cwd` whenever the
   * consumer is acting *on behalf of a specific session* — a multi-cwd
   * server (sessions in /a, /b, /c) cannot rely on the launch-cwd's
   * `.gent/config.json` to carry project overrides for everyone.
   * The in-memory user config is reused; only the
   * project file changes between cwds, falling back to an empty
   * project config if the file is missing or unparsable. Without `cwd`,
   * returns the cached project config from the server's launch cwd.
   */
  readonly get: (cwd?: string) => Effect.Effect<UserConfig>
  /**
   * Read user and project config from disk without using the launch snapshot.
   * Invalid JSON or schema data is reported to the caller.
   */
  readonly getFresh: (cwd: string) => Effect.Effect<UserConfig, ConfigLoadError>
  readonly set: (config: Partial<UserConfig>) => Effect.Effect<void>
  readonly addPermissionRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void>
  /** Set a per-agent driver override. Replaces any existing entry for `agent`.
   *  Use this rather than `set({ driverOverrides })` so callers don't have
   *  to remember the partial-merge semantics — `set({ driverOverrides: undefined })`
   *  preserves the existing record, which is the wrong default for clears. */
  readonly setDriverOverride: (agent: AgentName, driver: DriverRef) => Effect.Effect<void>
  /** Remove a per-agent driver override. No-op when the agent has none. */
  readonly clearDriverOverride: (agent: AgentName) => Effect.Effect<void>
  readonly loadInstructions: (cwd: string) => Effect.Effect<string>
}

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()("ConfigLoadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

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
    FileSystem.FileSystem | Path.Path | RuntimeEnvironment
  > = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runtimeEnvironment = yield* RuntimeEnvironment
      const home = runtimeEnvironment.home
      const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
      const projectConfigPath = path.join(
        runtimeEnvironment.cwd,
        ConfigService.PROJECT_CONFIG_RELATIVE,
      )

      const UserConfigJson = Schema.fromJsonString(UserConfig)
      const defaultUserConfig = new UserConfig({ permissions: [] })

      // State: user + project configs
      const userConfigRef = yield* SynchronizedRef.make<UserConfig>(new UserConfig({}))
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
            Effect.flatMap((exists) => {
              if (exists) return fs.readFileString(filePath)
              return Effect.succeed("{}")
            }),
            Effect.flatMap((content) =>
              Schema.decodeEffect(Schema.fromJsonString(UserConfig))(content),
            ),
            Effect.catchEager(() => Effect.succeed(new UserConfig({}))),
          )

        const userConfig = yield* readConfig(userConfigPath)
        const projectConfig = yield* readConfig(projectConfigPath)

        yield* SynchronizedRef.set(userConfigRef, userConfig)
        yield* Ref.set(projectConfigRef, projectConfig)

        return mergeConfigs(userConfig, projectConfig)
      }).pipe(Effect.asVoid)

      const readConfigFresh = (filePath: string): Effect.Effect<UserConfig, ConfigLoadError> =>
        fs.exists(filePath).pipe(
          Effect.flatMap((exists) => {
            if (exists) return fs.readFileString(filePath)
            return Effect.succeed("{}")
          }),
          Effect.flatMap((content) =>
            Schema.decodeEffect(Schema.fromJsonString(UserConfig))(content).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfigLoadError({
                    path: filePath,
                    message: String(cause),
                  }),
              ),
            ),
          ),
          Effect.mapError((cause) => {
            if (Schema.is(ConfigLoadError)(cause)) return cause
            return new ConfigLoadError({ path: filePath, message: String(cause) })
          }),
        )

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

      // Read a project config from an arbitrary cwd — used by `get(cwd)`
      // so consumers acting on behalf of a session in `<sessionCwd>` see
      // that cwd's per-project overrides instead of the server's launch
      // cwd. Falls back to an empty UserConfig on missing / unparsable
      // file so a misconfigured project never blocks dispatch.
      const readProjectConfigAt = (cwd: string): Effect.Effect<UserConfig> => {
        const filePath = path.join(cwd, ConfigService.PROJECT_CONFIG_RELATIVE)
        return fs.exists(filePath).pipe(
          Effect.flatMap((exists) => {
            if (exists) return fs.readFileString(filePath)
            return Effect.succeed("{}")
          }),
          Effect.flatMap((content) =>
            Schema.decodeEffect(Schema.fromJsonString(UserConfig))(content),
          ),
          Effect.catchEager(() => Effect.succeed(new UserConfig({}))),
        )
      }

      const mutateUserConfig = (
        decide: (current: UserConfig) => {
          readonly updated: UserConfig
          readonly save: boolean
        },
      ) =>
        SynchronizedRef.modifyEffect(userConfigRef, (current) => {
          const decision = decide(current)
          let save = Effect.void
          if (decision.save) save = saveUserConfig(decision.updated)
          return save.pipe(Effect.as([true, decision.updated]))
        })

      const service: ConfigServiceService = {
        get: Effect.fn("ConfigService.get")(function* (cwd) {
          const user = yield* SynchronizedRef.get(userConfigRef)
          // No cwd, or cwd matches the server's launch cwd: short-circuit
          // to the cached project ref so launch-cwd callers don't pay an
          // extra disk read per request.
          if (Predicate.isUndefined(cwd) || cwd === runtimeEnvironment.cwd) {
            const project = yield* Ref.get(projectConfigRef)
            return mergeConfigs(user, project)
          }
          const project = yield* readProjectConfigAt(cwd)
          return mergeConfigs(user, project)
        }),

        getFresh: Effect.fn("ConfigService.getFresh")(function* (cwd) {
          const user = yield* readConfigFresh(userConfigPath)
          const project = yield* readConfigFresh(
            path.join(cwd, ConfigService.PROJECT_CONFIG_RELATIVE),
          )
          // Publish only a fully decoded snapshot. User config is shared by
          // all profile keys. The cached project snapshot is launch-cwd only;
          // arbitrary session cwds continue to use their own fresh file on
          // every `get(cwd)` call.
          yield* SynchronizedRef.set(userConfigRef, user)
          if (cwd === runtimeEnvironment.cwd) yield* Ref.set(projectConfigRef, project)
          return mergeConfigs(user, project)
        }),

        set: Effect.fn("ConfigService.set")(function* (partial) {
          yield* mutateUserConfig((current) => {
            const updated = userConfigFromOptions(
              selectConfigField(partial.permissions, current.permissions),
              selectConfigField(partial.disabledExtensions, current.disabledExtensions),
              selectConfigField(partial.driverOverrides, current.driverOverrides),
            )
            return { updated, save: true }
          })
        }),

        addPermissionRule: Effect.fn("ConfigService.addPermissionRule")(function* (rule) {
          yield* mutateUserConfig((current) => {
            const currentPermissions = Option.getOrElse(
              Option.fromUndefinedOr(current.permissions),
              () => [],
            )
            const permissions = [...currentPermissions, rule]
            const updated = userConfigFromOptions(
              Option.some(permissions),
              Option.fromUndefinedOr(current.disabledExtensions),
              Option.fromUndefinedOr(current.driverOverrides),
            )
            return { updated, save: true }
          })
        }),

        removePermissionRule: Effect.fn("ConfigService.removePermissionRule")(
          function* (tool, pattern) {
            yield* mutateUserConfig((current) => {
              const currentPermissions = Option.getOrElse(
                Option.fromUndefinedOr(current.permissions),
                () => [],
              )
              const permissions = currentPermissions.filter(
                (r) => !(r.tool === tool && r.pattern === pattern),
              )
              let nextPermissions = Option.none<ReadonlyArray<PermissionRule>>()
              if (permissions.length > 0) nextPermissions = Option.some(permissions)
              const updated = userConfigFromOptions(
                nextPermissions,
                Option.fromUndefinedOr(current.disabledExtensions),
                Option.fromUndefinedOr(current.driverOverrides),
              )
              return { updated, save: true }
            })
          },
        ),

        setDriverOverride: Effect.fn("ConfigService.setDriverOverride")(function* (agent, driver) {
          yield* mutateUserConfig((current) => {
            const existing = Option.getOrElse(
              Option.fromUndefinedOr(current.driverOverrides),
              () => ({}),
            )
            const driverOverrides = { ...existing, [agent]: driver }
            const updated = userConfigFromOptions(
              Option.fromUndefinedOr(current.permissions),
              Option.fromUndefinedOr(current.disabledExtensions),
              Option.some(driverOverrides),
            )
            return { updated, save: true }
          })
        }),

        clearDriverOverride: Effect.fn("ConfigService.clearDriverOverride")(function* (agent) {
          yield* mutateUserConfig((current) => {
            const existing = Option.getOrElse(
              Option.fromUndefinedOr(current.driverOverrides),
              () => ({}),
            )
            if (!(agent in existing)) {
              return { updated: current, save: false }
            }
            const next = { ...existing }
            delete next[agent]
            let nextOverrides = Option.none<Readonly<Record<AgentName, DriverRef>>>()
            if (Object.keys(next).length > 0) nextOverrides = Option.some(next)
            const updated = userConfigFromOptions(
              Option.fromUndefinedOr(current.permissions),
              Option.fromUndefinedOr(current.disabledExtensions),
              nextOverrides,
            )
            return { updated, save: true }
          })
        }),

        loadInstructions: Effect.fn("ConfigService.loadInstructions")(function* (cwd) {
          const readIfExists = (filePath: string): Effect.Effect<string> =>
            fs.exists(filePath).pipe(
              Effect.flatMap((exists) => {
                if (exists) return fs.readFileString(filePath)
                return Effect.succeed("")
              }),
              Effect.map((content) => content.trim()),
              Effect.catchEager(() => Effect.succeed("")),
            )

          const readWithFallback = (primary: string, fallback: string): Effect.Effect<string> =>
            readIfExists(primary).pipe(
              Effect.filterOrElse(
                (content) => content.length > 0,
                () => readIfExists(fallback),
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

  static Test = (initialConfig: UserConfig = new UserConfig({})): Layer.Layer<ConfigService> =>
    Layer.effect(
      ConfigService,
      Effect.gen(function* () {
        const userConfigRef = yield* Ref.make(initialConfig)
        const projectConfigRef = yield* Ref.make(new UserConfig({}))

        return ConfigService.of({
          // Test impl: `cwd` is ignored — no filesystem to read. Tests that
          // need per-cwd behavior should drive it through `Live` with a
          // tmpdir cwd, since `Test` is for hermetic units.
          get: () =>
            Effect.gen(function* () {
              const user = yield* Ref.get(userConfigRef)
              const project = yield* Ref.get(projectConfigRef)
              return mergeConfigsImpl(user, project)
            }),
          getFresh: () =>
            Effect.gen(function* () {
              const user = yield* Ref.get(userConfigRef)
              const project = yield* Ref.get(projectConfigRef)
              return mergeConfigsImpl(user, project)
            }),
          set: (partial) =>
            Ref.update(userConfigRef, (current) =>
              userConfigFromOptions(
                selectConfigField(partial.permissions, current.permissions),
                selectConfigField(partial.disabledExtensions, current.disabledExtensions),
                selectConfigField(partial.driverOverrides, current.driverOverrides),
              ),
            ),
          addPermissionRule: (rule) =>
            Ref.update(userConfigRef, (current) => {
              const currentPermissions = Option.getOrElse(
                Option.fromUndefinedOr(current.permissions),
                () => [],
              )
              const permissions = [...currentPermissions, rule]
              return userConfigFromOptions(
                Option.some(permissions),
                Option.fromUndefinedOr(current.disabledExtensions),
                Option.fromUndefinedOr(current.driverOverrides),
              )
            }).pipe(Effect.asVoid),
          removePermissionRule: (tool, pattern) =>
            Ref.update(userConfigRef, (current) => {
              const currentPermissions = Option.getOrElse(
                Option.fromUndefinedOr(current.permissions),
                () => [],
              )
              const permissions = currentPermissions.filter(
                (r) => !(r.tool === tool && r.pattern === pattern),
              )
              let nextPermissions = Option.none<ReadonlyArray<PermissionRule>>()
              if (permissions.length > 0) nextPermissions = Option.some(permissions)
              return userConfigFromOptions(
                nextPermissions,
                Option.fromUndefinedOr(current.disabledExtensions),
                Option.fromUndefinedOr(current.driverOverrides),
              )
            }).pipe(Effect.asVoid),
          setDriverOverride: (agent, driver) =>
            Ref.update(userConfigRef, (current) => {
              const existing = Option.getOrElse(
                Option.fromUndefinedOr(current.driverOverrides),
                () => ({}),
              )
              const driverOverrides = { ...existing, [agent]: driver }
              return userConfigFromOptions(
                Option.fromUndefinedOr(current.permissions),
                Option.fromUndefinedOr(current.disabledExtensions),
                Option.some(driverOverrides),
              )
            }).pipe(Effect.asVoid),
          clearDriverOverride: (agent) =>
            Ref.update(userConfigRef, (current) => {
              const existing = Option.getOrElse(
                Option.fromUndefinedOr(current.driverOverrides),
                () => ({}),
              )
              if (!(agent in existing)) return current
              const next = { ...existing }
              delete next[agent]
              let nextOverrides = Option.none<Readonly<Record<AgentName, DriverRef>>>()
              if (Object.keys(next).length > 0) nextOverrides = Option.some(next)
              return userConfigFromOptions(
                Option.fromUndefinedOr(current.permissions),
                Option.fromUndefinedOr(current.disabledExtensions),
                nextOverrides,
              )
            }).pipe(Effect.asVoid),
          loadInstructions: () => Effect.succeed(""),
        })
      }),
    )
}
