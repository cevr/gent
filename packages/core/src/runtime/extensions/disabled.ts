/**
 * Shared disabled-extension config reader.
 * Effect-based — requires FileSystem and Path from the platform.
 * Read by the runtime profile loader (`runtime/profile.ts`) and by the TUI's
 * extension context boundary (`apps/tui/src/services/extension-context-boundary.ts`).
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect"

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
    const userConfigPath = path.join(params.home, ".gent", "config.json")
    const projectConfigPath = path.join(params.cwd, ".gent", "config.json")
    const userDisabled = yield* readDisabledFromFile(userConfigPath)
    const projectDisabled = yield* readDisabledFromFile(projectConfigPath)
    return new Set([...(params.extra ?? []), ...userDisabled, ...projectDisabled])
  })
