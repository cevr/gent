/**
 * Simple file-backed key-value storage for extensions.
 *
 * Namespaced by extension ID. JSON files at ~/.gent/extensions/<id>/storage/<key>.json.
 * No schema validation — JSON in, JSON out. For extensions that need
 * durable state without the full actor/fromReducer machinery.
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path"

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
 * @param extensionId - The extension's manifest ID
 * @param baseDir - The base directory for extension storage (e.g. ~/.gent/extensions)
 */
export const createExtensionStorage = (extensionId: string, baseDir: string): ExtensionStorage => {
  validateExtensionId(extensionId)
  const dir = join(baseDir, extensionId, "storage")

  const ensureDir = () => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  const keyPath = (key: string) => join(dir, `${key}.json`)

  return {
    get: async (key) => {
      validateKey(key)
      const path = keyPath(key)
      try {
        const data = readFileSync(path, "utf-8")
        return JSON.parse(data)
      } catch {
        return undefined
      }
    },

    set: async (key, value) => {
      validateKey(key)
      ensureDir()
      writeFileSync(keyPath(key), JSON.stringify(value, null, 2), "utf-8")
    },

    delete: async (key) => {
      validateKey(key)
      try {
        unlinkSync(keyPath(key))
      } catch {
        // Key doesn't exist — idempotent
      }
    },

    list: async () => {
      try {
        const files = readdirSync(dir)
        return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
      } catch {
        return []
      }
    },
  }
}
