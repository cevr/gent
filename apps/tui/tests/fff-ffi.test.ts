import { describe, test, expect, afterAll } from "bun:test"
import * as FFF from "../src/utils/fff-ffi"

describe("fff-ffi bun:ffi binding", () => {
  const available = FFF.isAvailable()

  // Skip all tests if native library isn't available (CI on unsupported platform)
  const it = available ? test : test.skip

  let handle: FFF.NativeHandle | undefined

  afterAll(() => {
    if (handle !== undefined) FFF.destroy(handle)
  })

  it("isAvailable returns true on supported platforms", () => {
    expect(available).toBe(true)
  })

  it("creates a finder instance", () => {
    const result = FFF.create({ basePath: process.cwd() })
    expect(result.ok).toBe(true)
    if (result.ok) handle = result.value
  })

  it("waits for scan to complete", () => {
    expect(handle).toBeDefined()
    const result = FFF.waitForScan(handle!, 15_000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(true)
  })

  it("is no longer scanning after waitForScan", () => {
    expect(handle).toBeDefined()
    expect(FFF.isScanning(handle!)).toBe(false)
  })

  it("searches for files by name", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "package.json", { pageSize: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.totalMatched).toBeGreaterThan(0)
    expect(result.value.totalFiles).toBeGreaterThan(0)
    expect(result.value.items.length).toBeGreaterThan(0)
    expect(result.value.scores.length).toBe(result.value.items.length)

    const first = result.value.items[0]!
    expect(first.relativePath).toContain("package.json")
    expect(first.fileName).toBe("package.json")
    expect(first.path.length).toBeGreaterThan(0)
  })

  it("returns file items with expected fields", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "tsconfig", { pageSize: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const item = result.value.items[0]!
    expect(typeof item.path).toBe("string")
    expect(typeof item.relativePath).toBe("string")
    expect(typeof item.fileName).toBe("string")
    expect(typeof item.gitStatus).toBe("string")
    expect(typeof item.size).toBe("number")
    expect(typeof item.modified).toBe("number")
  })

  it("returns scores with expected fields", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "tsconfig", { pageSize: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const score = result.value.scores[0]!
    expect(typeof score.total).toBe("number")
    expect(typeof score.baseScore).toBe("number")
    expect(typeof score.filenameBonus).toBe("number")
    expect(typeof score.exactMatch).toBe("boolean")
    expect(typeof score.matchType).toBe("string")
  })

  it("respects pageSize", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "ts", { pageSize: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.length).toBeLessThanOrEqual(3)
  })

  it("returns empty for no-match query", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "zzzznonexistent999", { pageSize: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.length).toBe(0)
    expect(result.value.totalMatched).toBe(0)
  })

  it("trackQuery succeeds", () => {
    expect(handle).toBeDefined()
    const result = FFF.trackQuery(handle!, "pkg", "package.json")
    expect(result.ok).toBe(true)
  })

  it("respects gitignore — node_modules excluded", () => {
    expect(handle).toBeDefined()
    const result = FFF.search(handle!, "effect", { pageSize: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const hasNodeModules = result.value.items.some((i) => i.relativePath.includes("node_modules"))
    expect(hasNodeModules).toBe(false)
  })
})
