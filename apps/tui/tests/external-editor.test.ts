import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlink } from "node:fs/promises"
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

describe("content roundtrip", () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = join(tmpdir(), `gent-test-${Date.now()}.md`)
  })

  afterEach(() => unlink(tmpPath).catch(() => undefined))

  test("write and read back preserves content", () => {
    const content = "line 1\nline 2\nline 3\n"
    return Bun.write(tmpPath, content)
      .then(() => Bun.file(tmpPath).text())
      .then((readBack) => {
        expect(readBack).toBe(content)
      })
  })

  test("empty content roundtrips", () =>
    Bun.write(tmpPath, "")
      .then(() => Bun.file(tmpPath).text())
      .then((readBack) => {
        expect(readBack).toBe("")
      }))

  test("multiline with special characters roundtrips", () => {
    const content = "function foo() {\n  return `hello ${'world'}`\n}\n"
    return Bun.write(tmpPath, content)
      .then(() => Bun.file(tmpPath).text())
      .then((readBack) => {
        expect(readBack).toBe(content)
      })
  })
})
