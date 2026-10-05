/**
 * The pty fixture's waits read what a terminal draws, not the byte stream.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { fedStream, ptyWaitFor, type TestContext } from "../src/pty-fixture"

const SIZE = { cols: 45, rows: 15 }

const at = (row: number, col: number) => `\u001b[${row};${col}H`

describe("pty fixture waits", () => {
  // A cell-diff renderer writes only the cells that change. The turn line
  // drawn over the live line (both `  ✻ …`, with spaces in the same columns)
  // reaches the pty as `✻ Worked for3s ·2retries`: the skipped cells are
  // already spaces. The bytes are a 45x15 frame from the scrollback e2e.
  it.live("text drawn by cells over the frame before counts as drawn", () =>
    Effect.gen(function* () {
      const output = [
        `${at(10, 3)}✻ Generating (2s) · esc cancel`,
        `${at(10, 5)}Worked for${at(10, 16)}3s ·${at(10, 21)}2${at(10, 23)}retries · ↑11 ↓42`,
        `${at(10, 40)}${" ".repeat(6)}`,
      ].join("")
      expect(Bun.stripANSI(output)).not.toContain("2 retries")
      const waited = yield* ptyWaitFor(
        fedStream(() => output, SIZE),
        "2 retries",
        {
          timeout: 200,
        },
      ).pipe(
        Effect.as("drawn"),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      expect(waited).toBe("drawn")
    }).pipe(Effect.timeout("2 seconds")),
  )

  it.live("text the terminal never shows times out", () =>
    Effect.gen(function* () {
      const output = `${at(10, 3)}✻ Worked for 3s · ↑11 ↓42`
      const waited = yield* ptyWaitFor(
        fedStream(() => output, SIZE),
        "2 retries",
        {
          timeout: 50,
        },
      ).pipe(
        Effect.as("drawn"),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      expect(waited).toBe('timed out waiting for PTY output "2 retries"')
    }).pipe(Effect.timeout("2 seconds")),
  )

  // An assertion on the raw stream passes only while the renderer writes the
  // text in one run; the context offers no such read.
  it.live("a test cannot read the raw stream, only a mark of how much was written", () =>
    Effect.sync(() => {
      const read = (ctx: TestContext) => {
        // @ts-expect-error -- the raw stream stays in the fixture; a test reads the screen
        const raw: string = ctx.output
        const mark: number = ctx.written()
        return [raw, mark]
      }
      expect(read).toBeInstanceOf(Function)
    }),
  )
})
