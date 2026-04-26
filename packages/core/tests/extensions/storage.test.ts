import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect, FileSystem, Path, Exit } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createExtensionStorage,
  type ExtensionStorage,
} from "../../src/runtime/extensions/extension-storage"

const baseDir = join(tmpdir(), `gent-storage-test-${Date.now()}`)

const { testFs, testPath, runWithPlatform } = await Effect.runPromise(
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
  createExtensionStorage(id, dir, testFs, testPath)

beforeEach(() => {
  mkdirSync(baseDir, { recursive: true })
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe("ExtensionStorage", () => {
  test("written value reads back unchanged", async () => {
    const storage = makeStorage("test-ext")
    await runWithPlatform(storage.set("key1", { hello: "world" }))
    const value = await runWithPlatform(storage.get("key1"))
    expect(value).toEqual({ hello: "world" })
  })

  test("missing key reads back undefined", async () => {
    const storage = makeStorage("test-ext")
    const value = await runWithPlatform(storage.get("missing"))
    expect(value).toBeUndefined()
  })

  test("deleted key disappears from subsequent reads", async () => {
    const storage = makeStorage("test-ext")
    await runWithPlatform(storage.set("key1", "value"))
    await runWithPlatform(storage.delete("key1"))
    const value = await runWithPlatform(storage.get("key1"))
    expect(value).toBeUndefined()
  })

  test("deleting a missing key is a no-op", async () => {
    const storage = makeStorage("test-ext")
    await runWithPlatform(storage.delete("nonexistent"))
    // Should not throw
  })

  test("listing yields every set key", async () => {
    const storage = makeStorage("test-ext")
    await runWithPlatform(storage.set("alpha", 1))
    await runWithPlatform(storage.set("beta", 2))
    await runWithPlatform(storage.set("gamma", 3))
    const keys = await runWithPlatform(storage.list())
    expect(keys.sort()).toEqual(["alpha", "beta", "gamma"])
  })

  test("empty namespace lists no keys", async () => {
    const storage = makeStorage("test-ext")
    const keys = await runWithPlatform(storage.list())
    expect(keys).toEqual([])
  })

  test("storage is namespaced per extension", async () => {
    const storageA = makeStorage("ext-a")
    const storageB = makeStorage("ext-b")

    await runWithPlatform(storageA.set("shared-key", "from-a"))
    await runWithPlatform(storageB.set("shared-key", "from-b"))

    expect(await runWithPlatform(storageA.get("shared-key"))).toBe("from-a")
    expect(await runWithPlatform(storageB.get("shared-key"))).toBe("from-b")
  })

  test("scoped extension IDs work", async () => {
    const storage = makeStorage("@gent/memory")
    await runWithPlatform(storage.set("test", { ok: true }))
    expect(await runWithPlatform(storage.get("test"))).toEqual({ ok: true })
    // Verify file location
    expect(existsSync(join(baseDir, "@gent/memory", "storage", "test.json"))).toBe(true)
  })
})

describe("ExtensionStorage key validation", () => {
  test("rejects keys with path separators", async () => {
    const storage = makeStorage("test-ext")
    const exit1 = await Effect.runPromiseExit(storage.get("../escape").pipe(Effect.scoped))
    expect(Exit.isFailure(exit1)).toBe(true)
    const exit2 = await Effect.runPromiseExit(storage.set("path/to/key", "x").pipe(Effect.scoped))
    expect(Exit.isFailure(exit2)).toBe(true)
  })

  test("rejects keys with dots", async () => {
    const storage = makeStorage("test-ext")
    const exit = await Effect.runPromiseExit(storage.get("file.json").pipe(Effect.scoped))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("accepts valid keys", async () => {
    const storage = makeStorage("test-ext")
    await runWithPlatform(storage.set("valid-key_123", "ok"))
    expect(await runWithPlatform(storage.get("valid-key_123"))).toBe("ok")
  })
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
