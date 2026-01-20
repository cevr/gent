import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { ModelId, ProviderId } from "@gent/core"

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  model: Schema.optional(ModelId),
  provider: Schema.optional(ProviderId),
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

      // State: current config
      const configRef = yield* Ref.make<UserConfig>(new UserConfig({}))

      // Load config from disk (merges project over user)
      const loadConfig = Effect.gen(function* () {
        let config = new UserConfig({})

        // Load user config
        const userExists = yield* fs.exists(userConfigPath)
        if (userExists) {
          const content = yield* fs.readFileString(userConfigPath)
          config = yield* Schema.decodeUnknown(UserConfigJson)(content)
        }

        // Load project config (overrides user)
        const projectExists = yield* fs.exists(projectConfigPath)
        if (projectExists) {
          const content = yield* fs.readFileString(projectConfigPath)
          const projectConfig = yield* Schema.decodeUnknown(UserConfigJson)(content)
          config = new UserConfig({
            model: projectConfig.model ?? config.model,
            provider: projectConfig.provider ?? config.provider,
          })
        }

        return config
      }).pipe(
        Effect.flatMap((config) => Ref.set(configRef, config)),
        Effect.catchAll((e) =>
          Effect.logWarning("Config load failed").pipe(Effect.annotateLogs({ error: String(e) })),
        ),
      )

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
        get: () => Ref.get(configRef),

        set: (partial) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(configRef)
            const updated = new UserConfig({
              model: partial.model ?? current.model,
              provider: partial.provider ?? current.provider,
            })
            yield* Ref.set(configRef, updated)
            yield* saveUserConfig(updated)
          }),

        getModel: () => Ref.get(configRef).pipe(Effect.map((c) => c.model)),

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
      }

      return service
    }),
  )

  static Test = (initialConfig: UserConfig = new UserConfig({})): Layer.Layer<ConfigService> => {
    const configRef = Ref.unsafeMake(initialConfig)

    return Layer.succeed(ConfigService, {
      get: () => Ref.get(configRef),
      set: (partial) =>
        Ref.update(
          configRef,
          (current) =>
            new UserConfig({
              model: partial.model ?? current.model,
              provider: partial.provider ?? current.provider,
            }),
        ),
      getModel: () => Ref.get(configRef).pipe(Effect.map((c) => c.model)),
      setModel: (modelId) => {
        const parts = (modelId as string).split("/")
        const providerId = parts[0] as ProviderId | undefined
        return Ref.update(configRef, () => new UserConfig({ model: modelId, provider: providerId }))
      },
    })
  }
}
