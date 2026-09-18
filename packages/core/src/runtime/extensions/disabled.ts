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
import { Effect, FileSystem, Option, Path, Schema } from "effect"

/** The per-user and per-project directory holding gent's config file. */
export const GENT_CONFIG_DIRECTORY = ".gent"

/** The config file inside `GENT_CONFIG_DIRECTORY`. */
export const GENT_CONFIG_FILENAME = "config.json"

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
