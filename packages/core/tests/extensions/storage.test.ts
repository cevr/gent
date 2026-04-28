import { describe, test, expect, it } from "effect-bun-test"
import { beforeEach, afterEach } from "bun:test"
import { Effect, FileSystem, Path, Exit } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../../src/runtime/extensions/extension-storage"
import { ExtensionId } from "@gent/core/domain/ids"
const baseDir = join(tmpdir(), `gent-storage-test-${Date.now()}`)
const { testFs, testPath, runWithPlatform } = Effect.runSync(
  Effect.gen(function* () {
    const testFs = yield* FileSystem.FileSystem
    const testPath = yield* Path.Path
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const runWithPlatform = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.provide(effect, services))
    return { testFs, testPath, runWithPlatform }
  }).pipe(Effect.provide(BunServices.layer)),
)
const makeStorage = (id: string, dir = baseDir): ExtensionStorage =>
  createExtensionStorage(ExtensionId.make(id), dir, testFs, testPath)
beforeEach(() => {
  mkdirSync(baseDir, { recursive: true })
})
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})
describe("ExtensionStorage", () => {
  it.live("written value reads back unchanged", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      yield* Effect.promise(() => runWithPlatform(storage.set("key1", { hello: "world" })))
      const value = yield* Effect.promise(() => runWithPlatform(storage.get("key1")))
      expect(value).toEqual({ hello: "world" })
    }),
  )
  it.live("missing key reads back undefined", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      const value = yield* Effect.promise(() => runWithPlatform(storage.get("missing")))
      expect(value).toBeUndefined()
    }),
  )
  it.live("deleted key disappears from subsequent reads", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      yield* Effect.promise(() => runWithPlatform(storage.set("key1", "value")))
      yield* Effect.promise(() => runWithPlatform(storage.delete("key1")))
      const value = yield* Effect.promise(() => runWithPlatform(storage.get("key1")))
      expect(value).toBeUndefined()
    }),
  )
  it.live("deleting a missing key is a no-op", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      yield* Effect.promise(() => runWithPlatform(storage.delete("nonexistent")))
      // Should not throw
    }),
  )
  it.live("listing yields every set key", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      yield* Effect.promise(() => runWithPlatform(storage.set("alpha", 1)))
      yield* Effect.promise(() => runWithPlatform(storage.set("beta", 2)))
      yield* Effect.promise(() => runWithPlatform(storage.set("gamma", 3)))
      const keys = yield* Effect.promise(() => runWithPlatform(storage.list()))
      expect(keys.sort()).toEqual(["alpha", "beta", "gamma"])
    }),
  )
  it.live("empty namespace lists no keys", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      const keys = yield* Effect.promise(() => runWithPlatform(storage.list()))
      expect(keys).toEqual([])
    }),
  )
  it.live("storage is namespaced per extension", () =>
    Effect.gen(function* () {
      const storageA = makeStorage("ext-a")
      const storageB = makeStorage("ext-b")
      yield* Effect.promise(() => runWithPlatform(storageA.set("shared-key", "from-a")))
      yield* Effect.promise(() => runWithPlatform(storageB.set("shared-key", "from-b")))
      expect(yield* Effect.promise(() => runWithPlatform(storageA.get("shared-key")))).toBe(
        "from-a",
      )
      expect(yield* Effect.promise(() => runWithPlatform(storageB.get("shared-key")))).toBe(
        "from-b",
      )
    }),
  )
  it.live("scoped extension IDs work", () =>
    Effect.gen(function* () {
      const storage = makeStorage("@gent/memory")
      yield* Effect.promise(() => runWithPlatform(storage.set("test", { ok: true })))
      expect(yield* Effect.promise(() => runWithPlatform(storage.get("test")))).toEqual({
        ok: true,
      })
      // Verify file location
      expect(existsSync(join(baseDir, "@gent/memory", "storage", "test.json"))).toBe(true)
    }),
  )
})
describe("ExtensionStorage key validation", () => {
  it.live("rejects keys with path separators", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      const exit1 = yield* Effect.exit(storage.get("../escape").pipe(Effect.scoped))
      expect(Exit.isFailure(exit1)).toBe(true)
      const exit2 = yield* Effect.exit(storage.set("path/to/key", "x").pipe(Effect.scoped))
      expect(Exit.isFailure(exit2)).toBe(true)
    }),
  )
  it.live("rejects keys with dots", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      const exit = yield* Effect.exit(storage.get("file.json").pipe(Effect.scoped))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  it.live("accepts valid keys", () =>
    Effect.gen(function* () {
      const storage = makeStorage("test-ext")
      yield* Effect.promise(() => runWithPlatform(storage.set("valid-key_123", "ok")))
      expect(yield* Effect.promise(() => runWithPlatform(storage.get("valid-key_123")))).toBe("ok")
    }),
  )
})
describe("ExtensionStorage ID validation", () => {
  test("rejects path traversal in extension ID", () => {
    expect(() => makeStorage("../other-ext")).toThrow("Invalid extension ID")
  })
  test("rejects absolute-ish paths", () => {
    expect(() => makeStorage("/etc/passwd")).toThrow("Invalid extension ID")
  })
  test("accepts normal IDs", () => {
    expect(() => makeStorage("my-extension")).not.toThrow()
    expect(() => makeStorage("@scope/name")).not.toThrow()
    expect(() => makeStorage("simple")).not.toThrow()
  })
})
