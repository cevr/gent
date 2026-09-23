import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  Schema,
  SynchronizedRef,
} from "effect"
import {
  AgentName,
  AgentRunOverridesSchema,
  type DriverRef,
  DriverOverridesFromConfig,
  isRetiredDriverRef,
} from "../domain/agent.js"

// ── runtime-environment ─────────────────────────────────────────────────────

interface RuntimeEnvironmentApi {
  readonly cwd: string
  readonly home: string
}

export class RuntimeEnvironment extends Context.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentApi
>()("@gent/core/src/runtime/config/RuntimeEnvironment") {
  static Live = (config: RuntimeEnvironmentApi): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)
}

// ── extensions/disabled ─────────────────────────────────────────────────────

/**
 * Disabled-extension reader for a caller that has no `ConfigService`.
 * Effect-based — requires FileSystem and Path from the platform.
 *
 * The TUI's extension context boundary
 * (`apps/tui/src/extensions/loader-boundary.ts`) reads the set this
 * way because it runs before any server is reachable. On the server path
 * `ConfigService` is the reader and `SessionProfileCache` passes the merged
 * set down, so the two config files are opened once.
 *
 * This module also owns where those files live; `ConfigService` builds its
 * paths from the same constants.
 */

/** The per-user and per-project directory holding gent's config file. */
export const GENT_CONFIG_DIRECTORY = ".gent"

/** The config file inside `GENT_CONFIG_DIRECTORY`. */
const GENT_CONFIG_FILENAME = "config.json"

const DisabledConfig = Schema.Struct({
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
})

/** Read disabledExtensions from a JSON config file. Returns [] on any error. */
const readDisabledFromFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(filePath)
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(DisabledConfig))(text)
    return Option.getOrElse(Option.fromUndefinedOr(decoded.disabledExtensions), () => [])
  }).pipe(Effect.catchEager(() => Effect.succeed<ReadonlyArray<string>>([])))

/**
 * Read disabled extensions from user + project config.
 * Same merge semantics as ConfigService: union of user + project lists.
 */
export const readDisabledExtensions = (params: {
  home: string
  cwd: string
  extra?: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const userConfigPath = path.join(params.home, GENT_CONFIG_DIRECTORY, GENT_CONFIG_FILENAME)
    const projectConfigPath = path.join(params.cwd, GENT_CONFIG_DIRECTORY, GENT_CONFIG_FILENAME)
    const userDisabled = yield* readDisabledFromFile(userConfigPath)
    const projectDisabled = yield* readDisabledFromFile(projectConfigPath)
    return new Set([...(params.extra ?? []), ...userDisabled, ...projectDisabled])
  })

// ── config-service ──────────────────────────────────────────────────────────

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Per-agent model driver overrides. Keyed by agent name; the value is a
   * `DriverRef`. Project config shadows user config key-by-key — see
   * `mergeConfigs`.
   *
   * Used by `resolveAgentDriver` (domain/agent.ts) to route an agent
   * through another model driver without editing its definition. E.g.
   * `{ main: { _tag: "Model", id: "openai" } }` sends `main`'s model name
   * to the OpenAI driver.
   */
  driverOverrides: Schema.optional(DriverOverridesFromConfig),
  /**
   * Per-agent definition overrides: model, reasoning effort, tool lists and
   * a prompt addendum. Project config shadows user config key-by-key; a
   * run's own `RunSpec.overrides` shadows both.
   */
  agents: Schema.optional(Schema.Record(AgentName, AgentRunOverridesSchema)),
}) {}

/** An empty list or record is stored as an absent field. */
const nonEmpty = <A>(items: ReadonlyArray<A>) =>
  Option.getOrUndefined(Option.liftPredicate(items, (list) => list.length > 0))

const nonEmptyRecord = <A>(record: Readonly<Record<AgentName, A>>) =>
  Option.getOrUndefined(Option.liftPredicate(record, (r) => Object.keys(r).length > 0))

/** Pure user-config transitions shared by the live and in-memory services. */
const configUpdates = {
  setDriverOverride: (current: UserConfig, agent: AgentName, driver: DriverRef): UserConfig =>
    new UserConfig({
      ...current,
      driverOverrides: { ...current.driverOverrides, [agent]: driver },
    }),
  /** `None` when the agent had no override, so callers can skip the save. */
  clearDriverOverride: (current: UserConfig, agent: AgentName): Option.Option<UserConfig> => {
    const existing = current.driverOverrides ?? {}
    if (!(agent in existing)) return Option.none()
    const next = { ...existing }
    delete next[agent]
    return Option.some(new UserConfig({ ...current, driverOverrides: nonEmptyRecord(next) }))
  },
}

/**
 * Merge user + project configs. Per-field semantics:
 *   - disabledExtensions: concatenated (user first — historical order).
 *   - trustedProjects: user config only; project config cannot grant trust.
 *   - driverOverrides, agents: object spread; project entries shadow user
 *     entries key-by-key. Idempotent set/clear is the load-bearing property —
 *     `Record<agent, DriverRef>` (vs `Array`) means `driver.set` / `clear`
 *     map directly to `record[name] = ref` / `delete record[name]`.
 */
const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig =>
  new UserConfig({
    disabledExtensions: nonEmpty([
      ...(user.disabledExtensions ?? []),
      ...(project.disabledExtensions ?? []),
    ]),
    driverOverrides: nonEmptyRecord({ ...user.driverOverrides, ...project.driverOverrides }),
    agents: nonEmptyRecord({ ...user.agents, ...project.agents }),
    trustedProjects: user.trustedProjects,
  })

/** The agents whose stored override names a removed external driver. */
const StoredDriverOverrides = Schema.Struct({
  driverOverrides: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const retiredOverrideAgents = (content: string): ReadonlyArray<string> =>
  Option.match(Schema.decodeOption(Schema.fromJsonString(StoredDriverOverrides))(content), {
    onNone: () => [],
    onSome: (stored) =>
      Object.entries(stored.driverOverrides ?? {})
        .filter(([, ref]) => isRetiredDriverRef(ref))
        .map(([agent]) => agent),
  })

// ConfigService

interface ConfigServiceService {
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
   * A file that does not decode never stops the read: it is reported in
   * `failures` and read as the last user config that loaded (user) or as
   * empty (project). A failed user file also refuses writes until it loads.
   */
  readonly getFresh: (cwd: string) => Effect.Effect<FreshConfig>
  /** Set a per-agent driver override. Replaces any existing entry for `agent`.
   *  Fails with `ConfigLoadError` when the user config on disk did not decode:
   *  writing would replace the unreadable file with a default and discard
   *  every setting in it. */
  readonly setDriverOverride: (
    agent: AgentName,
    driver: DriverRef,
  ) => Effect.Effect<void, ConfigLoadError>
  /** Remove a per-agent driver override. No-op when the agent has none. */
  readonly clearDriverOverride: (agent: AgentName) => Effect.Effect<void, ConfigLoadError>
}

/** A fresh config read: the merged config and every file that did not load. */
interface FreshConfig {
  readonly config: UserConfig
  readonly failures: ReadonlyArray<ConfigLoadError>
}

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()("ConfigLoadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export class ConfigService extends Context.Service<ConfigService, ConfigServiceService>()(
  "@gent/core/src/runtime/config/ConfigService",
) {
  /**
   * Where a config file sits, relative to $HOME for the user config and to
   * the project root for the project config. One path, because both files
   * carry the same schema at the same place under their own root.
   */
  static CONFIG_RELATIVE = `${GENT_CONFIG_DIRECTORY}/${GENT_CONFIG_FILENAME}`

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
      const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)
      const projectConfigPath = path.join(runtimeEnvironment.cwd, ConfigService.CONFIG_RELATIVE)

      const UserConfigJson = Schema.fromJsonString(UserConfig)
      const defaultUserConfig = new UserConfig({})

      // State: user + project configs
      const userConfigRef = yield* SynchronizedRef.make<UserConfig>(new UserConfig({}))
      const projectConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))
      // Set when the user config exists but does not decode. Reads still
      // degrade to an empty config so a broken file cannot stop a turn, but
      // writes refuse: `saveUserConfig` would persist that empty config over
      // the user's file and discard every setting it holds.
      const userLoadFailureRef = yield* Ref.make<Option.Option<ConfigLoadError>>(Option.none())

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

      // A stored override that names a removed external driver decodes as
      // absent. Say so once per file, not on every read of a project config.
      const warnedRetiredPaths = yield* Ref.make<ReadonlySet<string>>(new Set())
      const warnRetiredOverrides = (filePath: string, content: string) =>
        Effect.gen(function* () {
          const agents = retiredOverrideAgents(content)
          if (agents.length === 0) return
          const warned = yield* Ref.modify(warnedRetiredPaths, (paths) => [
            paths.has(filePath),
            new Set([...paths, filePath]),
          ])
          if (warned) return
          yield* Effect.logWarning(
            "Config names a removed external driver; the agent uses its default model",
          ).pipe(Effect.annotateLogs({ path: filePath, agents: agents.join(", ") }))
        })

      // A missing file reads as an empty config.
      const readConfigFile = (filePath: string) =>
        fs.exists(filePath).pipe(
          Effect.flatMap((exists) => {
            if (exists) return fs.readFileString(filePath)
            return Effect.succeed("{}")
          }),
          Effect.tap((content) => warnRetiredOverrides(filePath, content)),
          Effect.flatMap((content) =>
            Schema.decodeEffect(Schema.fromJsonString(UserConfig))(content),
          ),
        )

      const readConfigOrEmpty = (filePath: string): Effect.Effect<UserConfig> =>
        readConfigFile(filePath).pipe(Effect.catchEager(() => Effect.succeed(new UserConfig({}))))

      const readConfigFresh = (filePath: string): Effect.Effect<UserConfig, ConfigLoadError> =>
        readConfigFile(filePath).pipe(
          Effect.mapError(
            (cause) => new ConfigLoadError({ path: filePath, message: String(cause) }),
          ),
        )

      // Load config from disk (merges project over user).
      //
      // A project config that will not decode stays tolerant — gent never
      // writes that file, so a broken one can only mislead, not lose data.
      // A user config that will not decode is remembered: reads degrade,
      // writes refuse.
      const loadConfig = Effect.gen(function* () {
        const projectConfig = yield* readConfigOrEmpty(projectConfigPath)
        const userConfig = yield* readConfigFresh(userConfigPath).pipe(
          Effect.tap(() => Ref.set(userLoadFailureRef, Option.none())),
          Effect.catchEager((error) =>
            Effect.logWarning("Config load failed — writes refused until it is fixed").pipe(
              Effect.annotateLogs({ path: userConfigPath, error: error.message }),
              Effect.andThen(Ref.set(userLoadFailureRef, Option.some(error))),
              Effect.as(new UserConfig({})),
            ),
          ),
        )

        yield* SynchronizedRef.set(userConfigRef, userConfig)
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

      // Read a project config from an arbitrary cwd — used by `get(cwd)`
      // so consumers acting on behalf of a session in `<sessionCwd>` see
      // that cwd's per-project overrides instead of the server's launch
      // cwd. Falls back to an empty UserConfig on missing / unparsable
      // file so a misconfigured project never blocks dispatch.
      const readProjectConfigAt = (cwd: string): Effect.Effect<UserConfig> =>
        readConfigOrEmpty(path.join(cwd, ConfigService.CONFIG_RELATIVE))

      const mutateUserConfig = (
        decide: (current: UserConfig) => {
          readonly updated: UserConfig
          readonly save: boolean
        },
      ): Effect.Effect<boolean, ConfigLoadError> =>
        Effect.gen(function* () {
          // Refuse before touching the ref: a write built on the fallback
          // empty config would overwrite a file we could not read.
          const failure = yield* Ref.get(userLoadFailureRef)
          if (Option.isSome(failure)) return yield* failure.value
          return yield* SynchronizedRef.modifyEffect(userConfigRef, (current) => {
            const decision = decide(current)
            let save = Effect.void
            if (decision.save) save = saveUserConfig(decision.updated)
            return save.pipe(Effect.as([true, decision.updated]))
          })
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
          const failures: Array<ConfigLoadError> = []
          const userRead = yield* Effect.result(readConfigFresh(userConfigPath))
          let user: UserConfig
          if (Result.isSuccess(userRead)) {
            user = userRead.success
            // Publish only a fully decoded snapshot; user config is shared by
            // all profile keys. A successful read means the file parses again:
            // lift the write refusal so a user who fixed their config can save.
            yield* SynchronizedRef.set(userConfigRef, user)
            yield* Ref.set(userLoadFailureRef, Option.none())
          } else {
            failures.push(userRead.failure)
            // The file changed under us and no longer decodes: refuse writes,
            // or the next save would replace the user's edit with the snapshot.
            yield* Ref.set(userLoadFailureRef, Option.some(userRead.failure))
            user = yield* SynchronizedRef.get(userConfigRef)
          }
          const projectRead = yield* Effect.result(
            readConfigFresh(path.join(cwd, ConfigService.CONFIG_RELATIVE)),
          )
          let project = new UserConfig({})
          if (Result.isSuccess(projectRead)) {
            project = projectRead.success
            // The cached project snapshot is launch-cwd only; other cwds read
            // their own file on every `get(cwd)` call.
            if (cwd === runtimeEnvironment.cwd) yield* Ref.set(projectConfigRef, project)
          } else {
            failures.push(projectRead.failure)
          }
          return { config: mergeConfigs(user, project), failures }
        }),

        setDriverOverride: Effect.fn("ConfigService.setDriverOverride")(function* (agent, driver) {
          yield* mutateUserConfig((current) => ({
            updated: configUpdates.setDriverOverride(current, agent, driver),
            save: true,
          }))
        }),

        clearDriverOverride: Effect.fn("ConfigService.clearDriverOverride")(function* (agent) {
          yield* mutateUserConfig((current) =>
            Option.match(configUpdates.clearDriverOverride(current, agent), {
              onNone: () => ({ updated: current, save: false }),
              onSome: (updated) => ({ updated, save: true }),
            }),
          )
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
        // No filesystem, so there is no project config to read: the merge runs
        // against the empty one for its normalizing half.
        const emptyProjectConfig = new UserConfig({})

        return ConfigService.of({
          // Test impl: `cwd` is ignored — no filesystem to read. Tests that
          // need per-cwd behavior should drive it through `Live` with a
          // tmpdir cwd, since `Test` is for hermetic units.
          get: () =>
            Effect.gen(function* () {
              const user = yield* Ref.get(userConfigRef)
              return mergeConfigs(user, emptyProjectConfig)
            }),
          getFresh: () =>
            Effect.gen(function* () {
              const user = yield* Ref.get(userConfigRef)
              return { config: mergeConfigs(user, emptyProjectConfig), failures: [] }
            }),
          setDriverOverride: (agent, driver) =>
            Ref.update(userConfigRef, (current) =>
              configUpdates.setDriverOverride(current, agent, driver),
            ),
          clearDriverOverride: (agent) =>
            Ref.update(userConfigRef, (current) =>
              Option.getOrElse(configUpdates.clearDriverOverride(current, agent), () => current),
            ),
        })
      }),
    )
}

// ── extensions/project-trust ────────────────────────────────────────────────

const TrustConfig = Schema.fromJsonString(
  Schema.Struct({ trustedProjects: UserConfig.fields.trustedProjects }),
)

/** Only user configuration can authorize project module execution. */
export const isProjectExtensionDirectoryTrusted = Effect.fn("ExtensionLoader.projectTrust")(
  function* (directories: { readonly userDir: string; readonly projectDir: string }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* Effect.gen(function* () {
      const configPath = path.resolve(directories.userDir, "../config.json")
      const config = yield* fs
        .readFileString(configPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(TrustConfig)))
      const projectRoot = yield* fs.realPath(path.resolve(directories.projectDir, "../.."))
      return (config.trustedProjects ?? []).includes(projectRoot)
    }).pipe(Effect.orElseSucceed(() => false))
  },
)
