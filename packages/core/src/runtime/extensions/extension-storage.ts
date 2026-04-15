/**
 * Simple file-backed key-value storage for extensions.
 *
 * Namespaced by extension ID. JSON files at ~/.gent/extensions/<id>/storage/<key>.json.
 * No schema validation — JSON in, JSON out. For extensions that need
 * durable state without the full extension actor runtime.
 */

import { Effect, type FileSystem, type Path } from "effect"

export interface ExtensionStorage {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
}

const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/
/** Extension IDs may contain @ and / for scoped packages (e.g. @gent/memory) */
const SAFE_ID_PATTERN = /^@?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/

const validateKey = (key: string): void => {
  if (!SAFE_KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid storage key "${key}". Keys must match /^[a-zA-Z0-9_-]+$/ (no path separators, dots, or special characters).`,
    )
  }
}

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
 * Accepts captured FileSystem/Path instances + a runner to bridge Effect→Promise.
 * All methods are async — use the captured services for file I/O.
 *
 * @param extensionId - The extension's manifest ID
 * @param baseDir - The base directory for extension storage (e.g. ~/.gent/extensions)
 * @param fs - Captured FileSystem service instance
 * @param path - Captured Path service instance
 * @param run - Effect→Promise runner with captured services (e.g. Effect.runPromiseWith(services))
 */
export const createExtensionStorage = (
  extensionId: string,
  baseDir: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  run: <A>(effect: Effect.Effect<A>) => Promise<A>,
): ExtensionStorage => {
  validateExtensionId(extensionId)
  const dir = path.join(baseDir, extensionId, "storage")

  const ensureDir = fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)

  const keyPath = (key: string) => path.join(dir, `${key}.json`)

  return {
    // @effect-diagnostics globalErrorInEffectCatch:off globalErrorInEffectFailure:off preferSchemaOverJson:off — parsing arbitrary extension JSON, errors caught
    get: async (key) => {
      validateKey(key)
      return run(
        fs.readFileString(keyPath(key)).pipe(
          Effect.flatMap((data) =>
            Effect.try({
              try: () => JSON.parse(data),
              catch: () => new Error("Invalid JSON"),
            }),
          ),
          Effect.orElseSucceed((): unknown => undefined),
        ),
      )
    },

    set: async (key, value) => {
      validateKey(key)
      await run(
        ensureDir.pipe(
          Effect.andThen(fs.writeFileString(keyPath(key), JSON.stringify(value, null, 2))),
          Effect.ignore,
        ),
      )
    },

    delete: async (key) => {
      validateKey(key)
      await run(fs.remove(keyPath(key)).pipe(Effect.ignore))
    },

    list: async () =>
      run(
        fs.readDirectory(dir).pipe(
          Effect.map((files) =>
            files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)),
          ),
          Effect.orElseSucceed((): string[] => []),
        ),
      ),
  }
}
