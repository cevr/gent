/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Match, Option, Predicate, Schedule, Schema } from "effect"
import { For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  WAKE_EXTENSION_ID,
  WAKE_MESSAGE_TYPE,
  WakeDetails,
  type WakeEntryType,
  type WakePendingType,
  WakeRpc,
} from "@gent/extensions/client"
import {
  ClientContext,
  clientContributions,
  CollapsedRow,
  type CollapsedRowProps,
  defineClientExtension,
  formatClock,
  formatDuration,
  type KeyHint,
  KeyHints,
  KeyHintsText,
  keyHintsWidth,
  messageRendererContribution,
  sessionQuery,
  stoppableContribution,
  textWidth,
  TrayFrame,
  truncate,
  useSpinnerClock,
  useTerminalDimensions,
  useTheme,
  widgetContribution,
} from "@gent/tui/extensions"

// ── wake tray ───────────────────────────────────────────────────────────────

/**
 * The wake tray under the status line.
 *
 * One dim line per alarm or monitor still pending on the current branch,
 * from `WakeRpc.Pending`; hidden while nothing is pending. Reads again when a
 * tool call starts or a message lands, and on a slow clock while it shows
 * anything, so the countdowns move.
 */

const TRAY_MAX_ROWS = 3

/** `1h 2m`, `4m 20s`, `45s` as the agents pane spells them, or `now` under a second. */
const formatRemaining = (millis: number): string => {
  if (millis < 1000) return "now"
  return formatDuration(millis, "compact")
}

interface WakeTrayLine {
  readonly glyph: string
  readonly text: string
  /** The keys the row ends on, in the `KeyHints` words; they show at every width. */
  readonly keys?: ReadonlyArray<KeyHint>
}

/** The separator between a row's words and its keys. */
const KEYS_SEPARATOR = " · "

/** fx-style marks: a clock face for an alarm, a fisheye for a monitor, a bare dot for the overflow line. */
const ALARM_GLYPH = "◷"
const MONITOR_GLYPH = "◉"
const NOTICE_GLYPH = "◆"
/** An auto-resume: the turn a usage limit stopped, run again once the limit resets. */
const RESUME_GLYPH = "↻"

type AlarmEntry = Extract<WakeEntryType, { readonly _tag: "alarm" }>
type ResumeAlarm = NonNullable<AlarmEntry["resume"]>
type NoticeEntry = Extract<WakeEntryType, { readonly _tag: "notice" }>
type ResumeNotice = NonNullable<NoticeEntry["resume"]>

/**
 * `resume at 17:05 · in 47m 0s · 1/3 · esc cancel`: the wall clock it fires
 * at, the countdown, the attempt, and the key that cancels it. A narrow tray
 * drops the clock and the attempt, then the word `resume`, then cuts the
 * countdown; the key stays at every width.
 */
const resumeLine = (
  alarm: AlarmEntry,
  resume: ResumeAlarm,
  now: number,
  width: number,
  zone: () => DateTime.TimeZone,
): WakeTrayLine => {
  const keys = [KeyHints.cancel]
  const room = width - keyHintsWidth(keys) - textWidth(KEYS_SEPARATOR)
  const left = formatRemaining(alarm.dueAt - now)
  const words = [
    `resume at ${formatClock(alarm.dueAt, now, zone())} · in ${left} · ${resume.attempt}/${resume.maxResumes}`,
    `resume in ${left}`,
    `in ${left}`,
  ]
  const text =
    words.find((candidate) => textWidth(candidate) <= room) ?? truncate(`in ${left}`, room)
  return { glyph: RESUME_GLYPH, text, keys }
}

/** A resume that did not run: why, and when the limit resets (or did). */
const resumeNoticeLine = (
  notice: NoticeEntry,
  resume: ResumeNotice,
  now: number,
  width: number,
  zone: () => DateTime.TimeZone,
): WakeTrayLine => {
  const clock = formatClock(resume.resetAt, now, zone())
  const line = (verb: string): WakeTrayLine => ({
    glyph: RESUME_GLYPH,
    text: truncate(`${notice.note} · ${verb} ${clock}`, width),
  })
  if (resume.resetAt > now) return line("resets")
  return line("reset")
}

/** The kind word says what the fire does: `(notify)` leaves a notice instead of starting a turn. */
const kindOf = (entry: { readonly mode?: "wake" | "notify" }, kind: string): string => {
  if (entry.mode === "notify") return `${kind} (notify)`
  return kind
}

/** `2m ago`, or `just now` under a second. */
const formatAgo = (millis: number): string => {
  const remaining = formatRemaining(millis)
  if (remaining === "now") return "just now"
  return `${remaining} ago`
}

const entryLine = (
  entry: WakeEntryType,
  now: number,
  width: number,
  zone: () => DateTime.TimeZone,
): WakeTrayLine =>
  Match.type<WakeEntryType>().pipe(
    Match.tagsExhaustive({
      alarm: (alarm): WakeTrayLine => {
        if (Predicate.isNotUndefined(alarm.resume)) {
          return resumeLine(alarm, alarm.resume, now, width, zone)
        }
        const cadence = Option.match(Option.fromUndefinedOr(alarm.everySeconds), {
          onNone: () => "",
          onSome: (seconds) => ` · every ${formatRemaining(seconds * 1000)}`,
        })
        return {
          glyph: ALARM_GLYPH,
          text: truncate(
            `${kindOf(alarm, "alarm")} in ${formatRemaining(alarm.dueAt - now)}${cadence} · ${alarm.note}`,
            width,
          ),
        }
      },
      monitor: (monitor): WakeTrayLine => {
        const every = formatRemaining(monitor.everySeconds * 1000)
        const left = formatRemaining(monitor.deadline - now)
        return {
          glyph: MONITOR_GLYPH,
          text: truncate(
            `${kindOf(monitor, "monitor")} every ${every} · ${left} left · ${monitor.note}`,
            width,
          ),
        }
      },
      notice: (notice): WakeTrayLine => {
        if (Predicate.isNotUndefined(notice.resume)) {
          return resumeNoticeLine(notice, notice.resume, now, width, zone)
        }
        return {
          glyph: NOTICE_GLYPH,
          text: truncate(
            `${notice.outcome} ${formatAgo(now - notice.firedAt)} · ${notice.note}`,
            width,
          ),
        }
      },
    }),
  )(entry)

/**
 * One line per pending entry, soonest first; past the cap the rest collapse
 * into one count line. A pending auto-resume comes first whatever its due
 * time: its row names the key that cancels it, and the cap must not hide
 * it. Clock times read in the zone `zone` gives, the viewer's own unless a
 * test fixes it.
 */
export const wakeTrayLines = (
  pending: WakePendingType,
  now: number,
  width: number,
  zone: () => DateTime.TimeZone = DateTime.zoneMakeLocal,
): ReadonlyArray<WakeTrayLine> => {
  // The pending resume, then the notices (already fired), then the rest by due time.
  const rankOf = (entry: WakeEntryType): number => {
    if (entry._tag === "alarm" && Predicate.isNotUndefined(entry.resume)) return 0
    if (entry._tag === "notice") return 1
    return 2
  }
  const dueOf = (entry: WakeEntryType): number => {
    if (entry._tag === "alarm") return entry.dueAt
    if (entry._tag === "monitor") return entry.deadline
    return entry.firedAt
  }
  const sorted = [...pending.entries].sort((a, b) => rankOf(a) - rankOf(b) || dueOf(a) - dueOf(b))
  const shown = sorted.slice(0, TRAY_MAX_ROWS)
  const lines = shown.map((entry) => entryLine(entry, now, width, zone))
  const rest = sorted.length - shown.length
  if (rest > 0) lines.push({ glyph: " ", text: `+${rest} more pending` })
  return lines
}

export function WakeTray(props: {
  readonly pending: () => Option.Option<WakePendingType>
  readonly now: () => number
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const textWidth = () => Math.max(8, dimensions().width - 4)
  const lines = () =>
    Option.match(props.pending(), {
      onNone: (): ReadonlyArray<WakeTrayLine> => [],
      onSome: (value) => wakeTrayLines(value, props.now(), textWidth()),
    })
  return (
    <Show when={lines().length > 0}>
      <TrayFrame>
        <For each={lines()}>
          {(line) => (
            <text wrapMode="none">
              <span style={{ fg: theme.info }}>{`${line.glyph} `}</span>
              <span style={{ fg: theme.textMuted }}>{line.text}</span>
              <Show when={line.keys}>
                {(keys) => (
                  <>
                    <Show when={line.text.length > 0}>
                      <span style={{ fg: theme.textMuted }}>{KEYS_SEPARATOR}</span>
                    </Show>
                    <KeyHintsText hints={keys()} />
                  </>
                )}
              </Show>
            </text>
          )}
        </For>
      </TrayFrame>
    </Show>
  )
}

// ── fired row ──

/** A fired wake shows what fired and the note the model left itself, not the full line. */
const decodeWakeDetails = Schema.decodeUnknownOption(WakeDetails)

const wakeHead = (value: WakeDetails): CollapsedRowProps => {
  if (value.outcome === "fired") return { glyph: ALARM_GLYPH, label: "alarm fired" }
  if (value.outcome === "timed-out") return { glyph: MONITOR_GLYPH, label: "monitor timed out" }
  return { glyph: MONITOR_GLYPH, label: "monitor matched" }
}

/** A resume's fire names the attempt instead of the note, which only says what it does. */
export const wakeLabel = (wake: Option.Option<WakeDetails>): CollapsedRowProps =>
  Option.match(wake, {
    onNone: () => ({ glyph: ALARM_GLYPH, label: "alarm fired" }),
    onSome: (value) => {
      if (Predicate.isNotUndefined(value.resume)) {
        return {
          glyph: RESUME_GLYPH,
          label: `resumed after the usage limit reset · attempt ${value.resume.attempt}`,
        }
      }
      const head = wakeHead(value)
      return { glyph: head.glyph, label: `${head.label} · ${value.note}` }
    },
  })

const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "ToolCallStarted",
  "MessageReceived",
  "TurnCompleted",
])

export default defineClientExtension(WAKE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle, shell } = yield* ClientContext

    const pending = yield* sessionQuery({
      initial: Option.none<WakePendingType>(),
      follow: true,
      fetch: (session) => transport.request(ref(WakeRpc.Pending), {}, session).pipe(Effect.asSome),
    })
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        if (REFRESH_EVENTS.has(envelope.event._tag)) pending.refresh()
      }),
    )
    // The server pulses `@gent/wake` when an entry is added, fires or is
    // cancelled, so the tray changes on the pulse, not the next poll.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId === WAKE_EXTENSION_ID) pending.refresh()
      }),
    )

    const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

    // A pending entry changes nothing in this session until it fires, so the
    // list is re-read on a slow clock only while it shows something.
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sync(() => {
          const value = pending.value()
          if (Option.isSome(value) && value.value.entries.length > 0) pending.refresh()
        }).pipe(Effect.repeat(Schedule.spaced("5 seconds"))),
      ),
    )

    // The auto-resume pending on the branch in view, by id: Esc on an idle,
    // empty composer cancels it on the server, and the pulse that follows
    // clears its tray row. A dismiss that removed nothing came after the
    // fire: the resume already queued its line, so it says that instead.
    const pendingResume = (): Option.Option<string> =>
      Option.flatMap(pending.value(), (value) =>
        Option.fromUndefinedOr(
          value.entries.find(
            (entry) => entry._tag === "alarm" && Predicate.isNotUndefined(entry.resume),
          ),
        ),
      ).pipe(Option.map((entry) => entry.wakeId))
    const cancelResume = (wakeId: string) =>
      shell.cast(
        transport.request(ref(WakeRpc.Dismiss), { wakeId }).pipe(
          Effect.andThen(({ dismissed }) =>
            Effect.sync(() => {
              if (dismissed.includes(wakeId)) return shell.notify("auto-resume cancelled")
              return shell.notify("auto-resume already fired")
            }),
          ),
          Effect.catch((failure) =>
            Effect.sync(() => shell.notify(`auto-resume: not cancelled: ${failure.message}`)),
          ),
          Effect.ensuring(Effect.sync(pending.refresh)),
        ),
      )

    return clientContributions(
      stoppableContribution({
        id: "wake.resume",
        active: () => Option.isSome(pendingResume()),
        stop: () => {
          Option.map(pendingResume(), cancelResume)
        },
      }),
      messageRendererContribution(WAKE_MESSAGE_TYPE, (props) => (
        <CollapsedRow {...wakeLabel(decodeWakeDetails(props.details))} />
      )),
      widgetContribution({
        id: "wake.tray",
        slot: "below-input",
        priority: 45,
        component: () => {
          // Entries carry epoch times; the spinner clock re-reads the local
          // clock so the countdown moves between server reads.
          const tick = useSpinnerClock()
          const now = () => {
            tick()
            return nowMillis()
          }
          return <WakeTray pending={pending.value} now={now} />
        },
      }),
    )
  }),
})
