import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { ReadTool, GlobTool, GrepTool } from "@gent/tools"
import type { ToolContext } from "@gent/core"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

describe("Tools", () => {
  describe("ReadTool", () => {
    test("reads a file", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-test-"))
      const testFile = path.join(tmpDir, "test.txt")
      fs.writeFileSync(testFile, "Hello, World!")

      try {
        const result = await Effect.runPromise(
          ReadTool.execute({ path: testFile }, ctx)
        )
        expect(result.content).toBe("1\tHello, World!")
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test("returns error for non-existent file", async () => {
      const result = await Effect.runPromise(
        Effect.either(ReadTool.execute({ path: "/nonexistent/file.txt" }, ctx))
      )
      expect(result._tag).toBe("Left")
    })
  })

  describe("GlobTool", () => {
    test("finds files matching pattern", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-glob-"))
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "")
      fs.writeFileSync(path.join(tmpDir, "b.ts"), "")
      fs.writeFileSync(path.join(tmpDir, "c.js"), "")

      try {
        const result = await Effect.runPromise(
          GlobTool.execute({ pattern: "*.ts", path: tmpDir }, ctx)
        )
        expect(result.files.length).toBe(2)
        expect(result.files.every((f) => f.endsWith(".ts"))).toBe(true)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })

  describe("GrepTool", () => {
    test("finds pattern in files", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-grep-"))
      fs.writeFileSync(path.join(tmpDir, "file1.ts"), "const foo = 1")
      fs.writeFileSync(path.join(tmpDir, "file2.ts"), "const bar = 2")
      fs.writeFileSync(path.join(tmpDir, "file3.ts"), "const foo = 3")

      try {
        const result = await Effect.runPromise(
          GrepTool.execute({ pattern: "foo", path: tmpDir }, ctx)
        )
        expect(result.matches.length).toBe(2)
      } finally {
        fs.rmSync(tmpDir, { recursive: true })
      }
    })
  })
})
