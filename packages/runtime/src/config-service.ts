import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { ModelId, ProviderId, PermissionRule } from "@gent/core"

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  model: Schema.optional(ModelId),
  provider: Schema.optional(ProviderId),
  permissions: Schema.optional(Schema.Array(PermissionRule)),
}) {}

// ConfigService Error

export class ConfigServiceError extends Schema.TaggedError<ConfigServiceError>()(
  "ConfigServiceError",
  { message: Schema.String },
) {}

// ConfigService

export interface ConfigServiceService {
  readonly get: () => Effect.Effect<UserConfig>
  readonly set: (config: Partial<UserConfig>) => Effect.Effect<void>
  readonly getModel: () => Effect.Effect<ModelId | undefined>
  readonly setModel: (modelId: ModelId) => Effect.Effect<void>
  readonly getPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
  readonly addPermissionRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void>
}

export class ConfigService extends Context.Tag("ConfigService")<
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

      // State: user + project configs
      const userConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))
      const projectConfigRef = yield* Ref.make<UserConfig>(new UserConfig({}))

      const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig => {
        const projectRules = project.permissions ?? []
        const userRules = user.permissions ?? []
        const permissions = [...projectRules, ...userRules]

        return new UserConfig({
          model: project.model ?? user.model,
          provider: project.provider ?? user.provider,
          permissions: permissions.length > 0 ? permissions : undefined,
        })
      }

      // Load config from disk (merges project over user)
      const loadConfig = Effect.gen(function* () {
        const readConfig = (filePath: string) =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) => (exists ? fs.readFileString(filePath) : Effect.succeed("{}"))),
            Effect.flatMap((content) => Schema.decodeUnknown(UserConfigJson)(content)),
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
              permissions: partial.permissions ?? current.permissions,
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
              permissions,
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
              permissions: permissions.length > 0 ? permissions : undefined,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
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
      return new UserConfig({
        model: project.model ?? user.model,
        provider: project.provider ?? user.provider,
        permissions: permissions.length > 0 ? permissions : undefined,
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
        Ref.update(userConfigRef, (current) =>
          new UserConfig({
            model: partial.model ?? current.model,
            provider: partial.provider ?? current.provider,
            permissions: partial.permissions ?? current.permissions,
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
          })
        }).pipe(Effect.asVoid),
    })
  }
}
