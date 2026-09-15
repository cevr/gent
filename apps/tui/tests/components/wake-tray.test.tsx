/** @jsxImportSource @opentui/solid */
/**
 * The wake tray under the status line: one dim line per pending alarm or
 * monitor on the current branch, soonest first, hidden while nothing pends.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"
import type { WakePendingType } from "@gent/extensions/client"
import { formatRemaining, WakeTray, wakeTrayLines } from "../../src/extensions/builtins/wake.client"
import { renderFrame, renderWithProviders } from "../render-harness-boundary"
import { waitForRenderedFrame } from "../helpers-boundary"

const pending: WakePendingType = {
  now: 1_000_000,
  entries: [
    {
      _tag: "monitor",
      wakeId: "m1",
      command: "gh run view 12 --exit-status",
      everySeconds: 60,
      deadline: 1_000_000 + 25 * 60_000,
      note: "merge when green",
    },
    { _tag: "alarm", wakeId: "a1", dueAt: 1_000_000 + 95_000, note: "check the deploy" },
  ],
}

describe("wakeTrayLines", () => {
  it.live("formats remaining time in the largest two units", () =>
    Effect.sync(() => {
      expect(formatRemaining(0)).toBe("now")
      expect(formatRemaining(45_000)).toBe("45s")
      expect(formatRemaining(95_000)).toBe("1m 35s")
      expect(formatRemaining(3_720_000)).toBe("1h 02m")
    }),
  )

  it.live("lists the alarm before the later monitor and collapses the rest", () =>
    Effect.sync(() => {
      expect(wakeTrayLines(pending, 1_000_000, 80)).toEqual([
        "⏰ alarm in 1m 35s · check the deploy",
        "◉ monitor every 1m 00s · 25m 00s left · merge when green",
      ])
      const many: WakePendingType = {
        now: 0,
        entries: [1, 2, 3, 4, 5].map((n) => ({
          _tag: "alarm",
          wakeId: `a${n}`,
          dueAt: n * 1000,
          note: `task ${n}`,
        })),
      }
      const lines = wakeTrayLines(many, 0, 80)
      expect(lines.length).toBe(4)
      expect(lines[3]).toBe("+2 more pending")
      expect(wakeTrayLines(pending, 1_000_000, 20)[0]).toBe("⏰ alarm in 1m 35s...")
    }),
  )
})

describe("Wake tray", () => {
  it.live("shows pending entries and hides once none remain", () =>
    Effect.gen(function* () {
      const [value, setValue] = createSignal<Option.Option<WakePendingType>>(Option.some(pending))
      const setup = yield* Effect.promise(() =>
        renderWithProviders(() => <WakeTray pending={value} now={() => 1_000_000} />),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => renderFrame(setup).includes("alarm in"), "tray"),
      )
      const frame = renderFrame(setup)
      expect(frame).toContain("alarm in 1m 35s · check the deploy")
      expect(frame).toContain("monitor every 1m 00s")
      setValue(Option.some({ now: 1_000_000, entries: [] }))
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => !renderFrame(setup).includes("alarm in"), "tray hidden"),
      )
    }),
  )
})
