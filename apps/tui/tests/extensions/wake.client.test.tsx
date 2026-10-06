/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { DateTime, Effect, Option, Queue } from "effect"
import { createSignal } from "solid-js"
import { WAKE_EXTENSION_ID, type WakePendingType } from "@gent/extensions/client"
import { BranchId, SessionId } from "@gent/core/extensions/api"
import wakeExtension, { WakeTray, wakeLabel, wakeTrayLines } from "../../src/extensions/wake.client"
import { makeClientTestTransport, provideClientServices } from "../extension-test-harness-boundary"
import { renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import { useTheme } from "../../src/theme"
import { KeyHints } from "../../src/ui"

const cancelKey = KeyHints.cancel

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

// ── auto-resume ─────────────────────────────────────────────────────────────

/**
 * An auto-resume shows as its own row: when it fires on the wall clock, the
 * countdown, the attempt, and the key that cancels it. A resume that did not
 * run leaves a notice that says why and when the limit resets.
 */

const utc = () => DateTime.zoneMakeOffset(0)

/** 00:16:40 UTC; the resume fires 47 minutes later, at 01:03:40. */
const RESUME_NOW = 1_000_000

const resumePending: WakePendingType = {
  now: RESUME_NOW,
  entries: [
    {
      _tag: "alarm",
      wakeId: "resume:m-limited:3790000",
      dueAt: RESUME_NOW + 47 * 60_000,
      note: "continue after the usage limit resets",
      resume: { attempt: 1, maxResumes: 3, resetAt: 3_790_000, messageId: "m-limited" },
    },
  ],
}

describe("auto-resume rows", () => {
  it.live("a pending resume names its time, countdown, attempt and the key that cancels it", () =>
    Effect.sync(() => {
      expect(wakeTrayLines(resumePending, RESUME_NOW, 80, utc)).toEqual([
        { glyph: "↻", text: "resume at 01:03 · in 47m 0s · 1/3", keys: [cancelKey] },
      ])
      // A narrow tray keeps the countdown and the key, and drops the rest.
      expect(wakeTrayLines(resumePending, RESUME_NOW, 30, utc)).toEqual([
        { glyph: "↻", text: "resume in 47m 0s", keys: [cancelKey] },
      ])
      // Narrower, the words give way before the key does.
      expect(wakeTrayLines(resumePending, RESUME_NOW, 20, utc)).toEqual([
        { glyph: "↻", text: "in 47m…", keys: [cancelKey] },
      ])
      expect(wakeTrayLines(resumePending, RESUME_NOW, 10, utc)).toEqual([
        { glyph: "↻", text: "", keys: [cancelKey] },
      ])
    }),
  )

  // The key reads as every key hint does, in the `KeyHints` words: the key
  // bright, its verb muted (`keyHintColors`), at every width.
  for (const [width, row] of [
    [100, /^ ↻ resume at \d\d:\d\d · in 47m 0s · 1\/3 · esc cancel$/],
    [40, /^ ↻ resume in 47m 0s · esc cancel$/],
  ] as const) {
    it.scopedLive(`the resume row ends on the key that cancels it at ${width} columns`, () =>
      Effect.gen(function* () {
        let colors = Option.none<ReturnType<typeof useTheme>["theme"]>()
        const setup = yield* renderScoped(
          () => {
            colors = Option.some(useTheme().theme)
            return <WakeTray pending={() => Option.some(resumePending)} now={() => RESUME_NOW} />
          },
          { width, height: 8 },
        )
        yield* waitForFrame(setup, () => renderFrame(setup).includes("↻"), "resume row")
        const line = renderFrame(setup)
          .split("\n")
          .map((text) => text.trimEnd())
          .find((text) => text.includes("↻"))
        expect(line).toMatch(row)
        const theme = Option.getOrThrow(colors)
        const spans = setup.captureSpans().lines.flatMap((spanLine) => spanLine.spans)
        const key = spans.find((span) => span.text.trim() === "esc")
        expect(key?.fg.equals(theme.text)).toBe(true)
        const verb = spans.find((span) => span.text.trim() === "cancel")
        expect(verb?.fg.equals(theme.textMuted)).toBe(true)
      }),
    )
  }

  it.live("a resume that did not run says why and when the limit resets", () =>
    Effect.sync(() => {
      const notices: WakePendingType = {
        now: RESUME_NOW,
        entries: [
          {
            _tag: "notice",
            wakeId: "resume:m-capped:4600000",
            outcome: "fired",
            firedAt: RESUME_NOW - 60_000,
            content: "Auto-resume stopped after 3 attempts.",
            note: "auto-resume stopped after 3 attempts",
            resume: { resetAt: 4_600_000 },
          },
          {
            _tag: "notice",
            wakeId: "resume:m-late:0",
            outcome: "fired",
            firedAt: RESUME_NOW - 120_000,
            content: "Auto-resume skipped.",
            note: "auto-resume skipped: gent was not running",
            resume: { resetAt: 0 },
          },
        ],
      }
      expect(wakeTrayLines(notices, RESUME_NOW, 80, utc)).toEqual([
        { glyph: "↻", text: "auto-resume skipped: gent was not running · reset 00:00" },
        { glyph: "↻", text: "auto-resume stopped after 3 attempts · resets 01:16" },
      ])
    }),
  )

  it.live("a fired resume reads as a resume, not an alarm", () =>
    Effect.sync(() => {
      expect(
        wakeLabel(
          Option.some({
            outcome: "fired",
            note: "continue after the usage limit resets",
            firedAt: 3_820_000,
            resume: { attempt: 2, resetAt: 3_790_000 },
          }),
        ),
      ).toEqual({ glyph: "↻", label: "resumed after the usage limit reset · attempt 2" })
    }),
  )

  // Esc on an idle composer cancels the pending resume: the wake client's
  // stoppable dismisses it on the server by id and says so.
  it.scopedLive("the stoppable dismisses the pending resume by id", () =>
    Effect.gen(function* () {
      const dismissed: Array<unknown> = []
      const notes: Array<string> = []
      let entries = resumePending.entries
      const contributions = yield* provideClientServices(wakeExtension.setup, {
        requestEffect: (request) =>
          Effect.sync(() => {
            if (request.capabilityId === "wake.dismiss") {
              dismissed.push(request.input)
              entries = []
              return { dismissed: ["resume:m-limited:3790000"] }
            }
            return { now: RESUME_NOW, entries } satisfies WakePendingType
          }),
        shell: { notify: (message) => notes.push(message) },
      })
      const stoppables = Option.getOrElse(
        Option.fromUndefinedOr(contributions.stoppables),
        () => [],
      )
      expect(stoppables.map((stoppable) => stoppable.id)).toEqual(["wake.resume"])
      const active = () => stoppables.some((stoppable) => stoppable.active())
      yield* waitUntil(active, "the pending resume read")
      for (const stoppable of stoppables) stoppable.stop()
      yield* waitUntil(() => notes.length > 0, "the cancel reported")
      expect(dismissed).toEqual([{ wakeId: "resume:m-limited:3790000" }])
      expect(notes).toEqual(["auto-resume cancelled"])
      yield* waitUntil(() => !active(), "no resume pending")
    }).pipe(Effect.timeout("4 seconds")),
  )

  // The resume fired between the tray's read and the dismiss: the server has
  // nothing left to cancel, and the turn it started is running.
  it.scopedLive("a dismiss that cancels nothing says the resume already fired", () =>
    Effect.gen(function* () {
      const notes: Array<string> = []
      let entries = resumePending.entries
      const contributions = yield* provideClientServices(wakeExtension.setup, {
        requestEffect: (request) =>
          Effect.sync(() => {
            if (request.capabilityId === "wake.dismiss") {
              entries = []
              return { dismissed: [] }
            }
            return { now: RESUME_NOW, entries } satisfies WakePendingType
          }),
        shell: { notify: (message) => notes.push(message) },
      })
      const stoppables = Option.getOrElse(
        Option.fromUndefinedOr(contributions.stoppables),
        () => [],
      )
      const active = () => stoppables.some((stoppable) => stoppable.active())
      yield* waitUntil(active, "the pending resume read")
      for (const stoppable of stoppables) stoppable.stop()
      yield* waitUntil(() => notes.length > 0, "the dismiss reported")
      expect(notes).toEqual(["auto-resume already fired"])
    }).pipe(Effect.timeout("4 seconds")),
  )

  it.live(
    "a pending resume keeps its row when more entries than the tray shows are due first",
    () =>
      Effect.sync(() => {
        const alarm = (wakeId: string, inSeconds: number) => ({
          _tag: "alarm" as const,
          wakeId,
          dueAt: RESUME_NOW + inSeconds * 1000,
          note: `check ${wakeId}`,
        })
        const crowded: WakePendingType = {
          now: RESUME_NOW,
          entries: [alarm("a1", 60), alarm("a2", 120), alarm("a3", 180), ...resumePending.entries],
        }
        expect(wakeTrayLines(crowded, RESUME_NOW, 80, utc)).toEqual([
          { glyph: "↻", text: "resume at 01:03 · in 47m 0s · 1/3", keys: [cancelKey] },
          { glyph: "◷", text: "alarm in 1m 0s · check a1" },
          { glyph: "◷", text: "alarm in 2m 0s · check a2" },
          { glyph: " ", text: "+1 more pending" },
        ])
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
