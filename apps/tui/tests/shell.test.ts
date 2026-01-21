import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { executeShell } from "../src/utils/shell"
import { Effect, Layer } from "effect"
import { BunContext, BunFileSystem } from "@effect/platform-bun"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

describe("executeShell", () => {
  let testDir: string
  const platformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)
  const run = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>) =>
    Effect.runPromise(effect.pipe(Effect.provide(platformLayer)))

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "shell-test-"))
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test("executes simple command", async () => {
    const result = await run(executeShell("echo hello", testDir))
    expect(result.output).toBe("hello")
    expect(result.truncated).toBe(false)
    expect(result.savedPath).toBeUndefined()
  })

  test("captures stderr", async () => {
    const result = await run(executeShell("echo error >&2", testDir))
    expect(result.output).toContain("error")
    expect(result.truncated).toBe(false)
  })

  test("respects cwd", async () => {
    const result = await run(executeShell("pwd", testDir))
    // macOS may resolve /var to /private/var
    expect(result.output.endsWith(testDir.split("/").pop()!)).toBe(true)
    expect(result.truncated).toBe(false)
  })

  test("handles multi-line output", async () => {
    const result = await run(executeShell("echo -e 'line1\\nline2\\nline3'", testDir))
    expect(result.output).toContain("line1")
    expect(result.output).toContain("line2")
    expect(result.output).toContain("line3")
    expect(result.truncated).toBe(false)
  })

  test("handles empty output", async () => {
    const result = await run(executeShell("true", testDir))
    expect(result.output).toBe("")
    expect(result.truncated).toBe(false)
  })

  test("handles command with arguments", async () => {
    const result = await run(executeShell("echo -n test", testDir))
    expect(result.output).toBe("test")
  })

  test("handles pipes", async () => {
    const result = await run(executeShell("echo hello | tr 'h' 'H'", testDir))
    expect(result.output).toBe("Hello")
  })

  test("handles file operations", async () => {
    const testFile = join(testDir, "test.txt")
    await writeFile(testFile, "file content")

    const result = await run(executeShell(`cat ${testFile}`, testDir))
    expect(result.output).toBe("file content")
  })

  test("truncates output over line limit", async () => {
    // Generate output with more than 2000 lines
    const result = await run(executeShell("seq 1 2500", testDir))

    expect(result.truncated).toBe(true)
    expect(result.savedPath).toBeDefined()

    // Output should be truncated to ~2000 lines
    const lineCount = result.output.split("\n").length
    expect(lineCount).toBeLessThanOrEqual(2001)
  })

  test("truncates output over byte limit", async () => {
    // Generate output over 50KB (each 'x' repeated 100 times per line, 600 lines = 60KB)
    const result = await run(executeShell(
      "for i in $(seq 1 600); do printf '%0.s█' {1..100}; echo; done",
      testDir,
    ))

    expect(result.truncated).toBe(true)
    expect(result.savedPath).toBeDefined()

    // Output should be under 50KB
    expect(result.output.length).toBeLessThanOrEqual(50 * 1024)
  })
})
