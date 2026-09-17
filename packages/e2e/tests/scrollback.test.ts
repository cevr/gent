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
import { Effect } from "effect"
import {
  countRows,
  gridText,
  historyText,
  ptyWaitFor,
  seedAndSpawn,
  settleAndCapture,
  shortPause,
  type TestContext,
} from "../src/pty-fixture"

const TEST_TIMEOUT = 120_000
const EFFECT_TIMEOUT = "110 seconds"

const ENTER = "\r"

/** A short screen, so a handful of turns is already taller than it. */
const SHORT_SCREEN = { cols: 80, rows: 14 }

const SETTLE = { quietMs: 800, timeoutMs: 25_000 }

const messageText = (index: number) => `scrollback probe ${index}`

/**
 * Submit `count` messages and let each turn finish.
 *
 * `--mock-empty` answers every turn from a scripted model, so the transcript
 * is deterministic and no network is involved.
 */
const submitMessages = (ctx: TestContext, count: number) =>
  Effect.gen(function* () {
    yield* ptyWaitFor(ctx, "ready", { timeout: 25_000 })
    for (let index = 1; index <= count; index++) {
      ctx.pty.write(messageText(index))
      yield* shortPause(250)
      ctx.pty.write(ENTER)
      yield* shortPause(2_500)
    }
  })

const acquire = <R>(ctx: Effect.Effect<TestContext, never, R>) =>
  Effect.acquireRelease(ctx, (acquired) => acquired.cleanup)

describe("E2E: Scrollback ownership", () => {
  it.scopedLive(
    "a transcript taller than the screen leaves history from the first message on",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquire(seedAndSpawn(["--mock-empty"], SHORT_SCREEN))
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
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "committed rows are written to history once, not repainted into it twice",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquire(seedAndSpawn(["--mock-empty"], SHORT_SCREEN))
        yield* submitMessages(ctx, 4)

        const grid = yield* settleAndCapture(ctx, SETTLE)
        const rows = gridText(grid)

        // A commit that also repaints leaves the same row in the terminal
        // twice. Counting is what catches it; `toContain` cannot.
        for (const index of [1, 2, 3, 4]) {
          expect(countRows(rows, messageText(index))).toBe(1)
        }
      }).pipe(Effect.timeout(EFFECT_TIMEOUT)),
    TEST_TIMEOUT,
  )

  it.scopedLive(
    "a resize replay keeps every message, still in order",
    () =>
      Effect.gen(function* () {
        const ctx = yield* acquire(seedAndSpawn(["--mock-empty"], SHORT_SCREEN))
        yield* submitMessages(ctx, 4)
        yield* settleAndCapture(ctx, SETTLE)

        // A resize re-lays out the transcript and replays it. The replay must
        // not drop rows, and must not add a second copy of any of them.
        ctx.resize({ cols: SHORT_SCREEN.cols, rows: 24 })
        yield* shortPause(1_500)

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
})
