import { describe, expect, test } from "effect-bun-test"
import { Option } from "effect"
import { parseEditorCommand, resolveEditor } from "../src/os"

// ── external editor ─────────────────────────────────────────────────────────

describe("external editor", () => {
  test("$VISUAL wins over $EDITOR", () => {
    expect(resolveEditor(Option.some("code"), Option.some("vim"))).toBe("code")
  })

  test("without $VISUAL, $EDITOR names the editor", () => {
    expect(resolveEditor(Option.none(), Option.some("nano"))).toBe("nano")
  })

  test("with neither set, the editor is vi", () => {
    expect(resolveEditor(Option.none(), Option.none())).toBe("vi")
  })

  test("an empty $VISUAL counts as unset", () => {
    expect(resolveEditor(Option.some(""), Option.some("vim"))).toBe("vim")
  })

  test("an editor setting splits into a program and its arguments; blank falls back to vi", () => {
    const cases: ReadonlyArray<readonly [string, [string, ...string[]]]> = [
      ["vim", ["vim"]],
      ["code --wait", ["code", "--wait"]],
      ["emacsclient -c -a emacs", ["emacsclient", "-c", "-a", "emacs"]],
      ["  nvim  -f  ", ["nvim", "-f"]],
      ["", ["vi"]],
    ]
    for (const [setting, command] of cases) {
      expect([setting, parseEditorCommand(setting)]).toEqual([setting, command])
    }
  })
})
