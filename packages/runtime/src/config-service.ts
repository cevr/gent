import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { AgentName, ModelId, ProviderId, PermissionRule, CustomProviderConfig } from "@gent/core"

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  model: Schema.optional(ModelId),
  provider: Schema.optional(ProviderId),
  agent: Schema.optional(AgentName),
  subprocessBinaryPath: Schema.optional(Schema.String),
  permissions: Schema.optional(Schema.Array(PermissionRule)),
  /** Custom provider configurations keyed by provider name */
  providers: Schema.optional(Schema.Record({ key: Schema.String, value: CustomProviderConfig })),
}) {}

// ConfigService

export interface ConfigServiceService {
  readonly get: () => Effect.Effect<UserConfig>
  readonly set: (config: Partial<UserConfig>) => Effect.Effect<void>
  readonly getModel: () => Effect.Effect<ModelId | undefined>
  readonly setModel: (modelId: ModelId) => Effect.Effect<void>
  readonly getAgent: () => Effect.Effect<AgentName | undefined>
  readonly setAgent: (agent: AgentName) => Effect.Effect<void>
  readonly getSubprocessBinaryPath: () => Effect.Effect<string | undefined>
  readonly setSubprocessBinaryPath: (path: string) => Effect.Effect<void>
  readonly getPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
  readonly addPermissionRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void>
  readonly getCustomProviders: () => Effect.Effect<
    Readonly<Record<string, CustomProviderConfig>> | undefined
  >
}

export class ConfigService extends Context.Tag("@gent/runtime/src/config-service/ConfigService")<
  ConfigService,
  ConfigServiceService
>() {
  /** Relative path from $HOME for user config */
  static USER_CONFIG_RELATIVE = ".gent/config.json"
  /** Relative path from project root for project config */
  static PROJECT_CONFIG_RELATIVE = ".gent/config.json"

  static Live: Layer.Layer<ConfigService, never, FileSystem.FileSystem | Path.Path> = Layer.scoped(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const home = process.env["HOME"] ?? "~"
      const userConfigPath = path.join(home, ConfigService.USER_CONFIG_RELATIVE)
      const projectConfigPath = path.join(process.cwd(), ConfigService.PROJECT_CONFIG_RELATIVE)

      const UserConfigJson = Schema.parseJson(UserConfig)
      const defaultUserConfig = new UserConfig({ permissions: [] })

      // State: user + project configs
      const userConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))
      const projectConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))

      const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig => {
        const projectRules = project.permissions ?? []
        const userRules = user.permissions ?? []
        const permissions = [...projectRules, ...userRules]

        // Merge providers: project overrides user for same key
        const userProviders = user.providers ?? {}
        const projectProviders = project.providers ?? {}
        const mergedProviders = { ...userProviders, ...projectProviders }

        return new UserConfig({
          model: project.model ?? user.model,
          provider: project.provider ?? user.provider,
          agent: project.agent ?? user.agent,
          subprocessBinaryPath: project.subprocessBinaryPath ?? user.subprocessBinaryPath,
          permissions: permissions.length > 0 ? permissions : undefined,
          providers: Object.keys(mergedProviders).length > 0 ? mergedProviders : undefined,
        })
      }

      const ensureUserConfig = Effect.gen(function* () {
        const exists = yield* fs.exists(userConfigPath)
        if (exists) return
        const configDir = path.dirname(userConfigPath)
        yield* fs.makeDirectory(configDir, { recursive: true })
        const json = yield* Schema.encode(UserConfigJson)(defaultUserConfig)
        yield* fs.writeFileString(userConfigPath, json)
      }).pipe(
        Effect.catchAll((e) =>
          Effect.logWarning("Config init failed").pipe(Effect.annotateLogs({ error: String(e) })),
        ),
      )

      // Load config from disk (merges project over user)
      const loadConfig = Effect.gen(function* () {
        const normalizeAgent = (value: unknown) => (value === "default" ? "cowork" : value)
        const normalizeUserConfig = (value: unknown) => {
          if (value === null || typeof value !== "object" || Array.isArray(value)) return value
          const obj = value as Record<string, unknown>
          if (!("agent" in obj)) return obj
          return { ...obj, agent: normalizeAgent(obj["agent"]) }
        }

        const readConfig = (filePath: string) =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) =>
              exists ? fs.readFileString(filePath) : Effect.succeed("{}"),
            ),
            Effect.flatMap((content) =>
              Effect.try({
                try: () => JSON.parse(content) as unknown,
                catch: () => ({}),
              }),
            ),
            Effect.map(normalizeUserConfig),
            Effect.flatMap((data) => Schema.decodeUnknown(UserConfig)(data)),
            Effect.catchAll(() => Effect.succeed(new UserConfig({}))),
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
          const json = yield* Schema.encode(UserConfigJson)(config)
          yield* fs.writeFileString(userConfigPath, json)
        }).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("Config save failed").pipe(Effect.annotateLogs({ error: String(e) })),
          ),
        )

      // Initial load
      yield* ensureUserConfig
      yield* loadConfig

      const service: ConfigServiceService = {
        get: () =>
          Effect.gen(function* () {
            const user = yield* Ref.get(userConfigRef)
            const project = yield* Ref.get(projectConfigRef)
            return mergeConfigs(user, project)
          }),

        set: (partial) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(userConfigRef)
            const updated = new UserConfig({
              model: partial.model ?? current.model,
              provider: partial.provider ?? current.provider,
              agent: partial.agent ?? current.agent,
              subprocessBinaryPath: partial.subprocessBinaryPath ?? current.subprocessBinaryPath,
              permissions: partial.permissions ?? current.permissions,
              providers: partial.providers ?? current.providers,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
          }),

        getModel: () => service.get().pipe(Effect.map((c) => c.model)),

        setModel: (modelId) =>
          Effect.gen(function* () {
            // Extract provider from model ID (format: provider/model-name)
            const parts = (modelId as string).split("/")
            const providerId = parts[0] as ProviderId | undefined

            yield* service.set({
              model: modelId,
              provider: providerId,
            })
          }),

        getAgent: () => service.get().pipe(Effect.map((c) => c.agent)),

        setAgent: (agent) => service.set({ agent }),

        getSubprocessBinaryPath: () =>
          service.get().pipe(Effect.map((c) => c.subprocessBinaryPath)),

        setSubprocessBinaryPath: (pathValue) => service.set({ subprocessBinaryPath: pathValue }),

        getPermissionRules: () =>
          Effect.gen(function* () {
            const user = yield* Ref.get(userConfigRef)
            const project = yield* Ref.get(projectConfigRef)
            return [...(project.permissions ?? []), ...(user.permissions ?? [])]
          }),

        addPermissionRule: (rule) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(userConfigRef)
            const permissions = [...(current.permissions ?? []), rule]
            const updated = new UserConfig({
              model: current.model,
              provider: current.provider,
              agent: current.agent,
              subprocessBinaryPath: current.subprocessBinaryPath,
              permissions,
              providers: current.providers,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
          }),

        removePermissionRule: (tool, pattern) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(userConfigRef)
            const permissions = (current.permissions ?? []).filter(
              (r) => !(r.tool === tool && r.pattern === pattern),
            )
            const updated = new UserConfig({
              model: current.model,
              provider: current.provider,
              agent: current.agent,
              subprocessBinaryPath: current.subprocessBinaryPath,
              permissions: permissions.length > 0 ? permissions : undefined,
              providers: current.providers,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
          }),

        getCustomProviders: () =>
          Effect.gen(function* () {
            const user = yield* Ref.get(userConfigRef)
            const project = yield* Ref.get(projectConfigRef)
            const merged = mergeConfigs(user, project)
            return merged.providers
          }),
      }

      return service
    }),
  )

  static Test = (initialConfig: UserConfig = new UserConfig({})): Layer.Layer<ConfigService> => {
    const userConfigRef = Ref.unsafeMake(initialConfig)
    const projectConfigRef = Ref.unsafeMake(new UserConfig({}))

    const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig => {
      const permissions = [...(project.permissions ?? []), ...(user.permissions ?? [])]
      const userProviders = user.providers ?? {}
      const projectProviders = project.providers ?? {}
      const mergedProviders = { ...userProviders, ...projectProviders }
      return new UserConfig({
        model: project.model ?? user.model,
        provider: project.provider ?? user.provider,
        agent: project.agent ?? user.agent,
        subprocessBinaryPath: project.subprocessBinaryPath ?? user.subprocessBinaryPath,
        permissions: permissions.length > 0 ? permissions : undefined,
        providers: Object.keys(mergedProviders).length > 0 ? mergedProviders : undefined,
      })
    }

    return Layer.succeed(ConfigService, {
      get: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigs(user, project)
        }),
      set: (partial) =>
        Ref.update(
          userConfigRef,
          (current) =>
            new UserConfig({
              model: partial.model ?? current.model,
              provider: partial.provider ?? current.provider,
              agent: partial.agent ?? current.agent,
              subprocessBinaryPath: partial.subprocessBinaryPath ?? current.subprocessBinaryPath,
              permissions: partial.permissions ?? current.permissions,
              providers: partial.providers ?? current.providers,
            }),
        ),
      getModel: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigs(user, project).model
        }),
      setModel: (modelId) => {
        const parts = (modelId as string).split("/")
        const providerId = parts[0] as ProviderId | undefined
        return Ref.update(
          userConfigRef,
          () => new UserConfig({ model: modelId, provider: providerId }),
        )
      },
      getAgent: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigs(user, project).agent
        }),
      setAgent: (agent) =>
        Ref.update(userConfigRef, (current) => new UserConfig({ ...current, agent })).pipe(
          Effect.asVoid,
        ),
      getSubprocessBinaryPath: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigs(user, project).subprocessBinaryPath
        }),
      setSubprocessBinaryPath: (pathValue) =>
        Ref.update(
          userConfigRef,
          (current) => new UserConfig({ ...current, subprocessBinaryPath: pathValue }),
        ).pipe(Effect.asVoid),
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
            model: current.model,
            provider: current.provider,
            permissions,
            providers: current.providers,
          })
        }).pipe(Effect.asVoid),
      removePermissionRule: (tool, pattern) =>
        Ref.update(userConfigRef, (current) => {
          const permissions = (current.permissions ?? []).filter(
            (r) => !(r.tool === tool && r.pattern === pattern),
          )
          return new UserConfig({
            model: current.model,
            provider: current.provider,
            permissions: permissions.length > 0 ? permissions : undefined,
            providers: current.providers,
          })
        }).pipe(Effect.asVoid),
      getCustomProviders: () =>
        Effect.gen(function* () {
          const user = yield* Ref.get(userConfigRef)
          const project = yield* Ref.get(projectConfigRef)
          return mergeConfigs(user, project).providers
        }),
    })
  }
}
