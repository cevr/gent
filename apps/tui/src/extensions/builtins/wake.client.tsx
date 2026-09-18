/** @jsxImportSource @opentui/solid */
/**
 * The wake tray under the status line.
 *
 * One dim line per alarm or monitor still pending on the current branch,
 * from `WakeRpc.List`; hidden while nothing is pending. Reads again when a
 * tool call starts or a message lands, and on a slow clock while it shows
 * anything, so the countdowns move.
 */
import { DateTime, Effect, Match, Option, Schedule } from "effect"
import { For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  WAKE_EXTENSION_ID,
  WakeRpc,
  type WakeEntryType,
  type WakePendingType,
} from "@gent/extensions/client.js"
import { useTheme } from "../../theme"
import { useTerminalDimensions } from "../../terminal-dimensions"
import { useSpinnerClock } from "../../hooks/use-spinner-clock"
import { clientContributions, defineClientExtension, widgetContribution } from "../client-facets.js"
import { ClientTransport } from "../client-transport"
import { ClientLifecycle, ClientShell, makeClientSessionResource } from "../client-services"
import { truncate } from "../../utils"

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

const entryLine = (entry: WakeEntryType, now: number, width: number): WakeTrayLine =>
  Match.type<WakeEntryType>().pipe(
    Match.tagsExhaustive({
      alarm: (alarm): WakeTrayLine => ({
        glyph: ALARM_GLYPH,
        text: truncate(`alarm in ${formatRemaining(alarm.dueAt - now)} · ${alarm.note}`, width),
      }),
      monitor: (monitor): WakeTrayLine => {
        const every = formatRemaining(monitor.everySeconds * 1000)
        const left = formatRemaining(monitor.deadline - now)
        return {
          glyph: MONITOR_GLYPH,
          text: truncate(`monitor every ${every} · ${left} left · ${monitor.note}`, width),
        }
      },
    }),
  )(entry)

/** One line per pending entry, soonest first; past the cap the rest collapse into one count line. */
export const wakeTrayLines = (
  pending: WakePendingType,
  now: number,
  width: number,
): ReadonlyArray<WakeTrayLine> => {
  const dueOf = (entry: WakeEntryType): number => {
    if (entry._tag === "alarm") return entry.dueAt
    return entry.deadline
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
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <For each={lines()}>
          {(line) => (
            <text wrapMode="none">
              <span style={{ fg: theme.info }}>{`${line.glyph} `}</span>
              <span style={{ fg: theme.textMuted }}>{line.text}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  "ToolCallStarted",
  "MessageReceived",
  "TurnCompleted",
])

export default defineClientExtension(WAKE_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const pending = yield* makeClientSessionResource<WakePendingType>({
      transport,
      lifecycle,
      cast: shell.cast,
      label: `${WAKE_EXTENSION_ID} pending`,
      fetch: (session) => transport.request(ref(WakeRpc.List), {}, session),
      subscribe: (refetch) =>
        transport.onSessionEvent((envelope) => {
          if (REFRESH_EVENTS.has(envelope.event._tag)) refetch()
        }),
    })

    const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())
    const current = (): Option.Option<WakePendingType> => Option.fromNullishOr(pending.read())

    // A pending entry changes nothing in this session until it fires, so the
    // list is re-read on a slow clock only while it shows something.
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sync(() => {
          const value = Option.fromNullishOr(pending.read())
          if (Option.isSome(value) && value.value.entries.length > 0) pending.refetch()
        }).pipe(Effect.repeat(Schedule.spaced("5 seconds"))),
      ),
    )

    return clientContributions(
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
          return <WakeTray pending={current} now={now} />
        },
      }),
    )
  }),
})
