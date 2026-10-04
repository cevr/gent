/**
 * Scrollback ownership.
 *
 * The TUI draws a split footer: the live view sits at the bottom of the screen
 * and completed transcript items are committed to the rows above it, which the
 * terminal scrolls into its own history. That only works while the footer
 * leaves an output region to scroll — `splitFooterHeight` reserves it. When
 * the region vanished, every commit was written at row 1 and the same frame's
 * footer paint erased it, so a long session left the reader with no history at
 * all and no way to scroll back to what happened.
 *
 * These tests replay the raw pty bytes through a headless VT emulator and read
 * the terminal's history rows directly, which is the only place that defect is
 * visible: the live view looked correct the whole time.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { waitFor } from "@gent/core/test-utils"
import {
  countRows,
  gridText,
  historyText,
  keys,
  ptyWaitFor,
  screenWaitFor,
  seedAndSpawn,
  settleAndCapture,
  settlePty,
  signalAndExit,
  type TestContext,
} from "../src/pty-fixture"

const TEST_TIMEOUT = 120_000
const EFFECT_TIMEOUT = "110 seconds"

/** A short screen, so a handful of turns is already taller than it. */
const SHORT_SCREEN = { cols: 80, rows: 14 }

const SETTLE = { quietMs: 800, timeoutMs: 25_000 }

/** The typed text is drawn once the child writes nothing for this long. */
const TYPED = { quietMs: 200, timeoutMs: 5_000 }

const messageText = (index: number) => `scrollback probe ${index}`
const encodeTerminalBytes = Schema.encodeSync(Schema.fromJsonString(Schema.String))

class TranscriptReadinessError extends Schema.TaggedError<TranscriptReadinessError>()(
  "TranscriptReadinessError",
  { message: Schema.String },
) {}

/**
 * Submit `count` messages and let each turn finish.
 *
 * `--mock-empty` answers every turn from a scripted model, so the transcript
 * is deterministic and no network is involved. A running turn animates its
 * footer, so the output going quiet is the turn finishing.
 */
const submitMessages = (ctx: TestContext, count: number) =>
  Effect.gen(function* () {
    yield* ptyWaitFor(ctx, "ready", { timeout: 25_000 })
    for (let index = 1; index <= count; index++) {
      ctx.pty.write(messageText(index))
      yield* settlePty(ctx, TYPED)
      ctx.pty.write(keys.enter)
      yield* screenWaitFor(
        ctx,
        (visible) => visible.some((row) => row.trimEnd() === `┃ ${messageText(index)}`),
        { timeout: 25_000, label: `submitted message ${index}` },
      )
      yield* settlePty(ctx, SETTLE)
    }
  })

describe("E2E: Scrollback ownership", () => {
  it.scopedLive(
    "a transcript taller than the screen leaves history from the first message on, each row once",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--mock-empty"], SHORT_SCREEN)
        yield* submitMessages(ctx, 5)

        const grid = yield* settleAndCapture(ctx, SETTLE)
        const history = historyText(grid)

        // The defect: the footer owned every row, so nothing ever scrolled off
        // and history was empty however long the session ran.
        expect(history.length).toBeGreaterThan(SHORT_SCREEN.rows)

        // The first message must be in history, not just on screen: it is the
        // oldest thing the reader scrolls back to.
        expect(countRows(history, messageText(1))).toBeGreaterThan(0)

        // History reads in the order the turns happened.
        const positions = [1, 2, 3].map((index) =>
          history.findIndex((row) => row.includes(messageText(index))),
        )
        for (const position of positions) expect(position).toBeGreaterThanOrEqual(0)
        expect(positions[0]).toBeLessThan(positions[1] ?? -1)
        expect(positions[1]).toBeLessThan(positions[2] ?? -1)

        // Committed rows are written to history once: a commit that also
        // repaints leaves the same row in the terminal twice. Counting is
        // what catches it; `toContain` cannot.
        const rows = gridText(grid)
        for (const index of [1, 2, 3, 4, 5]) {
          expect(countRows(rows, messageText(index))).toBe(1)
        }
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "a resize replay keeps every message, still in order",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--mock-empty"], SHORT_SCREEN)
        yield* submitMessages(ctx, 4)
        yield* settlePty(ctx, SETTLE)

        // A resize re-lays out the transcript and replays it. The replay must
        // not drop rows, and must not add a second copy of any of them.
        const beforeResize = ctx.output.length
        ctx.resize({ cols: SHORT_SCREEN.cols, rows: 24 })
        yield* waitFor(
          Effect.sync(() => ctx.output.length),
          (length) => length > beforeResize,
          10_000,
          "the repaint after the resize",
        )

        const grid = yield* settleAndCapture(ctx, SETTLE)
        const rows = gridText(grid)

        const positions = [1, 2, 3, 4].map((index) => {
          expect(countRows(rows, messageText(index))).toBe(1)
          return rows.findIndex((row) => row.includes(messageText(index)))
        })
        for (const position of positions) expect(position).toBeGreaterThanOrEqual(0)
        for (let index = 1; index < positions.length; index++) {
          expect(positions[index - 1]).toBeLessThan(positions[index] ?? -1)
        }

        // The replay still has to leave history behind: a resize that rebuilt
        // the screen without a scrollable output region would show the same
        // ordered rows on screen and keep nothing above it.
        expect(historyText(grid).length).toBeGreaterThan(0)
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  // A signal from outside (`kill`, a closing multiplexer) leaves the terminal
  // as ctrl+c twice does: the transcript stays above the shell prompt.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it.scopedLive(
      `${signal} from outside leaves every message on screen`,
      () =>
        Effect.gen(function* () {
          const ctx = yield* seedAndSpawn(["--mock-empty"], SHORT_SCREEN)
          yield* submitMessages(ctx, 2)
          // A quiet screen can still hold rows above the live viewport while
          // client notice sources settle. Wait for the complete transcript.
          const before = yield* waitFor(
            settleAndCapture(ctx, SETTLE).pipe(Effect.map(gridText)),
            (rows) => [1, 2].every((index) => countRows(rows, messageText(index)) === 1),
            25_000,
            "both submitted message rows, once, before the signal",
          ).pipe(
            Effect.mapError(
              (error) =>
                new TranscriptReadinessError({
                  message: `${error.message}\nPTY bytes: ${encodeTerminalBytes(ctx.output)}`,
                }),
            ),
          )
          for (const index of [1, 2]) {
            expect(["before signal", index, countRows(before, messageText(index))]).toEqual([
              "before signal",
              index,
              1,
            ])
          }
          expect(Option.isSome(yield* signalAndExit(ctx, signal, "10 seconds"))).toBe(true)
          const rows = gridText(yield* settleAndCapture(ctx, SETTLE))
          for (const index of [1, 2]) {
            expect([index, countRows(rows, messageText(index))]).toEqual([index, 1])
          }
        }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
      TEST_TIMEOUT,
    )
  }

  // At 80x24 a 5-row prompt whose turn retries fills the screen: history
  // takes the prompt's top rows as the turn ends. The rows read on with no
  // row added or lost between history and the screen.
  it.scopedLive(
    "a multiline prompt whose turn retries keeps its rows together at 80x24",
    () =>
      Effect.gen(function* () {
        const ctx = yield* seedAndSpawn(["--debug"], { cols: 80, rows: 24 })
        yield* ptyWaitFor(ctx, "ready", { timeout: 25_000 })
        yield* settlePty(ctx, TYPED)
        ctx.pty.write("/new")
        yield* settlePty(ctx, TYPED)
        ctx.pty.write(keys.enter)
        yield* settlePty(ctx, SETTLE)
        const prompt = ["longg", "row two", "row three", "row four", "row five"]
        ctx.pty.write(prompt.join("\n"))
        yield* settlePty(ctx, TYPED)
        ctx.pty.write(keys.enter)
        yield* ptyWaitFor(ctx, "Retried 2/3", { timeout: 25_000 })
        const grid = yield* settleAndCapture(ctx, { quietMs: 1_500, timeoutMs: 25_000 })
        const rows = [...grid.history, ...grid.visible].map((row) => row.trimEnd())
        const first = rows.findIndex((row) => row === "┃ longg")
        expect(first).toBeGreaterThanOrEqual(0)
        expect(rows.slice(first, first + prompt.length)).toEqual(prompt.map((row) => `┃ ${row}`))
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  // A picker draws on the alternate screen, and the terminal keeps its own
  // screen meanwhile. Its return must find history as it left it: the next
  // commit goes on the row under the last history row, not over it, and the
  // rows on screen do not go to scrollback a second time.
  const pickerReturns = [
    { name: "a long session", size: { cols: 60, rows: 20 }, turn: true },
    { name: "a short session", size: { cols: 120, rows: 40 }, turn: false },
  ] as const
  for (const { name, size, turn } of pickerReturns) {
    it.scopedLive(
      `a picker closed over ${name} keeps every transcript row once, in order, at ${size.cols}x${size.rows}`,
      () =>
        Effect.gen(function* () {
          const ctx = yield* seedAndSpawn(["--debug"], size)
          yield* screenWaitFor(
            ctx,
            (visible) =>
              visible.some((row) => row.includes(DEBUG_SESSION_END)) &&
              visible.some((row) => row.startsWith("ready")),
            { timeout: 25_000, label: "the debug session at idle" },
          )
          const before = transcriptRows(yield* settleAndCapture(ctx, SETTLE))
          expect(before.length).toBeGreaterThan(10)

          ctx.pty.write("/model")
          yield* settlePty(ctx, TYPED)
          ctx.pty.write(keys.enter)
          yield* settlePty(ctx, SETTLE)
          ctx.pty.write(keys.esc)
          yield* settlePty(ctx, SETTLE)
          if (turn) {
            ctx.pty.write("hello")
            yield* settlePty(ctx, TYPED)
            ctx.pty.write(keys.enter)
            yield* screenWaitFor(
              ctx,
              (visible) => visible.some((row) => row.startsWith("● Worked for")),
              { timeout: 25_000, label: "the turn after the picker at its end" },
            )
          }

          const known = new Set(before)
          const after = gridText(yield* settleAndCapture(ctx, SETTLE)).filter((row) =>
            known.has(row),
          )
          expect(after).toEqual(before)
        }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
      TEST_TIMEOUT,
    )
  }
})

/** The row the `--debug` session's seeded transcript ends on, at every width. */
const DEBUG_SESSION_END = "renderer behavior directly."

/** The transcript's rows, history first, up to the seeded session's last row. */
const transcriptRows = (grid: Parameters<typeof gridText>[0]): string[] => {
  const rows = gridText(grid)
  return rows.slice(0, rows.findIndex((row) => row.includes(DEBUG_SESSION_END)) + 1)
}

describe("E2E: Settle then capture", () => {
  it.live("the capture reads what the child wrote while it waited for quiet", () =>
    Effect.gen(function* () {
      let output = "first frame\r\n"
      const child = {
        get output() {
          return output
        },
        size: { cols: 40, rows: 6 },
      }
      const capture = settleAndCapture(child, { quietMs: 100, timeoutMs: 2_000 })
      // A repaint lands after the capture is built and before it runs.
      output += "second frame\r\n"
      expect(gridText(yield* capture)).toEqual(["first frame", "second frame"])
    }).pipe(Effect.timeout("5 seconds")),
  )
})
