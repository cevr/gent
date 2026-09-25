/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Match, Option, Schedule, Schema } from "effect"
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
  defineClientExtension,
  messageRendererContribution,
  sessionQuery,
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

/** `1h 02m`, `4m 20s`, `45s`, or `now`. */
export const formatRemaining = (millis: number): string => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  if (seconds === 0) return "now"
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}

interface WakeTrayLine {
  readonly glyph: string
  readonly text: string
}

/** fx-style marks: a clock face for an alarm, a fisheye for a monitor, a bare dot for the overflow line. */
const ALARM_GLYPH = "◷"
const MONITOR_GLYPH = "◉"
const NOTICE_GLYPH = "◆"

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

const entryLine = (entry: WakeEntryType, now: number, width: number): WakeTrayLine =>
  Match.type<WakeEntryType>().pipe(
    Match.tagsExhaustive({
      alarm: (alarm): WakeTrayLine => {
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
      notice: (notice): WakeTrayLine => ({
        glyph: NOTICE_GLYPH,
        text: truncate(
          `${notice.outcome} ${formatAgo(now - notice.firedAt)} · ${notice.note}`,
          width,
        ),
      }),
    }),
  )(entry)

/** One line per pending entry, soonest first; past the cap the rest collapse into one count line. */
export const wakeTrayLines = (
  pending: WakePendingType,
  now: number,
  width: number,
): ReadonlyArray<WakeTrayLine> => {
  // A notice already fired, so it sorts ahead of everything still pending.
  const dueOf = (entry: WakeEntryType): number => {
    if (entry._tag === "alarm") return entry.dueAt
    if (entry._tag === "monitor") return entry.deadline
    return entry.firedAt - Number.MAX_SAFE_INTEGER
  }
  const sorted = [...pending.entries].sort((a, b) => dueOf(a) - dueOf(b))
  const shown = sorted.slice(0, TRAY_MAX_ROWS)
  const lines = shown.map((entry) => entryLine(entry, now, width))
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

const wakeHead = (value: WakeDetails): string => {
  if (value.outcome === "fired") return `${ALARM_GLYPH} alarm fired`
  if (value.outcome === "timed-out") return `${MONITOR_GLYPH} monitor timed out`
  return `${MONITOR_GLYPH} monitor matched`
}

const wakeLabel = (wake: Option.Option<WakeDetails>): string =>
  Option.match(wake, {
    onNone: () => `${ALARM_GLYPH} alarm fired`,
    onSome: (value) => `${wakeHead(value)} · ${value.note}`,
  })

const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "ToolCallStarted",
  "MessageReceived",
  "TurnCompleted",
])

export default defineClientExtension(WAKE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle } = yield* ClientContext

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

    return clientContributions(
      messageRendererContribution(WAKE_MESSAGE_TYPE, (props) => (
        <CollapsedRow label={wakeLabel(decodeWakeDetails(props.details))} />
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
