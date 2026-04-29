import { describe, test, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { describe as effectDescribe, it } from "effect-bun-test"
import { BunFileSystem } from "@effect/platform-bun"
import { resolveEditor, parseEditorCommand } from "../src/utils/external-editor"

// ── Editor resolution ─────────────────────────────────────────────────

describe("resolveEditor", () => {
  test("prefers $VISUAL", () => {
    expect(resolveEditor("code", "vim")).toBe("code")
  })

  test("falls back to $EDITOR", () => {
    expect(resolveEditor(undefined, "nano")).toBe("nano")
  })

  test("falls back to vi", () => {
    expect(resolveEditor(undefined, undefined)).toBe("vi")
  })

  test("$VISUAL empty string falls through", () => {
    expect(resolveEditor("", "vim")).toBe("vim")
  })
})

// ── Editor command parsing ────────────────────────────────────────────

describe("parseEditorCommand", () => {
  test("single command", () => {
    expect(parseEditorCommand("vim")).toEqual(["vim"])
  })

  test("command with args", () => {
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"])
  })

  test("command with multiple args", () => {
    expect(parseEditorCommand("emacsclient -c -a emacs")).toEqual([
      "emacsclient",
      "-c",
      "-a",
      "emacs",
    ])
  })

  test("extra whitespace trimmed", () => {
    expect(parseEditorCommand("  nvim  -f  ")).toEqual(["nvim", "-f"])
  })

  test("empty string falls back to vi", () => {
    expect(parseEditorCommand("")).toEqual(["vi"])
  })
})

// ── Content roundtrip ────────────────────────────────────────────────

effectDescribe("content roundtrip", () => {
  const roundtripTest = it.scopedLive.layer(BunFileSystem.layer)
  const makeFile = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped()
    return `${dir}/editor.md`
  })

  roundtripTest("write and read back preserves content", () =>
    Effect.gen(function* () {
      const content = "line 1\nline 2\nline 3\n"
      const tmpPath = yield* makeFile
      yield* Effect.promise(() => Bun.write(tmpPath, content))
      const readBack = yield* Effect.promise(() => Bun.file(tmpPath).text())
      expect(readBack).toBe(content)
    }),
  )

  roundtripTest("empty content roundtrips", () =>
    Effect.gen(function* () {
      const tmpPath = yield* makeFile
      yield* Effect.promise(() => Bun.write(tmpPath, ""))
      const readBack = yield* Effect.promise(() => Bun.file(tmpPath).text())
      expect(readBack).toBe("")
    }),
  )

  roundtripTest("multiline with special characters roundtrips", () =>
    Effect.gen(function* () {
      const content = "function foo() {\n  return `hello ${'world'}`\n}\n"
      const tmpPath = yield* makeFile
      yield* Effect.promise(() => Bun.write(tmpPath, content))
      const readBack = yield* Effect.promise(() => Bun.file(tmpPath).text())
      expect(readBack).toBe(content)
    }),
  )
})
