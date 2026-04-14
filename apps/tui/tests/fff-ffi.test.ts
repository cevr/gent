import { describe, test, expect, afterAll } from "bun:test"
import { FileFinder } from "@ff-labs/fff-bun"

describe("fff-bun native file finder", () => {
  const available = FileFinder.isAvailable()

  // Skip all tests if native library isn't available (CI on unsupported platform)
  const it = available ? test : test.skip

  let finder: FileFinder | undefined

  afterAll(() => {
    if (finder !== undefined) finder.destroy()
  })

  it("isAvailable returns true on supported platforms", () => {
    expect(available).toBe(true)
  })

  it("creates a finder instance", () => {
    const result = FileFinder.create({ basePath: process.cwd() })
    expect(result.ok).toBe(true)
    if (result.ok) finder = result.value
  })

  it("waits for scan to complete", () => {
    expect(finder).toBeDefined()
    const result = finder!.waitForScan(15_000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(true)
  })

  it("is no longer scanning after waitForScan", () => {
    expect(finder).toBeDefined()
    expect(finder!.isScanning()).toBe(false)
  })

  it("searches for files by name", () => {
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("package.json", { pageSize: 10 })
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
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("tsconfig", { pageSize: 5 })
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
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("tsconfig", { pageSize: 5 })
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
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("ts", { pageSize: 3 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.length).toBeLessThanOrEqual(3)
  })

  it("returns empty for no-match query", () => {
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("zzzznonexistent999", { pageSize: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items.length).toBe(0)
    expect(result.value.totalMatched).toBe(0)
  })

  it("trackQuery succeeds", () => {
    expect(finder).toBeDefined()
    const result = finder!.trackQuery("pkg", "package.json")
    expect(result.ok).toBe(true)
  })

  it("respects gitignore — node_modules excluded", () => {
    expect(finder).toBeDefined()
    const result = finder!.fileSearch("effect", { pageSize: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const hasNodeModules = result.value.items.some((i) => i.relativePath.includes("node_modules"))
    expect(hasNodeModules).toBe(false)
  })
})
