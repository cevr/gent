import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import { PermissionRule } from "@gent/core"

// User config schema - stored at ~/.gent/config.json

export class UserConfig extends Schema.Class<UserConfig>("UserConfig")({
  permissions: Schema.optional(Schema.Array(PermissionRule)),
}) {}

// ConfigService

export interface ConfigServiceService {
  readonly get: () => Effect.Effect<UserConfig>
  readonly set: (config: Partial<UserConfig>) => Effect.Effect<void>
  readonly getPermissionRules: () => Effect.Effect<ReadonlyArray<PermissionRule>>
  readonly addPermissionRule: (rule: PermissionRule) => Effect.Effect<void>
  readonly removePermissionRule: (tool: string, pattern?: string) => Effect.Effect<void>
  readonly loadInstructions: (cwd: string) => Effect.Effect<string>
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
        const permissions = [...(project.permissions ?? []), ...(user.permissions ?? [])]
        return new UserConfig({ permissions: permissions.length > 0 ? permissions : undefined })
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
              permissions: partial.permissions ?? current.permissions,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
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
              permissions: permissions.length > 0 ? permissions : undefined,
            })
            yield* Ref.set(userConfigRef, updated)
            yield* saveUserConfig(updated)
          }),

        loadInstructions: (cwd) =>
          Effect.gen(function* () {
            const readIfExists = (filePath: string): Effect.Effect<string> =>
              fs.exists(filePath).pipe(
                Effect.flatMap((exists) =>
                  exists ? fs.readFileString(filePath) : Effect.succeed(""),
                ),
                Effect.map((content) => content.trim()),
                Effect.catchAll(() => Effect.succeed("")),
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
    const userConfigRef = Ref.unsafeMake(initialConfig)
    const projectConfigRef = Ref.unsafeMake(new UserConfig({}))

    const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig => {
      const permissions = [...(project.permissions ?? []), ...(user.permissions ?? [])]
      return new UserConfig({ permissions: permissions.length > 0 ? permissions : undefined })
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
              permissions: partial.permissions ?? current.permissions,
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
          })
        }).pipe(Effect.asVoid),
      removePermissionRule: (tool, pattern) =>
        Ref.update(userConfigRef, (current) => {
          const permissions = (current.permissions ?? []).filter(
            (r) => !(r.tool === tool && r.pattern === pattern),
          )
          return new UserConfig({
            permissions: permissions.length > 0 ? permissions : undefined,
          })
        }).pipe(Effect.asVoid),
      loadInstructions: () => Effect.succeed(""),
    })
  }
}
