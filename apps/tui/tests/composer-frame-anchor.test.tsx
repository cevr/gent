/** @jsxImportSource @opentui/solid */
/**
 * The status row's right-hand labels hold their place.
 *
 * The row used to spend one left-to-right width budget and drop whatever did
 * not fit, with no indication. Adding the cwd silently removed the effort, the
 * context gauge and the running total — the labels a reader checks at a glance
 * without reading the row. The right group is now laid out first and keeps its
 * columns; the left group truncates instead.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { RGBA } from "@opentui/core"
import { ComposerFrame } from "../src/components/composer-frame"
import type { BorderLabelItem } from "../src/utils/session-labels"
import { renderWithProviders } from "./render-harness-boundary"

const muted = RGBA.fromHex("#888888")
const label = (text: string): BorderLabelItem => ({ text, color: muted })

/** Everything the real row carries, longest-plausible cwd included. */
const labels: BorderLabelItem[] = [
  label("idle"),
  label("some-very-long-project-name (feature/a-long-branch)"),
  label("Claude Sonnet 5"),
  label("medium"),
  label("ctx 42%"),
  label("$12.34"),
]

const frameText = (width: number, rightLabels: number) =>
  Effect.gen(function* () {
    const setup = yield* Effect.promise(() =>
      renderWithProviders(
        () => (
          <ComposerFrame labels={labels} rightLabels={rightLabels}>
            <box />
          </ComposerFrame>
        ),
        { width, height: 10 },
      ),
    )
    yield* Effect.promise(() => setup.flush())
    return setup.captureCharFrame()
  })

describe("the status row anchors its right-hand labels", () => {
  it.live("keeps the running total when the row cannot fit everything", () =>
    Effect.gen(function* () {
      const text = yield* frameText(60, 2)
      // The two anchored labels survive a width that cannot hold the row.
      expect(text).toContain("$12.34")
      expect(text).toContain("ctx 42%")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("drops the anchored labels when nothing reserves them", () =>
    Effect.gen(function* () {
      // Without a reservation the old behaviour returns: the last labels are
      // pushed off the end by everything before them.
      const text = yield* frameText(60, 0)
      expect(text).not.toContain("$12.34")
    }).pipe(Effect.timeout("10 seconds")),
  )

  it.live("shows every label when the row is wide enough", () =>
    Effect.gen(function* () {
      const text = yield* frameText(140, 2)
      expect(text).toContain("idle")
      expect(text).toContain("Claude Sonnet 5")
      expect(text).toContain("ctx 42%")
      expect(text).toContain("$12.34")
    }).pipe(Effect.timeout("10 seconds")),
  )
})
