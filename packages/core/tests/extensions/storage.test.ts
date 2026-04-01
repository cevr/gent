import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createExtensionStorage } from "@gent/core/runtime/extensions/extension-storage"

const baseDir = join(tmpdir(), `gent-storage-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(baseDir, { recursive: true })
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe("ExtensionStorage", () => {
  test("set and get a value", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    await storage.set("key1", { hello: "world" })
    const value = await storage.get("key1")
    expect(value).toEqual({ hello: "world" })
  })

  test("get returns undefined for missing key", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    const value = await storage.get("missing")
    expect(value).toBeUndefined()
  })

  test("delete removes a key", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    await storage.set("key1", "value")
    await storage.delete("key1")
    const value = await storage.get("key1")
    expect(value).toBeUndefined()
  })

  test("delete is idempotent for missing key", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    await storage.delete("nonexistent")
    // Should not throw
  })

  test("list returns all keys", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    await storage.set("alpha", 1)
    await storage.set("beta", 2)
    await storage.set("gamma", 3)
    const keys = await storage.list()
    expect(keys.sort()).toEqual(["alpha", "beta", "gamma"])
  })

  test("list returns empty for no keys", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    const keys = await storage.list()
    expect(keys).toEqual([])
  })

  test("storage is namespaced per extension", async () => {
    const storageA = createExtensionStorage("ext-a", baseDir)
    const storageB = createExtensionStorage("ext-b", baseDir)

    await storageA.set("shared-key", "from-a")
    await storageB.set("shared-key", "from-b")

    expect(await storageA.get("shared-key")).toBe("from-a")
    expect(await storageB.get("shared-key")).toBe("from-b")
  })

  test("scoped extension IDs work", async () => {
    const storage = createExtensionStorage("@gent/memory", baseDir)
    await storage.set("test", { ok: true })
    expect(await storage.get("test")).toEqual({ ok: true })
    // Verify file location
    expect(existsSync(join(baseDir, "@gent/memory", "storage", "test.json"))).toBe(true)
  })
})

describe("ExtensionStorage key validation", () => {
  test("rejects keys with path separators", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    expect(() => storage.get("../escape")).toThrow("Invalid storage key")
    expect(() => storage.set("path/to/key", "x")).toThrow("Invalid storage key")
  })

  test("rejects keys with dots", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    expect(() => storage.get("file.json")).toThrow("Invalid storage key")
  })

  test("accepts valid keys", async () => {
    const storage = createExtensionStorage("test-ext", baseDir)
    await storage.set("valid-key_123", "ok")
    expect(await storage.get("valid-key_123")).toBe("ok")
  })
})

describe("ExtensionStorage ID validation", () => {
  test("rejects path traversal in extension ID", () => {
    expect(() => createExtensionStorage("../other-ext", baseDir)).toThrow("Invalid extension ID")
  })

  test("rejects absolute-ish paths", () => {
    expect(() => createExtensionStorage("/etc/passwd", baseDir)).toThrow("Invalid extension ID")
  })

  test("accepts normal IDs", () => {
    expect(() => createExtensionStorage("my-extension", baseDir)).not.toThrow()
    expect(() => createExtensionStorage("@scope/name", baseDir)).not.toThrow()
    expect(() => createExtensionStorage("simple", baseDir)).not.toThrow()
  })
})
