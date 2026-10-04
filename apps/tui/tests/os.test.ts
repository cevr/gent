import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, FileSystem, Option } from "effect"
import { runProcess } from "@gent/core/extensions/api"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
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
    "the editor's exit decides the result: zero applies the file, non-zero or a signal cancels, no program fails",
    () =>
      Effect.gen(function* () {
        const steps: Array<string> = []
        const { handover } = makeHandover({
          suspend: () => steps.push("suspend"),
          resume: () => steps.push("resume"),
        })
        const run = (editor: string) => openExternalEditor("draft", handover, editor)
        const applied = yield* run("true")
        const cancelled = yield* run("false")
        const failed = yield* run("/nonexistent/gent-probe-x")
        // An editor the reader stops (ctrl+c reaches it) ends on a signal, with no exit code.
        const fs = yield* FileSystem.FileSystem
        const dir = yield* makeTempDirectoryScoped("gent-editor-signal-")
        yield* fs.writeFileString(`${dir}/editor`, "#!/bin/sh\nkill -TERM $$\n")
        yield* fs.chmod(`${dir}/editor`, 0o755)
        const stopped = yield* run(`${dir}/editor`)
        expect(applied).toEqual({ _tag: "applied", content: "draft" })
        expect(cancelled).toEqual({ _tag: "cancelled" })
        expect(failed._tag).toBe("error")
        expect(stopped).toEqual({ _tag: "cancelled" })
        // Each run hands the terminal over once and takes it back, a failed one too.
        expect(steps).toEqual([...Array.from({ length: 4 }, () => ["suspend", "resume"])].flat())
      }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
  )
})

// ── terminal handover ───────────────────────────────────────────────────────

describe("terminal handover", () => {
  it.live("a second handover waits for the first to give the terminal back", () =>
    Effect.gen(function* () {
      const steps: Array<string> = []
      const { handover } = makeHandover({
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
    }).pipe(Effect.timeout("4 seconds"), Effect.provide(BunServices.layer)),
  )

  it.live("a handover that fails or is interrupted gives the terminal back", () =>
    Effect.gen(function* () {
      const steps: Array<string> = []
      const { handover } = makeHandover({
        suspend: () => steps.push("suspend"),
        resume: () => steps.push("resume"),
      })
      const before = signalListeners()
      const failed = yield* handover(Effect.fail("boom")).pipe(Effect.flip)
      expect(failed).toBe("boom")
      const holding = yield* Deferred.make<void>()
      const held = yield* Effect.forkChild(
        handover(Deferred.succeed(holding, void 0).pipe(Effect.andThen(Effect.never))),
      )
      yield* Deferred.await(holding)
      yield* Fiber.interrupt(held)
      expect(steps).toEqual(["suspend", "resume", "suspend", "resume"])
      // The signal listeners the handover held are back too.
      expect(signalListeners()).toEqual(before)
    }).pipe(Effect.timeout("4 seconds"), Effect.provide(BunServices.layer)),
  )

  // Gent's exit closes the holder: a handover running then ends, and one
  // waiting for the terminal never takes it.
  it.live("closing the holder ends the running handover and the waiting one", () =>
    Effect.gen(function* () {
      const steps: Array<string> = []
      const terminal = makeHandover({
        suspend: () => steps.push("suspend"),
        resume: () => steps.push("resume"),
      })
      const holding = yield* Deferred.make<void>()
      const running = yield* Effect.forkChild(
        terminal.handover(
          Deferred.succeed(holding, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => steps.push("program stopped"))),
          ),
        ),
      )
      yield* Deferred.await(holding)
      const waiting = yield* Effect.forkChild(
        terminal.handover(Effect.sync(() => steps.push("second program"))),
      )
      yield* terminal.close
      expect(steps).toEqual(["suspend", "program stopped", "resume"])
      expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true)
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
      const late = yield* terminal
        .handover(Effect.sync(() => steps.push("late program")))
        .pipe(Effect.exit)
      expect(Exit.hasInterrupts(late)).toBe(true)
      expect(steps).toEqual(["suspend", "program stopped", "resume"])
    }).pipe(Effect.timeout("4 seconds"), Effect.provide(BunServices.layer)),
  )

  it.live(
    "a program the handover runs joins the terminal's foreground group, and gent's ctrl+c and ctrl+\\ listeners wait for the terminal back",
    () =>
      Effect.gen(function* () {
        const { handover } = makeHandover({ suspend: () => {}, resume: () => {} })
        // The group the program runs in, then its parent's: this process's.
        const groups = runProcess("sh", ["-c", "ps -o pgid= -p $$; ps -o pgid= -p $PPID"]).pipe(
          Effect.map((result) => result.stdout.split("\n").map((line) => line.trim())),
        )
        const [own, parent] = yield* groups
        expect(own).not.toBe(parent)
        const [ownInside, parentInside] = yield* handover(groups)
        expect(ownInside).toBe(parentInside)

        const heard: Array<string> = []
        const gent = (signal: string) => heard.push(signal)
        yield* Effect.acquireRelease(
          Effect.sync(() => HELD.forEach((signal) => process.on(signal, gent))),
          () => Effect.sync(() => HELD.forEach((signal) => process.removeListener(signal, gent))),
        )
        // A signal the terminal sends while it is handed over passes gent by.
        yield* handover(Effect.forEach(HELD, raise, { discard: true }))
        expect(heard).toEqual([])
        // Once the terminal is back, gent hears it again.
        yield* Effect.forEach(HELD, raise, { discard: true })
        expect(heard).toEqual([...HELD])
      }).pipe(Effect.scoped, Effect.timeout("8 seconds"), Effect.provide(BunServices.layer)),
  )

  it.live("a ctrl+c or ctrl+\\ that arrives as the program ends still passes gent by", () =>
    Effect.gen(function* () {
      const heard: Array<string> = []
      const gent = (signal: string) => heard.push(signal)
      // The renderer takes its own ctrl+\ listener off when it suspends and
      // puts it back when it resumes, as OpenTUI's exit listener does.
      const renderer = (signal: string) => heard.push(`renderer ${signal}`)
      const { handover } = makeHandover({
        suspend: () => process.removeListener("SIGQUIT", renderer),
        resume: () => process.on("SIGQUIT", renderer),
      })
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("SIGQUIT", renderer)),
        () => Effect.sync(() => process.removeListener("SIGQUIT", renderer)),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => HELD.forEach((signal) => process.on(signal, gent))),
        () => Effect.sync(() => HELD.forEach((signal) => process.removeListener(signal, gent))),
      )
      // The program signals gent and ends while gent is busy (a synchronous
      // run), as the terminal signals gent and a program the reader stops:
      // gent has the signals, and their listeners run only after the
      // program's end is seen. (The test's own group is the test runner's.)
      yield* handover(
        Effect.sync(() =>
          // oxlint-disable-next-line effect/noGlobals -- only a synchronous run keeps gent busy until the program has ended
          Bun.spawnSync(["sh", "-c", "kill -INT $PPID; kill -QUIT $PPID"]),
        ),
      )
      // A signal raised after the terminal is back reaches gent, and runs
      // after any signal that came before it.
      yield* Effect.forEach(HELD, raise, { discard: true })
      expect(heard.sort()).toEqual(["SIGINT", "SIGQUIT", "renderer SIGQUIT"])
    }).pipe(Effect.scoped, Effect.timeout("8 seconds"), Effect.provide(BunServices.layer)),
  )
})

/** The signals a terminal's keys send its foreground group: ctrl+c and ctrl+\. */
const HELD = ["SIGINT", "SIGQUIT"] as const

const signalListeners = () => HELD.map((signal) => process.listeners(signal))

/** Send this process `signal` and wait until a listener of the test's own has heard it. */
const raise = (signal: (typeof HELD)[number]) =>
  Effect.gen(function* () {
    const delivered = yield* Deferred.make<void>()
    const probe = () => Deferred.doneUnsafe(delivered, Exit.void)
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.on(signal, probe)
        process.kill(process.pid, signal)
      }),
      () => Deferred.await(delivered),
      () => Effect.sync(() => process.removeListener(signal, probe)),
    )
  })
