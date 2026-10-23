/**
 * Drive scripts: the live-check runner on the same pty as the TUI tests.
 */
import { describe, expect, it, test } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, FileSystem, Option, Result, Schedule, Schema } from "effect"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import {
  checkRecording,
  DriveEnd,
  drivePasses,
  DriveScript,
  driveProblems,
  keepPassed,
  passProblems,
  runDrivePasses,
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

/** Run `drive` with the lines it prints on stderr kept, and return both. */
const keepingStderr = <A, E, R>(drive: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const console = yield* Console.Console
    const lines: Array<string> = []
    const result = yield* drive.pipe(
      Effect.provideService(Console.Console, {
        ...console,
        error: (...args: ReadonlyArray<unknown>) => {
          lines.push(args.map(String).join(" "))
        },
      }),
    )
    return { result, stderr: lines.join("\n") }
  })

/** A program that draws `text` once, then idles until the drive stops it. */
const drawing = (text: string) =>
  ["bash", "-c", `printf '${text}'; while true; do sleep 0.05; done`] as const

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

  it.scopedLive(
    "expect and expectNot read the screen or a span of its rows, and a failure shows the rows around them",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        const { result: outcome, stderr } = yield* keepingStderr(
          runDriveScript(
            {
              command: drawing("alpha\\nbeta\\ngamma\\n"),
              cwd: out,
              cols: 40,
              rows: 8,
              out,
              steps: [
                ["waitFor", "gamma", 5_000],
                ["expect", "beta"],
                ["expect", "beta", [2, 2]],
                ["expect", "beta", [3, -1]],
                ["expectNot", "delta"],
                ["expectNot", "gamma", [1, 2]],
                ["expectNot", "be\\w+\\ngam"],
                ["expect", "alpha", [9, 10]],
              ],
            },
            { record: false },
          ),
        )
        expect(outcome.steps.map((step) => step._tag)).toEqual([
          "Ok",
          "Ok",
          "Ok",
          "Fail",
          "Ok",
          "Ok",
          "Fail",
          "Fail",
        ])
        // The span and three rows of context, the span's rows marked.
        expect(outcome.steps[3]).toMatchObject({
          reason: "no match in rows 3..-1",
          detail: [
            "   001|alpha",
            "   002|beta",
            "  !003|gamma",
            "  !004|",
            "  !005|",
            "  !006|",
            "  !007|",
            "  !008|",
          ],
        })
        // A match across rows marks each row it covers.
        expect(outcome.steps[6]).toMatchObject({
          reason: '"beta\\ngam" shows on the screen, at row 2',
          detail: ["   001|alpha", "  !002|beta", "  !003|gamma", "   004|", "   005|", "   006|"],
        })
        expect(outcome.steps[7]).toMatchObject({
          reason: "rows 9..10 names no row of the 8-row screen",
        })
        expect(stderr).toContain('FAIL expect "beta" rows 3..-1')
        expect(stderr).toContain("  !003|gamma")
        expect(stderr.split("\n").at(-1)).toMatch(/^pass 5\/8 · stopped \d+ · /)
        expect(stderr.endsWith(` · ${out}`)).toBe(true)
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "fits fails a row the terminal wrapped and a word cut at the edge, and passes text set flush to it",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // Row 1 runs past 40 columns and wraps onto row 2. With autowrap off,
        // row 3's word is cut at the edge, as a renderer clips a row it lays
        // out too wide; rows 4 to 6 end at the edge on a number, `…` and a border.
        const w = "w".repeat(50)
        const c = "c".repeat(45)
        const flush = `${" ".repeat(35)}$0.02\\r\\n${"x".repeat(39)}…\\r\\n${" ".repeat(39)}│`
        const outcome = yield* runDriveScript(
          {
            command: drawing(`${w}\\r\\n\\033[?7l${c}\\r\\n${flush}\\r\\ndrawn`),
            cwd: out,
            cols: 40,
            rows: 8,
            out,
            steps: [["waitFor", "drawn", 5_000], ["fits"], ["fits", [2, 2]], ["fits", [4, 7]]],
          },
          { record: false },
        )
        expect(outcome.steps.map((step) => step._tag)).toEqual(["Ok", "Fail", "Ok", "Ok"])
        expect(outcome.steps[1]).toMatchObject({
          reason: "row 1 wraps onto the next row; row 3 a word runs into the right edge",
          detail: [`  !001|${"w".repeat(40)}`, `  !003|${"c".repeat(40)}`],
        })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "fits reads cells: a wide character at the edge fits, a cut word ending on a combining mark does not, and a row painted over a wrap fits",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // Row 1 ends on two wide characters in the last four cells. Row 2 is
        // cut at the edge on `e` and a combining acute accent. Rows 3 and 4
        // took a wrap, then were painted over, padded, from their first column.
        const wide = `${" ".repeat(36)}漢字`
        const accent = `${"x".repeat(39)}e\\xcc\\x81`
        const wrapped = "w".repeat(50)
        const painted = `\\033[3;1H${"short".padEnd(40)}\\033[4;1H${"x".padEnd(40)}`
        const outcome = yield* runDriveScript(
          {
            command: drawing(
              `${wide}\\r\\n\\033[?7l${accent}\\033[?7h\\r\\n${wrapped}${painted}\\r\\ndrawn`,
            ),
            cwd: out,
            cols: 40,
            rows: 8,
            out,
            steps: [
              ["waitFor", "drawn", 5_000],
              ["fits", [1, 1]],
              ["fits", [2, 2]],
              ["fits", [3, 4]],
            ],
          },
          { record: false },
        )
        expect(outcome.steps.map((step) => step._tag)).toEqual(["Ok", "Ok", "Fail", "Ok"])
        expect(outcome.steps[2]).toMatchObject({ reason: "row 2 a word runs into the right edge" })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "stable fails a screen that changes within its window, with the rows that changed",
    () =>
      Effect.gen(function* () {
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        const outcome = yield* runDriveScript(
          {
            command: [
              "bash",
              "-c",
              "for i in $(seq 1 30); do printf '\\rtick %s' $i; sleep 0.05; done; printf '\\nquiet'; while true; do sleep 0.05; done",
            ],
            cwd: out,
            cols: 40,
            rows: 6,
            out,
            steps: [
              ["waitFor", "tick 2", 5_000],
              ["stable", 400],
              ["waitFor", "quiet", 5_000],
              ["stable", 400],
            ],
          },
          { record: false },
        )
        expect(outcome.steps.map((step) => step._tag)).toEqual(["Ok", "Fail", "Ok", "Ok"])
        // Only the ticking row changed: its first read, then the one that differed.
        expect(outcome.steps[1]).toMatchObject({
          reason: "the screen changed within 400ms",
          detail: [
            expect.stringMatching(/^  -001\|tick \d+$/),
            expect.stringMatching(/^  \+001\|tick \d+$/),
          ],
        })
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "a pass keeps its captures, and a later failing drive prints the rows that changed since",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        const drive = (text: string, check: string) =>
          keepingStderr(
            runDriveScript(
              {
                command: drawing(`${text}\\nsame row`),
                cwd: out,
                cols: 40,
                rows: 4,
                out,
                steps: [
                  ["waitFor", "same row", 5_000],
                  ["cap", "screen"],
                  ["expect", check],
                ],
              },
              { record: false },
            ),
          )
        const first = yield* drive("first", "first")
        expect(first.stderr).toContain('ok   cap "screen"')
        expect(first.stderr).toContain(" screen.txt")
        expect(first.stderr).not.toContain(out + "/screen.txt")
        expect(first.stderr).not.toContain("diff ")
        // The caller keeps a pass once its own checks passed too; the drive alone keeps nothing.
        expect(yield* fs.exists(`${out}/passed`)).toBe(false)
        yield* keepPassed(out, first.result)
        expect(yield* fs.readFileString(`${out}/passed/screen.txt`)).toContain("001|first")
        const second = yield* drive("second", "first")
        const lines = second.stderr.split("\n")
        expect(lines.slice(-4, -1)).toEqual([
          "diff screen.txt against the last pass",
          "  -001|first",
          "  +001|second",
        ])
        expect(lines.at(-1)).toMatch(/^pass 2\/3 · stopped \d+ · /)
        // A failing drive leaves the last pass's capture alone.
        expect(yield* fs.readFileString(`${out}/passed/screen.txt`)).toContain("001|first")
      }).pipe(Effect.timeout(EFFECT_TIMEOUT), Effect.provide(BunServices.layer)),
    TEST_TIMEOUT,
  )

  test("a sweep runs the steps at each size, then from the first size through a live resize to the last", () => {
    const script = {
      command: ["true"] as const,
      cwd: "/work",
      cols: 120,
      rows: 40,
      out: "/evidence",
      steps: [["waitFor", "ready"]] as const,
    }
    // A script with no sweep is one run into its own `out`.
    expect(drivePasses(script)).toEqual([{ size: "120x40", script }])
    const passes = drivePasses({
      ...script,
      sweep: [
        [80, 24],
        [60, 20],
      ],
    })
    expect(
      passes.map((pass) => [pass.size, pass.script.cols, pass.script.rows, pass.script.out]),
    ).toEqual([
      ["120x40", 120, 40, "/evidence/120x40"],
      ["80x24", 80, 24, "/evidence/80x24"],
      ["60x20", 60, 20, "/evidence/60x20"],
      ["120x40-60x20", 120, 40, "/evidence/120x40-60x20"],
    ])
    expect(passes.map((pass) => "sweep" in pass.script)).toEqual([false, false, false, false])
    expect(passes[2]?.script.steps).toEqual(script.steps)
    expect(passes[3]?.script.steps).toEqual([
      ["waitFor", "ready"],
      ["resize", 60, 20],
      ["settle"],
      ["fits"],
      ["cap", "resized"],
    ])
  })

  it.scopedLive(
    "a sweep fails the size and the resize a row does not fit, and each pass keeps its own evidence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const out = yield* makeTempDirectoryScoped("gent-drive-")
        // Fifty letters fit 80 columns and wrap at 40.
        const { result: passes, stderr } = yield* keepingStderr(
          runDrivePasses(
            {
              command: drawing(`${"w".repeat(50)}\r\ndrawn`),
              cwd: out,
              cols: 80,
              rows: 8,
              sweep: [[40, 8]],
              out,
              steps: [
                ["waitFor", "drawn", 5_000],
                ["fits"],
                ["sh", 'printf kept > "$EVIDENCE/sh.txt"'],
              ],
            },
            { record: false },
          ),
        )
        expect(passes.map((pass) => pass.size)).toEqual(["80x8", "40x8", "80x8-40x8"])
        expect(stderr.split("\n").filter((line) => line.startsWith("== "))).toEqual([
          "== 80x8",
          "== 40x8",
          "== 80x8-40x8",
        ])
        expect(passProblems(passes)).toEqual([
          "40x8: fail fits: row 1 wraps onto the next row",
          "80x8-40x8: fail fits: row 1 wraps onto the next row",
        ])
        // The first size passed; the resize pass passed its own steps before the resize.
        expect(passProblems([passes[0]!])).toEqual([])
        expect(passes[2]?.outcome.steps.map((step) => step._tag)).toEqual([
          "Ok",
          "Ok",
          "Ok",
          "Ok",
          "Ok",
          "Fail",
          "Ok",
        ])
        // `$EVIDENCE` is each pass's own directory, where its captures go too.
        for (const size of ["80x8", "40x8", "80x8-40x8"]) {
          expect(yield* fs.readFileString(`${out}/${size}/sh.txt`)).toBe("kept")
        }
        expect(yield* fs.readFileString(`${out}/80x8-40x8/resized.txt`)).toContain("# resized 40x8")
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
            ["expect", "ready", [-3, -1]],
            ["expectNot", "error"],
            ["fits"],
            ["stable", 500],
          ],
        }),
      ),
    ).toBe(true)
    for (const step of [
      ["waitFor", "["],
      ["cap", "../escaped"],
      ["capAll", "a/b"],
      ["raw", ""],
      ["expect", "("],
      ["expect", "ready", [0, 2]],
      ["fits", [1]],
      ["stable"],
    ]) {
      expect(Exit.isFailure(decode({ ...base, steps: [step] }))).toBe(true)
    }
  })
})
