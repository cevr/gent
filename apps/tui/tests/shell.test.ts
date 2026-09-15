import { describe, expect, it } from "effect-bun-test"
import { executeShell, shellOutputDirectory } from "../src/utils/shell"
import { Effect, FileSystem, Layer, Option } from "effect"
import { BunServices, BunFileSystem } from "@effect/platform-bun"

const testLayer = Layer.merge(BunFileSystem.layer, BunServices.layer)
const shellTest = it.scopedLive.layer(testLayer)

describe("executeShell", () => {
  shellTest("executes simple command", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo hello", testDir)
      expect(result.output).toBe("hello")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("captures stderr", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo error >&2", testDir)
      expect(result.output).toContain("error")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("respects cwd", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("pwd", testDir)
      // macOS may resolve /var to /private/var
      expect(result.output.endsWith(testDir.split("/").pop()!)).toBe(true)
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles multi-line output", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo -e 'line1\\nline2\\nline3'", testDir)
      expect(result.output).toContain("line1")
      expect(result.output).toContain("line2")
      expect(result.output).toContain("line3")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles empty output", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("true", testDir)
      expect(result.output).toBe("")
      expect(result.truncated).toBe(false)
    }),
  )

  shellTest("handles command with arguments", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo -n test", testDir)
      expect(result.output).toBe("test")
    }),
  )

  shellTest("handles pipes", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo hello | tr 'h' 'H'", testDir)
      expect(result.output).toBe("Hello")
    }),
  )

  shellTest("handles file operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const testFile = `${testDir}/test.txt`
      yield* fs.writeFileString(testFile, "file content")
      const result = yield* executeShell(`cat ${testFile}`, testDir)
      expect(result.output).toBe("file content")
    }),
  )

  shellTest("truncates output over line limit", () =>
    // Generate output with more than 2000 lines
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("seq 1 2500", testDir)
      expect(result.truncated).toBe(true)

      // Output should be truncated to ~2000 lines
      const lineCount = result.output.split("\n").length
      expect(lineCount).toBeLessThanOrEqual(2001)
    }),
  )

  shellTest("truncates output over byte limit", () =>
    // Generate output over 50KB (each 'x' repeated 100 times per line, 600 lines = 60KB)
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell(
        "for i in $(seq 1 600); do printf '%0.s█' {1..100}; echo; done",
        testDir,
      )
      expect(result.truncated).toBe(true)

      // Output should be under 50KB
      expect(result.output.length).toBeLessThanOrEqual(50 * 1024)
    }),
  )

  shellTest("a command inside the cap spills nothing", () =>
    Effect.gen(function* () {
      const testDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const result = yield* executeShell("echo small", testDir)
      expect(result.truncated).toBe(false)
      expect(Option.isNone(result.savedPath)).toBe(true)
    }),
  )

  shellTest("truncated output is written whole under the gent data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const testDir = yield* fs.makeTempDirectoryScoped()
      const lineCount = 2500
      const result = yield* executeShell(`seq 1 ${lineCount} | sed 's/^/line /'`, testDir)
      expect(result.truncated).toBe(true)

      // The reader is handed a path, not just a stump of the output.
      const savedPath = yield* Effect.fromOption(result.savedPath)
      // The spill lives under the gent data directory, not under /tmp/gent.
      expect(savedPath.startsWith(shellOutputDirectory())).toBe(true)
      expect(savedPath).not.toContain("/tmp/gent")

      const saved = yield* fs.readFileString(savedPath)
      // The whole output survives: the head the cap kept and the tail it cut.
      expect(saved).toContain("line 1\n")
      expect(saved).toContain(`line ${lineCount}`)
      expect(result.output).not.toContain(`line ${lineCount}`)
      // The header names the command that produced it.
      expect(saved).toContain(`# Command: seq 1 ${lineCount}`)

      yield* fs.remove(savedPath)
    }),
  )
})
