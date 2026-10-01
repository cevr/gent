/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Queue } from "effect"
import { createSignal } from "solid-js"
import { WAKE_EXTENSION_ID, type WakePendingType } from "@gent/extensions/client"
import { BranchId, SessionId } from "@gent/core/extensions/api"
import wakeExtension, { WakeTray, wakeTrayLines } from "../../src/extensions/wake.client"
import { makeClientTestTransport, provideClientServices } from "../extension-test-harness-boundary"
import { renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame } from "../helpers-boundary"

// ── wake tray ───────────────────────────────────────────────────────────────

/**
 * The wake tray under the status line: one dim line per pending alarm or
 * monitor on the current branch, soonest first, hidden while nothing pends.
 */

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
  it.live("an hour left reads as the agents pane spells an hour", () =>
    Effect.sync(() => {
      const long: WakePendingType = {
        now: 0,
        entries: [
          {
            _tag: "monitor",
            wakeId: "m",
            command: "true",
            everySeconds: 45,
            deadline: 3_720_000,
            note: "soak",
          },
        ],
      }
      expect(wakeTrayLines(long, 0, 80)).toEqual([
        { glyph: "◉", text: "monitor every 45s · 1h 2m left · soak" },
      ])
    }),
  )

  it.live("lists the alarm before the later monitor and collapses the rest", () =>
    Effect.sync(() => {
      expect(wakeTrayLines(pending, 1_000_000, 80)).toEqual([
        { glyph: "◷", text: "alarm in 1m 35s · check the deploy" },
        { glyph: "◉", text: "monitor every 1m 0s · 25m 0s left · merge when green" },
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
      expect(lines[3]?.text).toBe("+2 more pending")
      const repeating: WakePendingType = {
        now: 0,
        entries: [
          {
            _tag: "alarm",
            wakeId: "r",
            dueAt: 60_000,
            everySeconds: 300,
            mode: "notify",
            note: "stretch",
          },
        ],
      }
      expect(wakeTrayLines(repeating, 0, 80)).toEqual([
        { glyph: "◷", text: "alarm (notify) in 1m 0s · every 5m 0s · stretch" },
      ])
      const noticed: WakePendingType = {
        now: 120_000,
        entries: [
          { _tag: "alarm", wakeId: "a", dueAt: 130_000, note: "later" },
          {
            _tag: "notice",
            wakeId: "n",
            outcome: "fired",
            firedAt: 0,
            content: "Alarm n fired.",
            note: "stand up",
          },
        ],
      }
      expect(wakeTrayLines(noticed, 120_000, 80)).toEqual([
        { glyph: "◆", text: "fired 2m 0s ago · stand up" },
        { glyph: "◷", text: "alarm in 10s · later" },
      ])
      expect(wakeTrayLines(pending, 1_000_000, 20)[0]?.text).toBe("alarm in 1m 35s · c…")
    }),
  )
})

describe("Wake tray", () => {
  it.live("a CJK note stays inside the tray's column budget", () =>
    Effect.sync(() => {
      const wide: WakePendingType = {
        now: 1_000_000,
        entries: [
          { _tag: "alarm", wakeId: "a2", dueAt: 1_000_000 + 60_000, note: "部署を確認する" },
        ],
      }
      const [line] = wakeTrayLines(wide, wide.now, 24)
      expect(Option.isSome(Option.fromNullishOr(line))).toBe(true)
      const text = Option.getOrElse(
        Option.map(Option.fromNullishOr(line), (l) => l.text),
        () => "",
      )
      expect(text.length).toBeLessThanOrEqual(24)
      expect(Bun.stringWidth(text)).toBeLessThanOrEqual(24)
      expect(text.endsWith("…")).toBe(true)
    }),
  )

  it.scopedLive("shows pending entries and hides once none remain", () =>
    Effect.gen(function* () {
      const [value, setValue] = createSignal<Option.Option<WakePendingType>>(Option.some(pending))
      const setup = yield* renderScoped(() => <WakeTray pending={value} now={() => 1_000_000} />)
      yield* waitForFrame(setup, () => renderFrame(setup).includes("alarm in"), "tray")
      const frame = renderFrame(setup)
      expect(frame).toContain("◷ alarm in 1m 35s · check the deploy")
      expect(frame).toContain("◉ monitor every 1m 0s")
      setValue(Option.some({ now: 1_000_000, entries: [] }))
      yield* waitForFrame(setup, () => !renderFrame(setup).includes("alarm in"), "tray hidden")
    }),
  )
})

// ── wake tray reads ─────────────────────────────────────────────────────────

describe("wake tray reads", () => {
  // An alarm set or fired changes the tray at once: the server pulses
  // `@gent/wake`, and the tray reads its entries again on that pulse.
  it.scopedLive("a wake state pulse reads the pending entries again", () =>
    Effect.gen(function* () {
      const session = { sessionId: SessionId.make("s"), branchId: BranchId.make("s-branch") }
      const reads = yield* Queue.unbounded<void>()
      const pulses = new Set<
        (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void
      >()
      const pulse = (extensionId: string) => {
        for (const cb of pulses) cb({ ...session, extensionId })
      }
      const options = {
        currentSession: () => session,
        requestEffect: () =>
          Queue.offer(reads, void 0).pipe(
            Effect.as({ now: 0, entries: [] } satisfies WakePendingType),
          ),
      }
      yield* provideClientServices(
        Effect.gen(function* () {
          yield* wakeExtension.setup
          // The tray follows its session, so it reads once as it mounts.
          yield* Queue.take(reads)
          pulse("@gent/other")
          pulse(WAKE_EXTENSION_ID)
          yield* Queue.take(reads)
          // One read per wake pulse; another extension's pulse reads nothing.
          expect(yield* Queue.size(reads)).toBe(0)
        }).pipe(Effect.orDie),
        {
          ...options,
          transport: {
            ...makeClientTestTransport(options),
            onExtensionStateChanged: (cb) => {
              pulses.add(cb)
              return () => {
                pulses.delete(cb)
              }
            },
          },
        },
      )
    }).pipe(Effect.timeout("4 seconds")),
  )
})
