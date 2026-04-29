import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Path, Exit } from "effect"
import { BunServices } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../../src/runtime/extensions/extension-storage"
import { ExtensionId } from "@gent/core/domain/ids"
import { makeScopedTempDir } from "./helpers/scoped-temp-dir"

const makeStorage = (
  id: string,
  dir: string,
): Effect.Effect<ExtensionStorage, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return createExtensionStorage(ExtensionId.make(id), dir, fs, path)
  })

const storageTest = it.scopedLive.layer(BunServices.layer)

describe("ExtensionStorage", () => {
  storageTest("written value reads back unchanged", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      yield* storage.set("key1", { hello: "world" })
      const value = yield* storage.get("key1")
      expect(value).toEqual({ hello: "world" })
    }),
  )
  storageTest("missing key reads back undefined", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      const value = yield* storage.get("missing")
      expect(value).toBeUndefined()
    }),
  )
  storageTest("deleted key disappears from subsequent reads", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      yield* storage.set("key1", "value")
      yield* storage.delete("key1")
      const value = yield* storage.get("key1")
      expect(value).toBeUndefined()
    }),
  )
  storageTest("deleting a missing key is a no-op", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      yield* storage.delete("nonexistent")
      // Should not throw
    }),
  )
  storageTest("listing yields every set key", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      yield* storage.set("alpha", 1)
      yield* storage.set("beta", 2)
      yield* storage.set("gamma", 3)
      const keys = yield* storage.list()
      expect(keys.sort()).toEqual(["alpha", "beta", "gamma"])
    }),
  )
  storageTest("empty namespace lists no keys", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      const keys = yield* storage.list()
      expect(keys).toEqual([])
    }),
  )
  storageTest("storage is namespaced per extension", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storageA = yield* makeStorage("ext-a", baseDir)
      const storageB = yield* makeStorage("ext-b", baseDir)
      yield* storageA.set("shared-key", "from-a")
      yield* storageB.set("shared-key", "from-b")
      expect(yield* storageA.get("shared-key")).toBe("from-a")
      expect(yield* storageB.get("shared-key")).toBe("from-b")
    }),
  )
  storageTest("scoped extension IDs work", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("@gent/memory", baseDir)
      yield* storage.set("test", { ok: true })
      expect(yield* storage.get("test")).toEqual({
        ok: true,
      })
      // Verify file location
      expect(existsSync(join(baseDir, "@gent/memory", "storage", "test.json"))).toBe(true)
    }),
  )
})
describe("ExtensionStorage key validation", () => {
  storageTest("rejects keys with path separators", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      const exit1 = yield* Effect.exit(storage.get("../escape").pipe(Effect.scoped))
      expect(Exit.isFailure(exit1)).toBe(true)
      const exit2 = yield* Effect.exit(storage.set("path/to/key", "x").pipe(Effect.scoped))
      expect(Exit.isFailure(exit2)).toBe(true)
    }),
  )
  storageTest("rejects keys with dots", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      const exit = yield* Effect.exit(storage.get("file.json").pipe(Effect.scoped))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  storageTest("accepts valid keys", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeScopedTempDir
      const storage = yield* makeStorage("test-ext", baseDir)
      yield* storage.set("valid-key_123", "ok")
      expect(yield* storage.get("valid-key_123")).toBe("ok")
    }),
  )
})
describe("ExtensionStorage ID validation", () => {
  storageTest("rejects path traversal in extension ID", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(makeStorage("../other-ext", "/tmp"))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  storageTest("rejects absolute-ish paths", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(makeStorage("/etc/passwd", "/tmp"))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  storageTest("accepts normal IDs", () =>
    Effect.gen(function* () {
      yield* makeStorage("my-extension", "/tmp")
      yield* makeStorage("@scope/name", "/tmp")
      yield* makeStorage("simple", "/tmp")
    }),
  )
})
