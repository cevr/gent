/** @jsxImportSource @opentui/solid */
/**
 * The machines extension's client side: the lanes band under the status
 * line, and one `gent ctl` view.
 *
 * The band's first row is the server's free lanes (`accounts.lanes`), the
 * row `gent ctl lanes --line` prints; each active run of this session's
 * thread follows, from `MachinesRpc.Runs`. It hides while gent read no
 * quota window and no run is active. It reads again when a turn completes,
 * when the connection comes back, and every 30 s.
 *
 * `gent ctl status --run <run>` reads one machine run (its state, status,
 * pending action and last steps) as a session of the owner's thread,
 * through `MachinesRpc.Status`, the view `machine.status` gives the model.
 */
import { DateTime, Effect, Option, Predicate } from "effect"
import { createEffect, createRoot, For, on, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import type { LaneReport } from "@gent/core/protocol"
import { type MachineRunView, MachinesRpc } from "@gent/extensions/client"
import {
  ClientContext,
  clientContributions,
  ctlProjection,
  defineClientExtension,
  formatAge,
  formatClock,
  laneRows,
  sessionQuery,
  textWidth,
  TrayFrame,
  truncate,
  useSpinnerClock,
  useTerminalDimensions,
  useTheme,
  widgetContribution,
} from "@gent/tui/extensions"

// ── band rows ───────────────────────────────────────────────────────────────

/** What the band reads: the lanes, none until they answer, and this thread's runs. */
export interface BandData {
  readonly lanes: Option.Option<LaneReport>
  readonly runs: ReadonlyArray<MachineRunView>
}

/** The tone of a row's glyph: a free lane, none left, a run at work, a run that waits. */
type BandTone = "free" | "none" | "unknown" | "running" | "asking" | "waiting"

interface BandRow {
  readonly glyph: string
  readonly tone: BandTone
  readonly text: string
}

/** Single marks, fx style: lanes, a running run, an asking run, a run that waits for its account. */
const LANES_GLYPH = "≡"
const RUN_GLYPH = "▸"
const ASK_GLYPH = "?"
const WAIT_GLYPH = "◷"

const BAND_MAX_RUNS = 4

const isActive = (run: MachineRunView): boolean =>
  run.status === "running" || run.status === "asking"

/** The time a run's round waits until, while it is still ahead. */
const waitsUntil = (run: MachineRunView, now: number): Option.Option<number> => {
  const pending = run.pending
  if (Predicate.isUndefined(pending) || pending._tag !== "Round") return Option.none()
  return Option.filter(Option.fromUndefinedOr(pending.notBefore), (until) => until > now)
}

/** `track implement r2 4m`, then `· wait 17:05` while its round waits for its account. */
const runRow = (
  run: MachineRunView,
  now: number,
  width: number,
  zone: DateTime.TimeZone,
): BandRow => {
  const head = `${run.machine} ${run.state} r${run.visits[run.state] ?? 0} ${formatAge(now - run.createdAt)}`
  return Option.match(waitsUntil(run, now), {
    onNone: () => {
      if (run.status === "asking")
        return { glyph: ASK_GLYPH, tone: "asking", text: truncate(head, width) }
      return { glyph: RUN_GLYPH, tone: "running", text: truncate(head, width) }
    },
    onSome: (until) => {
      const full = `${head} · wait ${formatClock(until, now, zone)}`
      if (textWidth(full) <= width) return { glyph: WAIT_GLYPH, tone: "waiting", text: full }
      return { glyph: WAIT_GLYPH, tone: "waiting", text: truncate(head, width) }
    },
  })
}

/**
 * The band: the lanes rows, then one row per active run, oldest first, up
 * to four and a count of the rest. Empty while gent read no quota window,
 * the owner's Sabbath does not hold the lanes and no run is active, so the
 * band hides. `width` is the text's columns.
 */
export const bandRows = (
  data: BandData,
  now: number,
  width: number,
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): ReadonlyArray<BandRow> => {
  const active = data.runs.filter(isActive).toSorted((a, b) => a.createdAt - b.createdAt)
  const measured = Option.exists(
    data.lanes,
    (report) =>
      report.providers.length > 0 ||
      (Predicate.isNotUndefined(report.sabbathEnd) && report.sabbathEnd > now),
  )
  if (!measured && active.length === 0) return []
  const report = Option.getOrElse(data.lanes, (): LaneReport => ({ providers: [] }))
  const lanes = laneRows(report, now, width, zone).map((row): BandRow => ({
    glyph: LANES_GLYPH,
    tone: row.state,
    text: row.text,
  }))
  const shown = active.slice(0, BAND_MAX_RUNS).map((run) => runRow(run, now, width, zone))
  const rest = active.length - BAND_MAX_RUNS
  if (rest <= 0) return [...lanes, ...shown]
  return [...lanes, ...shown, { glyph: " ", tone: "running", text: `+${rest} more runs` }]
}

export function LanesBand(props: { readonly data: () => BandData; readonly now: () => number }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  // The frame pads a column each side, and the glyph takes two.
  const textColumns = () => Math.max(8, dimensions().width - 4)
  const rows = () => bandRows(props.data(), props.now(), textColumns())
  const toneColor = (tone: BandTone) => {
    if (tone === "free") return theme.success
    if (tone === "none") return theme.warning
    if (tone === "asking") return theme.warning
    if (tone === "running") return theme.info
    return theme.textMuted
  }
  return (
    <Show when={rows().length > 0}>
      <TrayFrame>
        <For each={rows()}>
          {(row) => (
            <text wrapMode="none">
              <span style={{ fg: toneColor(row.tone) }}>{`${row.glyph} `}</span>
              <span style={{ fg: theme.textMuted }}>{row.text}</span>
            </text>
          )}
        </For>
      </TrayFrame>
    </Show>
  )
}

// ── extension ───────────────────────────────────────────────────────────────

const statusRef = ref(MachinesRpc.Status)
const runsRef = ref(MachinesRpc.Runs)

const EMPTY_BAND: BandData = { lanes: Option.none(), runs: [] }

export default defineClientExtension(statusRef.extensionId, {
  setup: Effect.gen(function* () {
    const { transport, lifecycle } = yield* ClientContext

    // One read for both: a failed half keeps the other, so a server with no
    // machines extension still shows its lanes.
    const band = yield* sessionQuery({
      initial: EMPTY_BAND,
      follow: true,
      fetch: (session) =>
        Effect.all(
          {
            lanes: transport.accountLanes.pipe(Effect.option),
            runs: transport
              .request(runsRef, {}, session)
              .pipe(Effect.orElseSucceed((): ReadonlyArray<MachineRunView> => [])),
          },
          { concurrency: 2 },
        ),
    })
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        if (envelope.event._tag === "TurnCompleted") band.refresh()
      }),
    )
    // A reconnect may land on a restarted server: its lanes and runs moved.
    createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      createEffect(
        on(
          transport.connection,
          (generation) => {
            if (Option.isSome(generation)) band.refresh()
          },
          { defer: true },
        ),
      )
    })
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sleep("30 seconds").pipe(Effect.andThen(Effect.sync(band.refresh)), Effect.forever),
      ),
    )

    return clientContributions(
      widgetContribution({
        id: "machines.band",
        slot: "below-input",
        priority: 50,
        component: () => {
          // Ages and waits read the local clock; the spinner clock redraws them.
          const tick = useSpinnerClock()
          const now = () => {
            tick()
            return DateTime.toEpochMillis(DateTime.nowUnsafe())
          }
          return <LanesBand data={band.value} now={now} />
        },
      }),
    )
  }),
  ctl: [
    ctlProjection({
      command: "status",
      flag: "run",
      description: "A machine run's state, status, pending action and last steps (@gent/machines)",
      request: statusRef,
      input: (run) => ({ run }),
    }),
  ],
})
