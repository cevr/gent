/**
 * Simple file-backed key-value storage for extensions.
 *
 * Namespaced by extension ID. JSON files at ~/.gent/extensions/<id>/storage/<key>.json.
 * No schema validation — JSON in, JSON out. For extensions that need
 * durable state without the full extension actor runtime.
 *
 * Effect-native interface: every method returns an Effect. ExtensionStorageError
 * is the boundary error. Validation failures (bad key/id) fail synchronously
 * inside the Effect via `Effect.die` (programmer errors, not recoverable).
 */

import { Effect, Schema, type FileSystem, type Path } from "effect"
import type { ExtensionId } from "../../domain/ids.js"

export class ExtensionStorageError extends Schema.TaggedErrorClass<ExtensionStorageError>()(
  "ExtensionStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface ExtensionStorage {
  get(key: string): Effect.Effect<unknown | undefined, ExtensionStorageError>
  set(key: string, value: unknown): Effect.Effect<void, ExtensionStorageError>
  delete(key: string): Effect.Effect<void, ExtensionStorageError>
  list(): Effect.Effect<string[], ExtensionStorageError>
}

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/
/** Extension IDs may contain @ and / for scoped packages (e.g. @gent/memory) */
const SAFE_ID_PATTERN = /^@?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/

const validateKey = (key: string): Effect.Effect<void, ExtensionStorageError> =>
  SAFE_KEY_PATTERN.test(key)
    ? Effect.void
    : Effect.fail(
        new ExtensionStorageError({
          message: `Invalid storage key "${key}". Keys must match /^[a-zA-Z0-9_-]+$/ (no path separators, dots, or special characters).`,
        }),
      )

const validateExtensionId = (id: string): void => {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid extension ID "${id}" for storage. IDs must match /^@?[a-zA-Z0-9_-]+(\\/[a-zA-Z0-9_-]+)*$/.`,
    )
  }
}

/**
 * Create a file-backed ExtensionStorage for an extension.
 *
 * Accepts captured FileSystem/Path instances. All methods return Effect.
 *
 * @param extensionId - The extension's manifest ID
 * @param baseDir - The base directory for extension storage (e.g. ~/.gent/extensions)
 * @param fs - Captured FileSystem service instance
 * @param path - Captured Path service instance
 */
export const createExtensionStorage = (
  extensionId: ExtensionId,
  baseDir: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): ExtensionStorage => {
  validateExtensionId(extensionId)
  const dir = path.join(baseDir, extensionId, "storage")

  const ensureDir = fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)

  const keyPath = (key: string) => path.join(dir, `${key}.json`)

  return {
    // @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off preferSchemaOverJson:off — parsing arbitrary extension JSON
    get: (key) =>
      validateKey(key).pipe(
        Effect.andThen(
          fs.readFileString(keyPath(key)).pipe(
            Effect.flatMap((data) =>
              Effect.try({
                try: () => JSON.parse(data) as unknown,
                catch: () => new Error("Invalid JSON"),
              }),
            ),
            Effect.orElseSucceed((): unknown => undefined),
          ),
        ),
      ),

    set: (key, value) =>
      validateKey(key).pipe(
        Effect.andThen(
          ensureDir.pipe(
            Effect.andThen(fs.writeFileString(keyPath(key), JSON.stringify(value, null, 2))),
            Effect.ignore,
          ),
        ),
      ),

    delete: (key) =>
      validateKey(key).pipe(Effect.andThen(fs.remove(keyPath(key)).pipe(Effect.ignore))),

    list: () =>
      fs.readDirectory(dir).pipe(
        Effect.map((files) => files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))),
        Effect.orElseSucceed((): string[] => []),
      ),
  }
}
