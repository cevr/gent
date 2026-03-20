import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveEditor, makeTmpPath, parseEditorCommand } from "../src/utils/external-editor"

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

// ── Tmp file path generation ─────────────────────────────────────────

describe("makeTmpPath", () => {
  test("generates path in tmpdir with gent-edit prefix", () => {
    const path = makeTmpPath()
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(path).toContain("gent-edit-")
    expect(path.endsWith(".md")).toBe(true)
  })

  test("generates unique paths", () => {
    const a = makeTmpPath()
    const b = makeTmpPath()
    expect(a).not.toBe(b)
  })
})

// ── Content roundtrip ────────────────────────────────────────────────

describe("content roundtrip", () => {
  let tmpPath: string

  beforeEach(() => {
    tmpPath = join(tmpdir(), `gent-test-${Date.now()}.md`)
  })

  afterEach(async () => {
    try {
      const { unlink } = await import("node:fs/promises")
      await unlink(tmpPath)
    } catch {
      // Already cleaned up
    }
  })

  test("write and read back preserves content", async () => {
    const content = "line 1\nline 2\nline 3\n"
    await Bun.write(tmpPath, content)
    const readBack = await Bun.file(tmpPath).text()
    expect(readBack).toBe(content)
  })

  test("empty content roundtrips", async () => {
    await Bun.write(tmpPath, "")
    const readBack = await Bun.file(tmpPath).text()
    expect(readBack).toBe("")
  })

  test("multiline with special characters roundtrips", async () => {
    const content = "function foo() {\n  return `hello ${'world'}`\n}\n"
    await Bun.write(tmpPath, content)
    const readBack = await Bun.file(tmpPath).text()
    expect(readBack).toBe(content)
  })
})
