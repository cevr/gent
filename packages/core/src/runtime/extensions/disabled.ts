/**
 * Shared disabled-extension config reader.
 * Effect-based — requires FileSystem and Path from the platform.
 * Used by both server (dependencies.ts) and TUI (context.tsx).
 */
import { Effect, FileSystem, Path, Schema } from "effect"

const DisabledConfig = Schema.Struct({
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
})

/** Read disabledExtensions from a JSON config file. Returns [] on any error. */
export const readDisabledFromFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(filePath)
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DisabledConfig))(text)
    return decoded.disabledExtensions ?? []
  }).pipe(Effect.catchEager(() => Effect.succeed([] as string[])))

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
    const userConfigPath = path.join(params.home, ".gent", "config.json")
    const projectConfigPath = path.join(params.cwd, ".gent", "config.json")
    const userDisabled = yield* readDisabledFromFile(userConfigPath)
    const projectDisabled = yield* readDisabledFromFile(projectConfigPath)
    return new Set([...(params.extra ?? []), ...userDisabled, ...projectDisabled])
  })

/** Scope precedence for extension resolution. Higher value = higher priority. */
export const SCOPE_PRECEDENCE = { builtin: 0, user: 1, project: 2 } as const
export type ExtensionScope = keyof typeof SCOPE_PRECEDENCE
