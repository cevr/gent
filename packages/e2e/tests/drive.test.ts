/**
 * Drive scripts: the live-check runner on the same pty as the TUI tests.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option } from "effect"
import { makeTempDirectoryScoped } from "@gent/core/test-utils"
import { runDriveScript } from "../src/pty-fixture"

const TEST_TIMEOUT = 20_000
const EFFECT_TIMEOUT = "15 seconds"

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
        const code = yield* runDriveScript({
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
        // The cleanup's ctrl+c ends the loop.
        expect(Option.isSome(code)).toBe(true)
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
})
