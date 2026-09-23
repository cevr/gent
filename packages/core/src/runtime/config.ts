import {
  Context,
  Effect,
  Equal,
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
import { writeFileAtomic } from "./gent-platform.js"

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

/** A config file as JSON, with every key, known to `UserConfig` or not. */
const RawConfigJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type RawConfig = typeof RawConfigJson.Type

const isRawObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** The raw keys of an entry that neither decoded side knows. */
const unknownKeys = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => !(key in before) && !(key in after)))

/**
 * A changed record-of-struct field (`driverOverrides`). Its keys
 * follow `after`: an entry the decode dropped (a retired driver ref) or the
 * change cleared is removed. An entry `before` also decoded keeps the raw
 * keys gent does not know, under the encoded `after` entry.
 */
const mergeEntries = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig =>
  Object.fromEntries(
    Object.entries(after).map(([key, now]) => {
      const current = raw[key]
      const was = before[key]
      if (isRawObject(current) && isRawObject(was) && isRawObject(now)) {
        return [key, { ...unknownKeys(current, was, now), ...now }]
      }
      return [key, now]
    }),
  )

/**
 * The record-of-struct fields a config write changes. Only `driverOverrides`
 * has a writer; a field no write changes never reaches the merge, because
 * `mergeChangedFields` skips an unchanged field. A new writer for another
 * record-of-struct field (`agents`) adds it here.
 */
const ENTRY_FIELDS: ReadonlySet<string> = new Set(["driverOverrides"])

/**
 * `raw` with each `UserConfig` field that differs between `before` and
 * `after` (both encoded) set to its `after` value, or removed when `after`
 * leaves it out. A changed entry field keeps the unknown keys inside its
 * entries (`mergeEntries`). Every other key of `raw` is kept as it is.
 */
const mergeChangedFields = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig => {
  const merged = { ...raw }
  for (const key of Object.keys(UserConfig.fields)) {
    const now = after[key]
    if (Equal.equals(before[key], now)) continue
    if (!(key in after)) delete merged[key]
    else {
      const current = raw[key]
      const was = before[key]
      if (ENTRY_FIELDS.has(key) && isRawObject(current) && isRawObject(was) && isRawObject(now)) {
        merged[key] = mergeEntries(current, was, now)
      } else merged[key] = now
    }
  }
  return merged
}

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
   * empty (project).
   */
  readonly getFresh: (cwd: string) => Effect.Effect<FreshConfig>
  /** Set a per-agent driver override. Replaces any existing entry for `agent`.
   *  The write starts from the user config on disk now, not the launch
   *  snapshot, so a hand edit made while gent runs survives. Fails with
   *  `ConfigLoadError` when that file does not decode (writing would discard
   *  every setting in it) and with `ConfigWriteError` when the file cannot be
   *  replaced. */
  readonly setDriverOverride: (
    agent: AgentName,
    driver: DriverRef,
  ) => Effect.Effect<void, ConfigLoadError | ConfigWriteError>
  /** Remove a per-agent driver override. No-op when the agent has none. */
  readonly clearDriverOverride: (
    agent: AgentName,
  ) => Effect.Effect<void, ConfigLoadError | ConfigWriteError>
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

/** The user config could not be written; the file on disk is unchanged. */
export class ConfigWriteError extends Schema.TaggedError<ConfigWriteError>()("ConfigWriteError", {
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
      const readConfigText = (filePath: string) =>
        fs.exists(filePath).pipe(
          Effect.flatMap((exists) => {
            if (exists) return fs.readFileString(filePath)
            return Effect.succeed("{}")
          }),
        )

      const readConfigFile = (filePath: string) =>
        readConfigText(filePath).pipe(
          Effect.tap((content) => warnRetiredOverrides(filePath, content)),
          Effect.flatMap((content) => Schema.decodeEffect(UserConfigJson)(content)),
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
      // A config that will not decode reads as empty, so a broken file
      // cannot stop a turn. Writes never start from this snapshot: each one
      // reads the user file again and refuses when it does not decode.
      const loadConfig = Effect.gen(function* () {
        const projectConfig = yield* readConfigOrEmpty(projectConfigPath)
        const userConfig = yield* readConfigFresh(userConfigPath).pipe(
          Effect.catchEager((error) =>
            Effect.logWarning("Config load failed — writes refused until it is fixed").pipe(
              Effect.annotateLogs({ path: userConfigPath, error: error.message }),
              Effect.as(new UserConfig({})),
            ),
          ),
        )

        yield* SynchronizedRef.set(userConfigRef, userConfig)
        yield* Ref.set(projectConfigRef, projectConfig)

        return mergeConfigs(userConfig, projectConfig)
      }).pipe(Effect.asVoid)

      // Replace the user config through a staged sibling, so a reader (or a
      // crash) never sees a half-written file. Only the fields the update
      // changed are written into the file as it was read: a key this build
      // does not know (a newer build's field, a hand edit), and the unknown
      // parts of a known field left unchanged, stay as they are.
      const saveUserConfig = (raw: RawConfig, before: UserConfig, after: UserConfig) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          const asRaw = (config: UserConfig) =>
            Schema.encodeEffect(UserConfigJson)(config).pipe(
              Effect.flatMap(Schema.decodeEffect(RawConfigJson)),
            )
          const json = yield* Schema.encodeEffect(RawConfigJson)(
            mergeChangedFields(raw, yield* asRaw(before), yield* asRaw(after)),
          )
          yield* writeFileAtomic(userConfigPath, json)
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) => new ConfigWriteError({ path: userConfigPath, message: String(cause) }),
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
      ): Effect.Effect<void, ConfigLoadError | ConfigWriteError> =>
        // The ref orders writers; the file is the source. Deciding on the file
        // as it is now keeps a hand edit made since the last read, and a file
        // that does not decode fails here instead of being replaced.
        SynchronizedRef.updateEffect(userConfigRef, () =>
          Effect.gen(function* () {
            const [raw, onDisk] = yield* readConfigText(userConfigPath).pipe(
              Effect.flatMap((content) =>
                Effect.all([
                  Schema.decodeEffect(RawConfigJson)(content),
                  Schema.decodeEffect(UserConfigJson)(content),
                ]),
              ),
              Effect.mapError(
                (cause) => new ConfigLoadError({ path: userConfigPath, message: String(cause) }),
              ),
            )
            const decision = decide(onDisk)
            if (decision.save) yield* saveUserConfig(raw, onDisk, decision.updated)
            return decision.updated
          }),
        )

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
            // all profile keys.
            yield* SynchronizedRef.set(userConfigRef, user)
          } else {
            failures.push(userRead.failure)
            user = yield* SynchronizedRef.get(userConfigRef)
          }
          const projectRead = yield* Effect.result(
            readConfigFresh(path.join(cwd, ConfigService.CONFIG_RELATIVE)),
          )
          // A project file that does not load sets nothing, the same as in
          // `get(cwd)`.
          let project = new UserConfig({})
          if (Result.isSuccess(projectRead)) project = projectRead.success
          else failures.push(projectRead.failure)
          // The cached project snapshot is launch-cwd only; other cwds read
          // their own file on every `get(cwd)` call. It follows this read,
          // or a broken file would leave the old settings active.
          if (cwd === runtimeEnvironment.cwd) yield* Ref.set(projectConfigRef, project)
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
