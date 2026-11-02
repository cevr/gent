/** @jsxImportSource @opentui/solid */
/**
 * The machines extension's client side: the lanes band under the status
 * line, and one `gent ctl` view.
 *
 * The band shows what needs the owner or runs now: the lanes rows of the
 * session's provider that are refused or wait (a refusal, a usage-limit
 * wait, a lost login, the Sabbath), the peer's row while the peer changes
 * what this server does (silent with runs in the hold, a link down while it
 * was heard inside the hold), and each active run of this session's thread,
 * from `MachinesRpc.Runs`. It hides while none does. Every
 * lanes row (`accounts.lanes`, the rows `gent ctl lanes --line` prints) is
 * in the `/status` pane. It reads again when a turn completes, when the
 * connection comes back, and every 30 s.
 *
 * `gent ctl status --run <run>` reads one machine run (its state, status,
 * pending action and last steps) as a session of the owner's thread,
 * through `MachinesRpc.Status`, the view `machine.status` gives the model.
 *
 * `gent ctl review` writes `rounds.jsonl`, every round that ended in its
 * window, from `MachinesRpc.Review` (a server request), and adds the rounds
 * table per role and model to `digest.md`. It writes `roles.jsonl`, each
 * model's measures in each machine role over the runs that moved in the
 * window, from `MachinesRpc.Roles`, and adds their table to `digest.md`.
 * A `gent ctl review` that a gent tool or machine command runs reads no
 * roles: it fails (`readRoles`).
 */
import { Config, DateTime, Effect, Option, Order, Predicate, Schema, Stream } from "effect"
import { createEffect, createRoot, For, on, Show } from "solid-js"
import { omitUndefined, ref } from "@gent/core/extensions/api"
import { cleanReviewText, type LaneReport } from "@gent/core/protocol"
import { type MachineRunView, MachinesRpc, ReviewRound, RoleScore } from "@gent/extensions/client"
import {
  ClientContext,
  clientContributions,
  ctlProjection,
  type CtlReviewWindow,
  defineClientExtension,
  formatAge,
  formatClock,
  type LaneRow,
  laneRows,
  sessionQuery,
  statusLabelContribution,
  type StatusLabelItem,
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

/**
 * The tone of a row's glyph: a free lane, none left, banked resets, the
 * peer linked or not, a run at work, a run that waits.
 */
type BandTone = LaneRow["state"] | "running" | "asking" | "waiting"

interface BandRow {
  readonly glyph: string
  readonly tone: BandTone
  readonly text: string
}

/**
 * Single marks, fx style: lanes, banked resets, the peer's link, a running
 * run, an asking run, a run that waits for its account.
 */
const LANES_GLYPH = "≡"
const RESETS_GLYPH = "↺"
const PEER_GLYPH = "⇄"
const LANE_GLYPHS: Record<LaneRow["state"], string> = {
  free: LANES_GLYPH,
  full: LANES_GLYPH,
  none: LANES_GLYPH,
  unknown: LANES_GLYPH,
  banked: RESETS_GLYPH,
  linked: PEER_GLYPH,
  unlinked: PEER_GLYPH,
}
const RUN_GLYPH = "▸"
const ASK_GLYPH = "?"
const WAIT_GLYPH = "◷"

const BAND_MAX_RUNS = 4

const isActive = (run: MachineRunView): boolean =>
  run.status === "running" || run.status === "asking"

/**
 * What a run waits on, as its row says it: `wait 17:05` while its round
 * waits for its account, `pr #12` while its PR waits for a person.
 */
const waitsOn = (
  run: MachineRunView,
  now: number,
  zone: DateTime.TimeZone,
): Option.Option<string> => {
  const pending = run.pending
  if (Predicate.isUndefined(pending)) return Option.none()
  if (pending._tag === "Integrate") {
    return Option.map(Option.fromUndefinedOr(pending.pr), (pr) => `pr #${pr}`)
  }
  if (pending._tag !== "Round") return Option.none()
  return Option.fromUndefinedOr(pending.notBefore).pipe(
    Option.filter((until) => until > now),
    Option.map((until) => `wait ${formatClock(until, now, zone)}`),
  )
}

/** `track implement r2 4m`, then `· wait 17:05` or `· pr #12` while it waits. */
const runRow = (
  run: MachineRunView,
  now: number,
  width: number,
  zone: DateTime.TimeZone,
): BandRow => {
  const head = `${run.machine} ${run.state} r${run.visits[run.state] ?? 0} ${formatAge(now - run.createdAt)}`
  return Option.match(waitsOn(run, now, zone), {
    onNone: () => {
      if (run.status === "asking")
        return { glyph: ASK_GLYPH, tone: "asking", text: truncate(head, width) }
      return { glyph: RUN_GLYPH, tone: "running", text: truncate(head, width) }
    },
    onSome: (waiting) => {
      const full = `${head} · ${waiting}`
      if (textWidth(full) <= width) return { glyph: WAIT_GLYPH, tone: "waiting", text: full }
      return { glyph: WAIT_GLYPH, tone: "waiting", text: truncate(head, width) }
    },
  })
}

const laneBandRow = (row: LaneRow): BandRow => ({
  glyph: LANE_GLYPHS[row.state],
  tone: row.state,
  text: row.text,
})

/**
 * Whether the peer changes what this server does now: it fell silent while
 * its last runs still count in the hold (the server keeps to half the
 * pace), or a link went down while the peer was heard inside the hold.
 * A live peer's runs, an idle linked peer and a peer silent past the hold
 * are `/status` detail.
 */
const peerActs = (peer: NonNullable<LaneReport["peer"]>): boolean =>
  (peer.silent && peer.runs > 0) || (peer.counted && peer.down.length > 0)

/**
 * The lanes rows that need the owner in this session: a refusal or a
 * usage-limit wait on the session's provider, a lost login there, the
 * Sabbath holding every run, and the peer's row while the peer acts on this
 * server ({@link peerActs}). `provider` is the session's model's provider;
 * none while the session names no model the catalog knows, and then every
 * provider's rows count. Every lane held by the owner's own runs (`full`),
 * free lanes, unknown ones and banked resets are `/status` detail
 * ({@link laneDetail}).
 */
const lanesNeedingOwner = (
  report: LaneReport,
  now: number,
  width: number,
  provider: Option.Option<string>,
  zone: DateTime.TimeZone,
): ReadonlyArray<LaneRow> => {
  const peer = Option.exists(Option.fromUndefinedOr(report.peer), peerActs)
  const ours = (row: LaneRow) =>
    Option.isNone(provider) ||
    Option.match(row.provider, {
      onNone: () => true,
      onSome: (name) => Option.contains(provider, name),
    })
  return laneRows(report, now, width, zone).filter((row) => {
    if (row.state === "linked" || row.state === "unlinked") return peer
    return row.state === "none" && ours(row)
  })
}

/**
 * The band: the lanes rows that need the owner, then one row per active
 * run, oldest first, up to four and a count of the rest. Empty while no
 * lane of the session's provider is refused or waits, the peer does not act
 * on this server, and no run is active, so the band hides. `width` is the
 * text's columns; `provider` is the session's provider ({@link lanesNeedingOwner}).
 */
export const bandRows = (
  data: BandData,
  now: number,
  width: number,
  provider: Option.Option<string> = Option.none(),
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): ReadonlyArray<BandRow> => {
  const active = data.runs.filter(isActive).toSorted((a, b) => a.createdAt - b.createdAt)
  const lanes = Option.match(data.lanes, {
    onNone: (): ReadonlyArray<LaneRow> => [],
    onSome: (report) => lanesNeedingOwner(report, now, width, provider, zone),
  }).map(laneBandRow)
  const shown = active.slice(0, BAND_MAX_RUNS).map((run) => runRow(run, now, width, zone))
  const rest = active.length - BAND_MAX_RUNS
  if (rest <= 0) return [...lanes, ...shown]
  return [...lanes, ...shown, { glyph: " ", tone: "running", text: `+${rest} more runs` }]
}

const PANE_TONES: Record<LaneRow["state"], StatusLabelItem["color"]> = {
  free: "success",
  full: "textMuted",
  none: "warning",
  unknown: "textMuted",
  banked: "textMuted",
  linked: "info",
  unlinked: "warning",
}

/**
 * Every lanes row as `/status` lines, in their glyph's tone: the lanes of
 * each provider, its lost logins and banked resets, the Sabbath, the peer.
 * `columns` is the pane's row width: each row takes the longest form that
 * fits it after its glyph. None until the lanes answer.
 */
export const laneDetail = (
  lanes: Option.Option<LaneReport>,
  now: number,
  columns: number,
  zone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): ReadonlyArray<StatusLabelItem> =>
  Option.match(lanes, {
    onNone: () => [],
    onSome: (report) =>
      laneRows(report, now, Math.max(8, columns - 2), zone).map((row) => ({
        text: `${LANE_GLYPHS[row.state]} ${row.text}`,
        color: PANE_TONES[row.state],
      })),
  })

export function LanesBand(props: {
  readonly data: () => BandData
  readonly now: () => number
  /** The session's model's provider; none shows every provider's rows. */
  readonly provider?: () => Option.Option<string>
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  // The frame pads a column each side, and the glyph takes two.
  const textColumns = () => Math.max(8, dimensions().width - 4)
  const provider = () =>
    Option.match(Option.fromUndefinedOr(props.provider), {
      onNone: () => Option.none<string>(),
      onSome: (read) => read(),
    })
  const rows = () => bandRows(props.data(), props.now(), textColumns(), provider())
  const toneColor = (tone: BandTone) => {
    if (tone === "free") return theme.success
    if (tone === "none") return theme.warning
    if (tone === "unlinked") return theme.warning
    if (tone === "linked") return theme.info
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

// ── review ──────────────────────────────────────────────────────────────────

const reviewRef = ref(MachinesRpc.Review)
const encodeRound = Schema.encodeEffect(Schema.fromJsonString(ReviewRound))

/** One role and model's rounds in `digest.md`, summed as the lines pass. */
interface RoundsTotal {
  readonly role: string
  readonly model: string
  rounds: number
  dead: number
  readonly minutes: Array<number>
  input: number
  cacheRead: number
  output: number
  costUsd: number
  unpriced: number
  readonly outcomes: Map<string, number>
}

const median = (values: ReadonlyArray<number>) =>
  Option.getOrElse(
    Option.fromUndefinedOr(
      values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)],
    ),
    () => 0,
  )

const foldRound = (totals: Map<string, RoundsTotal>, round: typeof ReviewRound.Type) => {
  const role = round.role ?? "-"
  const model = `${round.model ?? "unknown"}${Option.getOrElse(
    Option.map(Option.fromUndefinedOr(round.effort), (effort) => `@${effort}`),
    () => "",
  )}`
  const key = `${role}\t${model}`
  const total: RoundsTotal = totals.get(key) ?? {
    role,
    model,
    rounds: 0,
    dead: 0,
    minutes: [],
    input: 0,
    cacheRead: 0,
    output: 0,
    costUsd: 0,
    unpriced: 0,
    outcomes: new Map(),
  }
  total.rounds += 1
  if (round.dead === true) total.dead += 1
  total.minutes.push(round.minutes)
  total.input += round.tokens?.input ?? 0
  total.cacheRead += round.tokens?.cacheRead ?? 0
  total.output += round.tokens?.output ?? 0
  if (Predicate.isUndefined(round.costUsd)) total.unpriced += 1
  total.costUsd += round.costUsd ?? 0
  total.outcomes.set(round.outcome, (total.outcomes.get(round.outcome) ?? 0) + 1)
  totals.set(key, total)
}

/** The rounds table per role and model, as the orchestrate skill's `models.ts` groups its agents. */
const renderRounds = (totals: Map<string, RoundsTotal>) =>
  [
    "## Machine rounds per role and model",
    "",
    "| Role | Model | Rounds | Dead | Outcomes | Median min | Input | Cache-read | Output | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...[...totals]
      .toSorted(([left], [right]) => Order.String(left, right))
      .map(([, total]) => {
        const outcomes = [...total.outcomes]
          .map(([outcome, count]) => `${outcome} ${count}`)
          .join(", ")
        // A group with an unpriced round has no total cost, as `models.ts` prints `?`.
        let cost = `$${total.costUsd.toFixed(2)}`
        if (total.unpriced > 0) cost = "?"
        return `| ${total.role} | ${total.model} | ${total.rounds} | ${total.dead} | ${outcomes} | ${median(total.minutes).toFixed(1)} | ${(total.input / 1e6).toFixed(1)}M | ${(total.cacheRead / 1e6).toFixed(1)}M | ${(total.output / 1e3).toFixed(1)}k | ${cost} |`
      }),
    "",
  ].join("\n")

/**
 * `rounds.jsonl`: every machine round that ended in the window, read a page
 * of runs at a time through `MachinesRpc.Review` (a server request). The
 * run's unit is the owner's free text, cleaned as the server cleans its own.
 */
const readRounds = <E,>(window: CtlReviewWindow<E>) =>
  Effect.gen(function* () {
    const totals = new Map<string, RoundsTotal>()
    yield* Stream.paginate(Option.none<string>(), (after) =>
      Effect.map(
        window.ask(reviewRef, {
          since: window.since,
          ...omitUndefined({ after: Option.getOrUndefined(after) }),
        }),
        (page) =>
          [page.rounds, Option.map(Option.fromUndefinedOr(page.after), Option.some)] as const,
      ),
    ).pipe(
      Stream.runForEach((found) => {
        const round = {
          ...found,
          ...omitUndefined({
            unit: Option.getOrUndefined(
              Option.map(Option.fromUndefinedOr(found.unit), cleanReviewText),
            ),
          }),
        }
        return encodeRound(round).pipe(
          Effect.flatMap(window.write),
          Effect.tap(() => Effect.sync(() => foldRound(totals, round))),
        )
      }),
    )
    return { digest: renderRounds(totals) }
  })

const rolesRef = ref(MachinesRpc.Roles)
/** The variable gent sets on every process its tools and machine commands spawn. */
const GENT_COMMAND_TOKEN = "GENT_COMMAND_TOKEN"
const encodeRole = Schema.encodeEffect(Schema.fromJsonString(RoleScore))

/** A measure as the roles table prints it: a ratio under its least `n` prints `—` and its `n`, a share `of/n`. */
const measureCell = (measure: RoleScore["measures"][number]) => {
  if (measure._tag === "Count") return `${measure.name} ${measure.n}`
  if (measure._tag === "Share") return `${measure.name} ${measure.of}/${measure.n}`
  if (Predicate.isUndefined(measure.value)) return `${measure.name} — (n ${measure.n})`
  return `${measure.name} ${Number(measure.value.toFixed(2))} (n ${measure.n})`
}

/** The roles table: one row per role and model and effort, its measures in one cell. */
const renderRoles = (scores: ReadonlyArray<RoleScore>) =>
  [
    "## Machine roles per model",
    "",
    "| Role | Model | Effort | Measures |",
    "| --- | --- | --- | --- |",
    ...scores.map(
      (score) =>
        `| ${score.role} | ${score.model ?? "?"} | ${score.effort ?? "-"} | ${score.measures.map(measureCell).join("; ")} |`,
    ),
    "",
  ].join("\n")

/**
 * `roles.jsonl`: one line per role and model and effort, its measures over
 * the runs that moved in the window (`MachinesRpc.Roles`, a server request).
 */
const readRoles = <E,>(window: CtlReviewWindow<E>) =>
  Effect.gen(function* () {
    // A model must never read how it is measured: a process gent's tools or
    // machine commands spawned carries the command token, and reads no roles.
    // A worker with a full shell can still unset it, or read the data dir.
    const spawned = yield* Config.option(Config.String(GENT_COMMAND_TOKEN)).pipe(
      Effect.orElseSucceed(() => Option.none()),
    )
    if (Option.isSome(spawned))
      return yield* window.fail(
        `the machine roles are the owner's: gent ctl review does not read them under a gent tool or machine command (${GENT_COMMAND_TOKEN} is set)`,
      )
    const scores = yield* window.ask(rolesRef, { since: window.since })
    yield* Effect.forEach(scores, (score) => Effect.flatMap(encodeRole(score), window.write), {
      discard: true,
    })
    return { digest: renderRoles(scores) }
  })

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

    // The provider of the model the session runs its next step on, from the
    // catalog: none until both are known.
    const sessionProvider = () =>
      Option.flatMap(transport.selectedModel(), (id) =>
        Option.flatMap(transport.modelCatalog(), (catalog) =>
          Option.map(
            Option.fromUndefinedOr(catalog.find((model) => model.id === id)),
            (model): string => model.provider,
          ),
        ),
      )

    return clientContributions(
      statusLabelContribution({
        priority: 50,
        anchor: "pane",
        produce: (fit) => laneDetail(band.value().lanes, transport.serverNow(), fit.columns),
      }),
      widgetContribution({
        id: "machines.band",
        slot: "below-input",
        priority: 50,
        component: () => {
          // A heard peer, a run's start, a wait and a reset are server times:
          // they read the server's now. The spinner clock redraws them.
          const tick = useSpinnerClock()
          const now = () => {
            tick()
            return transport.serverNow()
          }
          return <LanesBand data={band.value} now={now} provider={sessionProvider} />
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
  review: [
    { file: "rounds.jsonl", read: readRounds },
    { file: "roles.jsonl", read: readRoles },
  ],
})
