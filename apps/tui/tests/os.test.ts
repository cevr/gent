import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { openExternalEditor, parseEditorCommand, resolveEditor } from "../src/os"

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

  it.live(
    "the editor's exit decides the result: zero applies the file, non-zero cancels, no program fails",
    () =>
      Effect.gen(function* () {
        const run = (editor: string) =>
          openExternalEditor(
            "draft",
            () => {},
            () => {},
            editor,
          )
        const applied = yield* run("true")
        const cancelled = yield* run("false")
        const failed = yield* run("/nonexistent/gent-probe-x")
        expect(applied).toEqual({ _tag: "applied", content: "draft" })
        expect(cancelled).toEqual({ _tag: "cancelled" })
        expect(failed._tag).toBe("error")
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
  )
})
