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
})
