import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Option } from "effect"
import { makeHandover, openExternalEditor, parseEditorCommand, resolveEditor } from "../src/os"

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
        const steps: Array<string> = []
        const handover = makeHandover({
          suspend: () => steps.push("suspend"),
          resume: () => steps.push("resume"),
        })
        const run = (editor: string) => openExternalEditor("draft", handover, editor)
        const applied = yield* run("true")
        const cancelled = yield* run("false")
        const failed = yield* run("/nonexistent/gent-probe-x")
        expect(applied).toEqual({ _tag: "applied", content: "draft" })
        expect(cancelled).toEqual({ _tag: "cancelled" })
        expect(failed._tag).toBe("error")
        // Each run hands the terminal over once and takes it back, a failed one too.
        expect(steps).toEqual(["suspend", "resume", "suspend", "resume", "suspend", "resume"])
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
  )
})

// ── terminal handover ───────────────────────────────────────────────────────

describe("terminal handover", () => {
  it.live("a second handover waits for the first to give the terminal back", () =>
    Effect.gen(function* () {
      const steps: Array<string> = []
      const handover = makeHandover({
        suspend: () => steps.push("suspend"),
        resume: () => steps.push("resume"),
      })
      const firstHolds = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const first = yield* Effect.forkChild(
        handover(
          Effect.gen(function* () {
            steps.push("first")
            yield* Deferred.succeed(firstHolds, void 0)
            yield* Deferred.await(releaseFirst)
          }),
        ),
      )
      yield* Deferred.await(firstHolds)
      const second = yield* Effect.forkChild(handover(Effect.sync(() => steps.push("second"))))
      yield* Effect.yieldNow
      expect(steps).toEqual(["suspend", "first"])
      yield* Deferred.succeed(releaseFirst, void 0)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(steps).toEqual(["suspend", "first", "resume", "suspend", "second", "resume"])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live("a handover that fails or is interrupted gives the terminal back", () =>
    Effect.gen(function* () {
      const steps: Array<string> = []
      const handover = makeHandover({
        suspend: () => steps.push("suspend"),
        resume: () => steps.push("resume"),
      })
      const failed = yield* handover(Effect.fail("boom")).pipe(Effect.flip)
      expect(failed).toBe("boom")
      const held = yield* Effect.forkChild(handover(Effect.never))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(held)
      expect(steps).toEqual(["suspend", "resume", "suspend", "resume"])
    }).pipe(Effect.timeout("4 seconds")),
  )
})
