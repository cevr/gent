/**
 * Drive scripts: the live-check runner on the same pty as the TUI tests.
 */
import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, FileSystem, Option, Result, Schedule, Schema } from "effect"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  checkRecording,
  DriveEnd,
  DriveScript,
  driveProblems,
  runDriveScript,
} from "../src/pty-fixture"

const TEST_TIMEOUT = 20_000
const EFFECT_TIMEOUT = "15 seconds"

/** Whether `pid` names a live process; signal 0 checks without sending one. */
const isAlive = (pid: number) => Result.isSuccess(Result.try(() => process.kill(pid, 0)))

/** The PID a step wrote to `file`, once it is gone: fails after two seconds while it lives. */
const goneWithin = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pid = Number((yield* fs.readFileString(file)).trim())
    expect(pid).toBeGreaterThan(0)
    yield* Effect.suspend(() => {
      if (isAlive(pid)) return Effect.fail(`PID ${pid} is alive`)
      return Effect.void
    }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 20 }))
    return pid
  })

/** Stop a PID a failed test left, so a red run leaks nothing. */
const reap = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.flatMap((text) => Effect.sync(() => process.kill(Number(text.trim()), "SIGKILL"))),
    Effect.ignoreCause,
  )

describe("drive scripts", () => {
  it.scopedLive(
    "PTY and shell steps share declared env without inheriting the host's env",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // oxlint-disable-next-line effect/noGlobals -- a scoped benign host sentinel proves the child environment is explicit
        const hostEnv = Bun.env
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = hostEnv["GENT_DRIVE_UNDECLARED"]
            hostEnv["GENT_DRIVE_UNDECLARED"] = "host-only"
            return Option.fromNullishOr(previous)
          }),
          (previous) =>
            Effect.sync(() => {
              Option.match(previous, {
                onNone: () => {
                  delete hostEnv["GENT_DRIVE_UNDECLARED"]
                },
                onSome: (value) => {
                  hostEnv["GENT_DRIVE_UNDECLARED"] = value
                },
              })
            }),
        )
        const printEnv =
          'printf "%s|%s|%s|%s\\n" "$GENT_DRIVE_DECLARED" "${GENT_DRIVE_UNDECLARED-unset}" "$COLORTERM" "$LANG"'
        yield* runDriveScript({
          command: ["/bin/sh", "-c", `${printEnv}; while read -r line; do :; done`],
          cwd: out,
          env: { GENT_DRIVE_DECLARED: "script-value", LANG: "C" },
          cols: 80,
          rows: 6,
          out,
          steps: [
            ["waitFor", "script-value", 5_000],
            ["raw", "pty-env"],
            ["sh", `${printEnv} > shell-env.txt`],
          ],
        })
        const expected = "script-value|unset|truecolor|C"
        expect(yield* fs.readFileString(`${out}/pty-env.raw`)).toContain(expected)
        expect((yield* fs.readFileString(`${out}/shell-env.txt`)).trim()).toBe(expected)
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "a resize reaches the program as SIGWINCH, and each capture lands in the out directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // The trap answers only when the pty is the program's controlling
        // terminal: the kernel sends SIGWINCH to its foreground group.
        const outcome = yield* runDriveScript({
          command: [
            "bash",
            "-c",
            "trap 'echo resized-$(stty size | tr \" \" x)' WINCH; stty size; while true; do sleep 0.05; done",
          ],
          cwd: out,
          cols: 40,
          rows: 8,
          out,
          steps: [
            ["waitFor", "8 40", 5_000],
            ["send", "typed"],
            ["resize", 50, 10],
            ["waitFor", "resized-10x50", 5_000],
            ["cap", "after-resize"],
            ["raw", "all-output"],
          ],
        })
        const capture = yield* fs.readFileString(`${out}/after-resize.txt`)
        expect(capture).toContain("# after-resize 50x10")
        expect(capture).toContain("resized-10x50")
        expect(yield* fs.readFileString(`${out}/all-output.raw`)).toContain("8 40")
        // The cleanup's ctrl+c ends the loop: the program did not end by itself.
        expect(outcome.end._tag).toBe("Stopped")
        expect(outcome.steps.map((step) => step._tag)).toEqual(Array(6).fill("Ok"))
        expect(outcome.steps.at(4)).toMatchObject({ file: `${out}/after-resize.txt` })
        // The recording plays: an asciicast v2 header at the starting size, then output and the resize.
        const recording = yield* checkRecording(`${out}/drive.cast`)
        expect(recording).toMatchObject({ width: 40, height: 8 })
        expect(recording.seconds).toBeGreaterThan(0)
        expect(yield* fs.readFileString(`${out}/drive.cast`)).toContain('"r","50x10"]')
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "after a shrink a capture shows only the columns the terminal has, as a terminal draws them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // The alternate screen does not reflow: its rows keep the cells drawn
        // at the wider size, past the new last column.
        yield* runDriveScript({
          command: [
            "bash",
            "-c",
            "printf '\\033[?1049h\\033[H%s' \"$(printf 'x%.0s' $(seq 1 60))PAST-THE-EDGE\"; while true; do sleep 0.05; done",
          ],
          cwd: out,
          cols: 80,
          rows: 6,
          out,
          steps: [
            ["waitFor", "PAST-THE-EDGE", 5_000],
            ["resize", 40, 6],
            ["wait", 200],
            ["cap", "after-shrink"],
            ["capAll", "after-shrink-all"],
          ],
        })
        for (const name of ["after-shrink", "after-shrink-all"]) {
          const rows = (yield* fs.readFileString(`${out}/${name}.txt`)).split("\n").slice(1)
          expect(rows.join("\n")).not.toContain("PAST-THE-EDGE")
          // Each row is `NNN|` and at most the 40 columns on screen.
          expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(4 + 40)
        }
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  // A light-mode check needs a terminal that reports a light ground: the
  // script's `ground` names what a background query (OSC 11) answers.
  for (const [label, ground, reply] of [
    ["default", {}, "rgb:1d1d/1f1f/2121"],
    ["light", { ground: "light" }, "rgb:ffff/ffff/ffff"],
  ] as const) {
    it.scopedLive(
      `a background query answers the ${label} ground`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const out = yield* makeTempDirectoryScoped("gent-drive-")
          // Raw, no echo: the reply reaches the program as bytes, and it
          // prints them with the escapes spelled `E`.
          const query =
            "stty raw -echo; printf '\\033]11;?\\033\\\\'; head -c 25 | tr '\\033' E; printf ' read'; while true; do sleep 0.05; done"
          yield* runDriveScript({
            command: ["bash", "-c", query],
            cwd: out,
            cols: 80,
            rows: 6,
            ...ground,
            out,
            steps: [
              ["waitFor", " read", 5_000],
              ["cap", "reply"],
            ],
          })
          expect(yield* fs.readFileString(`${out}/reply.txt`)).toContain(`E]11;${reply}E`)
        }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
      TEST_TIMEOUT,
    )
  }

  it.scopedLive(
    "a miss, a failed sh step and an unexpected exit are in the outcome, and each fails the drive",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        const script = {
          command: ["/bin/sh", "-c", "echo ready; sleep 0.3; exit 7"],
          cwd: out,
          cols: 40,
          rows: 6,
          out,
          steps: [
            ["waitFor", "ready", 5_000],
            ["waitFor", "never-drawn", 200],
            ["sh", "exit 3"],
            ["wait", 600],
          ],
        } satisfies typeof DriveScript.Type & { readonly cwd: string }
        const outcome = yield* runDriveScript(script, { record: false })
        expect(outcome.steps.map((step) => step._tag)).toEqual(["Ok", "Miss", "Fail", "Ok"])
        expect(outcome.end).toEqual(DriveEnd.cases.Exited.make({ code: 7 }))
        expect(driveProblems(script, outcome)).toEqual([
          'miss waitFor "never-drawn" 200',
          'fail sh "exit 3": exit 3',
          "the program exited 7, the script expects 0",
        ])
        // The same drive passes once it names the exit and its steps hold.
        const clean = {
          ...script,
          exit: 7,
          steps: script.steps.filter((step) => step[0] !== "sh" && step[1] !== "never-drawn"),
        }
        expect(driveProblems(clean, yield* runDriveScript(clean, { record: false }))).toEqual([])
        expect(
          yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(`${out}/drive.cast`))),
        ).toBe(false)
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "an sh step stops its process group: a background child goes with the step, timed out or done",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        yield* Effect.addFinalizer(() =>
          Effect.all([reap(`${out}/waited.pid`), reap(`${out}/left.pid`)]),
        )
        const outcome = yield* runDriveScript(
          {
            command: ["/bin/sh", "-c", "while read -r line; do :; done"],
            cwd: out,
            cols: 40,
            rows: 6,
            out,
            steps: [
              ["sh", "sleep 300 & echo $! > waited.pid; wait", 500],
              ["sh", "sleep 300 & echo $! > left.pid"],
            ],
          },
          { record: false },
        )
        expect(outcome.steps.map((step) => step._tag)).toEqual(["Fail", "Ok"])
        expect(outcome.steps[0]).toMatchObject({
          reason: "outlived 500ms; its process group was stopped",
        })
        yield* goneWithin(`${out}/waited.pid`)
        yield* goneWithin(`${out}/left.pid`)
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "an interrupted drive stops its sh step's group and the pty program's, and still saves the recording",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        yield* Effect.addFinalizer(() =>
          Effect.all([reap(`${out}/sh.pid`), reap(`${out}/pty.pid`)]),
        )
        // The pty program leaves a child in its group, and both ignore ctrl+c and the hangup\n        // the pty's close sends: only the group kill ends them.
        const exit = yield* runDriveScript({
          command: [
            "/bin/sh",
            "-c",
            "trap '' INT HUP; sleep 300 & echo $! > pty.pid; echo started; wait",
          ],
          cwd: out,
          cols: 40,
          rows: 6,
          out,
          steps: [
            ["waitFor", "started", 5_000],
            ["sh", "sleep 300 & echo $! > sh.pid; wait"],
          ],
        }).pipe(Effect.timeout("1500 millis"), Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        yield* goneWithin(`${out}/sh.pid`)
        yield* goneWithin(`${out}/pty.pid`)
        yield* checkRecording(`${out}/drive.cast`)
        expect(yield* fs.readFileString(`${out}/drive.cast`)).toContain("started")
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  test("a script is refused at decode when a pattern does not compile or a capture name leaves out", () => {
    const decode = Schema.decodeUnknownExit(DriveScript)
    const base = { command: ["true"], cols: 40, rows: 6, out: "out" }
    expect(
      Exit.isSuccess(
        decode({
          ...base,
          steps: [
            ["waitFor", "ready"],
            ["cap", "01-home.v2"],
          ],
        }),
      ),
    ).toBe(true)
    for (const step of [
      ["waitFor", "["],
      ["cap", "../escaped"],
      ["capAll", "a/b"],
      ["raw", ""],
    ]) {
      expect(Exit.isFailure(decode({ ...base, steps: [step] }))).toBe(true)
    }
  })
})
