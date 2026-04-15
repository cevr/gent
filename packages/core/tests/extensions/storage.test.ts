import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createExtensionStorage } from "@gent/core/runtime/extensions/extension-storage"

const baseDir = join(tmpdir(), `gent-storage-test-${Date.now()}`)

const { testFs, testPath, testRun } = await Effect.runPromise(
  Effect.gen(function* () {
    const testFs = yield* FileSystem.FileSystem
    const testPath = yield* Path.Path
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const testRun = <A>(effect: Effect.Effect<A>) =>
      Effect.runPromise(Effect.provide(effect, services))
    return { testFs, testPath, testRun }
  }).pipe(Effect.provide(BunServices.layer)),
)

const makeStorage = (id: string, dir = baseDir) =>
  createExtensionStorage(id, dir, testFs, testPath, testRun)

beforeEach(() => {
  mkdirSync(baseDir, { recursive: true })
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe("ExtensionStorage", () => {
  test("set and get a value", async () => {
    const storage = makeStorage("test-ext")
    await storage.set("key1", { hello: "world" })
    const value = await storage.get("key1")
    expect(value).toEqual({ hello: "world" })
  })

  test("get returns undefined for missing key", async () => {
    const storage = makeStorage("test-ext")
    const value = await storage.get("missing")
    expect(value).toBeUndefined()
  })

  test("delete removes a key", async () => {
    const storage = makeStorage("test-ext")
    await storage.set("key1", "value")
    await storage.delete("key1")
    const value = await storage.get("key1")
    expect(value).toBeUndefined()
  })

  test("delete is idempotent for missing key", async () => {
    const storage = makeStorage("test-ext")
    await storage.delete("nonexistent")
    // Should not throw
  })

  test("list returns all keys", async () => {
    const storage = makeStorage("test-ext")
    await storage.set("alpha", 1)
    await storage.set("beta", 2)
    await storage.set("gamma", 3)
    const keys = await storage.list()
    expect(keys.sort()).toEqual(["alpha", "beta", "gamma"])
  })

  test("list returns empty for no keys", async () => {
    const storage = makeStorage("test-ext")
    const keys = await storage.list()
    expect(keys).toEqual([])
  })

  test("storage is namespaced per extension", async () => {
    const storageA = makeStorage("ext-a")
    const storageB = makeStorage("ext-b")

    await storageA.set("shared-key", "from-a")
    await storageB.set("shared-key", "from-b")

    expect(await storageA.get("shared-key")).toBe("from-a")
    expect(await storageB.get("shared-key")).toBe("from-b")
  })

  test("scoped extension IDs work", async () => {
    const storage = makeStorage("@gent/memory")
    await storage.set("test", { ok: true })
    expect(await storage.get("test")).toEqual({ ok: true })
    // Verify file location
    expect(existsSync(join(baseDir, "@gent/memory", "storage", "test.json"))).toBe(true)
  })
})

describe("ExtensionStorage key validation", () => {
  test("rejects keys with path separators", async () => {
    const storage = makeStorage("test-ext")
    expect(() => storage.get("../escape")).toThrow("Invalid storage key")
    expect(() => storage.set("path/to/key", "x")).toThrow("Invalid storage key")
  })

  test("rejects keys with dots", async () => {
    const storage = makeStorage("test-ext")
    expect(() => storage.get("file.json")).toThrow("Invalid storage key")
  })

  test("accepts valid keys", async () => {
    const storage = makeStorage("test-ext")
    await storage.set("valid-key_123", "ok")
    expect(await storage.get("valid-key_123")).toBe("ok")
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
