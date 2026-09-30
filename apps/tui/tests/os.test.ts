import { describe, expect, test } from "effect-bun-test"
import { Option } from "effect"
import { parseEditorCommand, resolveEditor } from "../src/os"

// ── external editor ─────────────────────────────────────────────────────────

// ── Editor resolution ─────────────────────────────────────────────────

describe("resolveEditor", () => {
  test("prefers $VISUAL", () => {
    expect(resolveEditor(Option.some("code"), Option.some("vim"))).toBe("code")
  })

  test("falls back to $EDITOR", () => {
    expect(resolveEditor(Option.none(), Option.some("nano"))).toBe("nano")
  })

  test("falls back to vi", () => {
    expect(resolveEditor(Option.none(), Option.none())).toBe("vi")
  })

  test("$VISUAL empty string falls through", () => {
    expect(resolveEditor(Option.some(""), Option.some("vim"))).toBe("vim")
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
