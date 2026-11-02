/** @jsxImportSource @opentui/solid */
import { Effect, Option, Order, Predicate, Schedule, Schema } from "effect"
import { createEffect, createRoot, createSignal, For, on, Show } from "solid-js"
import {
  AgentRowEntry,
  AgentsViewRpc,
  BTW_EXTENSION_ID,
  type ListAgentsInput,
  type MachineRunPage,
  MachineRunView,
  MachinesRpc,
  type ModelQuality,
  SESSION_TOOLS_EXTENSION_ID,
  threadRoundBody,
} from "@gent/extensions/client"
import {
  type ActiveExtensionSession,
  clientCommandContribution,
  ClientContext,
  clientContributions,
  coalescedRead,
  decoration,
  defineClientExtension,
  type ExtensionAgentDetail,
  formatAge,
  formatCost,
  formatDuration,
  groupedRows,
  modelIdName,
  keyHint,
  KeyHints,
  KeyHintsText,
  keyHintsWidth,
  type PathPlace,
  PickerFrame,
  pickerHeight,
  runningCallLabel,
  selectable,
  SelectList,
  type SelectListRow,
  sessionQuery,
  STATUS_YIELD,
  statusLabelContribution,
  type TextRun,
  textWidth,
  ToneRuns,
  TrayFrame,
  truncate,
  truncatePath,
  truncateRuns,
  usePickerGeometry,
  useSpinnerClock,
  useTerminalDimensions,
  useTheme,
  widgetContribution,
  workingIconFrame,
} from "@gent/tui/extensions"
import { ref } from "@gent/core/extensions/api"
import type { Model } from "@gent/core/protocol"

// ── agents tray ─────────────────────────────────────────────────────────────

/**
 * Subagent tray — one line above the composer.
 *
 * It reports how many loops hang off the current session while the agents pane
 * is closed, so a reader sees delegated work without opening anything. The
 * `@gent/agents-view` server half projects the rows; this file reads and
 * renders them.
 *
 * @module
 */

/** The sessions a row stands for: a thread's handoff chain, else its own session. */
const membersOf = (row: AgentRowEntry): ReadonlyArray<AgentRowEntry["sessionId"]> =>
  row.sessions ?? [row.sessionId]

/** Whether the row stands for `sessionId`, as its own session or an older one of its thread. */
const holds = (row: AgentRowEntry, sessionId: string): boolean =>
  membersOf(row).some((member) => member === sessionId)

/** A thread's stable identity: its key, which a handoff keeps while the row's ids move. */
const threadOf = (row: AgentRowEntry): string => row.thread ?? row.sessionId

/**
 * Whether the row's loop is in a turn: running, or needing the reader while
 * its turn goes on (parked on an ask, or working past a background question).
 * A loop that needs the reader but is idle has only questions left open.
 */
const working = (row: AgentRowEntry): boolean =>
  row.section === "running" ||
  (row.section === "needs" && Predicate.isNotUndefined(row.status) && row.status !== "Idle")

/**
 * Descendants of `root` at any depth, in the server's parent-before-child
 * order. A row stands for every session of its thread, so the root's row is
 * the one that holds it, and a child names its real parent, which may be an
 * older session of a thread whose row the newest session names.
 */
const subtreeRows = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: { readonly sessionId: string },
): ReadonlyArray<AgentRowEntry> => {
  const known = new Set<string>([root.sessionId])
  const take = (row: AgentRowEntry) => {
    for (const member of membersOf(row)) known.add(member)
  }
  for (const row of rows) {
    if (holds(row, root.sessionId)) take(row)
  }
  const descendants: Array<AgentRowEntry> = []
  let pending = rows.filter((row) => !holds(row, root.sessionId))
  for (;;) {
    const next = pending.filter(
      (row) => Predicate.isNotUndefined(row.parentSessionId) && known.has(row.parentSessionId),
    )
    if (next.length === 0) return descendants
    for (const row of next) {
      descendants.push(row)
      take(row)
    }
    pending = pending.filter((row) => !next.includes(row))
  }
}

/** The key that opens the pane: ← on an empty composer (`agents.view`). */
const TRAY_KEY = "←"
const TRAY_HINT = `${TRAY_KEY} sessions`
/** The tray's way in, drawn as every key hint is: the key bright, its verb muted. */
const TRAY_HINTS = [keyHint(TRAY_KEY, "sessions")]
const TRAY_MAX_ROWS = 3
/**
 * Columns of a child's name on the status row; a thread's name is often its
 * whole task. At 100 columns the left group has 71 beside the right group
 * (`cache 5m · ctx 0% · $0.002`). The phase, the cwd, `Claude Sonnet 5.5` and
 * the way back take 44 of them, and ` · ↳ child ` 11 more: 16 are left for
 * the name. At 60 and 40 columns the way back alone does not fit, so the
 * label never shows there.
 */
const WATCHED_NAME = 16

/** `text` in whole words within `width` columns, ending in `…` when cut; a first word too long is cut in it. */
const wholeWords = (text: string, width: number): string => {
  const line = text.replace(/\s+/gu, " ").trim()
  if (textWidth(line) <= width) return line
  let kept = ""
  for (const word of line.split(" ")) {
    let next = `${kept} ${word}`
    if (kept.length === 0) next = word
    if (textWidth(next) > width - 1) break
    kept = next
  }
  if (kept.length === 0) return truncate(line, width)
  return `${kept.replace(/[\s,:;]+$/u, "")}…`
}

/** What a row is called: its session name, else its cwd, else its id. */
const nameFor = (row: AgentRowEntry): string =>
  Option.fromUndefinedOr(row.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(row.cwd)),
    Option.getOrElse(() => row.sessionId),
  )

/**
 * What a running agent does now, in the live line's words: its newest
 * running call (`Running bun test`, `Reading src/loader.ts`, a cell's
 * `Reading 2 files`), else its last streamed line. A call's paths read
 * against the agent's own directory, else where the TUI launched.
 */
const doingFor = (row: AgentRowEntry, place: PathPlace): string =>
  Option.match(Option.fromUndefinedOr(row.runningCall), {
    onNone: () => row.activity ?? "",
    onSome: (call) =>
      runningCallLabel(call.tool, call.input, { cwd: row.cwd ?? place.cwd, home: place.home }),
  })

/**
 * Rows in the order their sessions were created. The listing orders by last
 * update, which a working child changes on every step, so a tray in listing
 * order reshuffles on each poll.
 */
const inStartOrder = (rows: ReadonlyArray<AgentRowEntry>): ReadonlyArray<AgentRowEntry> =>
  rows.toSorted((left, right) => {
    const byStart = (left.createdAt ?? 0) - (right.createdAt ?? 0)
    if (byStart !== 0) return byStart
    return Order.String(
      `${left.sessionId}:${left.branchId}`,
      `${right.sessionId}:${right.branchId}`,
    )
  })

/** A tray row's glyph: the pulse for a running child, `◆` for a done thread, none for the count. */
type TrayMark = "running" | "done" | "none"

/**
 * One tray row: its glyph, its text, and the text's leading name, which
 * draws in the names' colour (Codex draws an agent's nickname in its
 * accent); the rest of the text is muted.
 */
interface TrayLine {
  readonly mark: TrayMark
  readonly text: string
  readonly name: string
}

/** A tray row's text cut to `width`, the name's share kept apart. */
const trayLine = (mark: TrayMark, parts: RowParts, width: number): TrayLine => {
  const runs = truncateRuns(
    [
      { text: parts.name, tone: "name" },
      { text: parts.doing, tone: "muted" },
    ],
    width,
  )
  return {
    mark,
    text: runs.map((run) => run.text).join(""),
    name: runs
      .filter((run) => run.tone === "name")
      .map((run) => run.text)
      .join(""),
  }
}

/**
 * The tray's rows, the glyph standing for the state: `<name> · <doing>` per
 * running child (the pulse), then `<name>` per finished thread (`◆`, oldest
 * first), up to the cap; the rest collapse into one `+N more` line.
 *
 * A child's name is often its whole task text. What it does keeps up to half
 * the row and the name is cut to what is left, so a long task never pushes
 * what the child is doing off the row.
 */
export const trayLines = (
  running: ReadonlyArray<AgentRowEntry>,
  width: number,
  done: ReadonlyArray<AgentRowEntry>,
  place: PathPlace,
): ReadonlyArray<TrayLine> => {
  const working = inStartOrder(running).slice(0, TRAY_MAX_ROWS)
  const finished = done.slice(0, TRAY_MAX_ROWS - working.length)
  const lines: Array<TrayLine> = [
    ...working.map((row) =>
      trayLine("running", rowParts("", nameFor(row), doingFor(row, place), width), width),
    ),
    ...finished.map((row) => trayLine("done", { name: nameFor(row), doing: "" }, width)),
  ]
  const rest = running.length - working.length + done.length - finished.length
  if (rest > 0) lines.push({ mark: "none", text: `+${rest} more`, name: "" })
  return lines
}

/**
 * What the tray's children have spent, each counted once, with two columns
 * after it before the key hints: `$0.12  `. Blank while they have spent
 * nothing, so the hints keep their place.
 */
const trayCost = (
  running: ReadonlyArray<AgentRowEntry>,
  done: ReadonlyArray<AgentRowEntry>,
): string => {
  const total = rowsCost([...running, ...done])
  if (total.length === 0) return ""
  return `${total}  `
}

/**
 * A finished side thread reports to no one: its starter is not woken, so the
 * tray says it is done. A thread that reports to its starter (`notify:
 * "starter"`) lands its round's end in the starter's transcript, so it gets
 * no done row.
 */
const finishesSilently = (row: AgentRowEntry): boolean =>
  row.sideThread && row.reportsToStarter !== true

export function SubagentTray(props: { controller: AgentsController; place: PathPlace }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()
  const running = () =>
    subtreeRows(props.controller.rows(), props.controller.current()).filter(working)
  // A done thread the shell is on is shown, so it leaves the tray at once.
  const finished = () =>
    props.controller.done().filter((row) => !holds(row, props.controller.current().sessionId))
  // What every child in the tray has spent, before the hints on the first line.
  const cost = () => trayCost(running(), finished())
  // Two columns of padding, the glyph and its space, and the cost and hint on the first line.
  const rowWidth = () =>
    Math.max(8, dimensions().width - 4 - textWidth(cost()) - keyHintsWidth(TRAY_HINTS) - 2)
  const lines = () => trayLines(running(), rowWidth(), finished(), props.place)
  const glyph = (mark: TrayMark) => {
    if (mark === "running") return { text: workingIconFrame(tick()), color: theme.success }
    if (mark === "done") return { text: "◆", color: theme.textMuted }
    return { text: " ", color: theme.textMuted }
  }
  return (
    <Show when={running().length > 0 || finished().length > 0}>
      <TrayFrame>
        <For each={lines()}>
          {(line, index) => (
            <text wrapMode="none">
              <span style={{ fg: glyph(line.mark).color }}>{`${glyph(line.mark).text} `}</span>
              <span style={{ fg: theme.info }}>{line.name}</span>
              <span style={{ fg: theme.textMuted }}>{line.text.slice(line.name.length)}</span>
              <Show when={index() === 0}>
                <span style={{ fg: theme.textMuted }}>
                  {`${" ".repeat(Math.max(1, rowWidth() - textWidth(line.text) + 2))}${cost()}`}
                </span>
                <KeyHintsText hints={TRAY_HINTS} />
              </Show>
            </text>
          )}
        </For>
      </TrayFrame>
    </Show>
  )
}

// ── agents pane ─────────────────────────────────────────────────────────────

/**
 * Agents view — the client half.
 *
 * Renders the rows the `@gent/agents-view` server half projects: every agent
 * loop, live or stored, grouped by section and nested under its parent. The
 * server owns the projection, so this file only renders and navigates.
 *
 * Filtering and cursor movement belong to `SelectList`.
 *
 * @module
 */

const AGENTS_VIEW_EXTENSION_ID = "@gent/agents-view"

/**
 * Rows plus the load state, held in the setup closure.
 *
 * The tray and the pane read the same rows, so they live here rather than in
 * either component. The controller also owns when they are read again: the
 * tray and the open pane refresh on the same triggers.
 */
interface AgentsController {
  readonly rows: () => ReadonlyArray<AgentRowEntry>
  /** The loop the shell is currently on, so the pane can mark and preselect it. */
  readonly current: () => ActiveExtensionSession
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: (query: string) => void
  /** Re-read the listing under the filter already typed, after a row changed. */
  readonly reload: () => void
  /**
   * Detail for the row the reader is on, or `None` while it loads. Listings
   * stay cheap by carrying identity and liveness only; this is the second
   * read, made for one row at a time.
   */
  readonly detail: () => Option.Option<ExtensionAgentDetail>
  /**
   * How each model fared in the machine state the selected row works rounds
   * of: none for a session that is no round thread. A durable read, so a
   * stored row has it too, read again on each listing reply: a check or a
   * gate after the row's rounds moves it while the row stays the same.
   */
  readonly quality: () => ReadonlyArray<ModelQuality>
  /** Tell the controller which row is selected, so it can fetch that detail. */
  readonly select: (row: Option.Option<AgentRowEntry>) => void
  /** Whether the pane is showing: the host's pane slot names it. */
  readonly open: () => boolean
  /**
   * Side threads in the shell's thread's subtree seen running that went
   * idle while the shell was not on them, oldest first, each as its current
   * row. Opening one, its next turn (on any of its sessions), or its
   * deletion clears it.
   */
  readonly done: () => ReadonlyArray<AgentRowEntry>
  /** The machine runs the open pane lists, and the run page it shows. */
  readonly runs: RunsController
  /**
   * This clock's now on the server's (`ClientTransport.serverNow`): a row's last
   * step, a turn's start and a run's start are server times, so each age
   * the pane shows reads against it. This clock's own before the first
   * snapshot measured the offset.
   */
  readonly now: () => number
}

/** The machine runs the open pane lists and the one run page it shows. */
interface RunsController {
  /** The shell's thread's runs: each active one, then the newest ended ones, under the pane's filter. */
  readonly list: () => ReadonlyArray<MachineRunView>
  /** The run whose page shows; none while the pane shows its list. */
  readonly viewing: () => Option.Option<RunId>
  /**
   * The viewed run's page: every visit read so far, and the step the next
   * read starts from (`next`); none until its first read lands.
   */
  readonly page: () => Option.Option<MachineRunPage>
  /** Why the viewed run's last read failed. */
  readonly error: () => Option.Option<string>
  /** Show a run's page, or none to go back to the list. */
  readonly view: (run: Option.Option<RunId>) => void
  /** Stop a run, then read the listing, and with it the page, again. */
  readonly stop: (run: RunId) => void
}

type RunId = MachineRunView["run"]

/**
 * What the pane reads of the `@gent/machines` extension, and the stop it
 * asks: how each model fared in a round thread's state, the runs of the
 * shell's thread, one run's page.
 */
interface MachineReads {
  readonly quality: (key: RowKey) => Effect.Effect<ReadonlyArray<ModelQuality>>
  readonly runs: (session: ActiveExtensionSession) => Effect.Effect<ReadonlyArray<MachineRunView>>
  /** The run's page from step `since` on: its status and the visits that began there or later. */
  readonly page: (
    run: RunId,
    since: number,
  ) => Effect.Effect<MachineRunPage, { readonly message: string }>
  readonly stop: (run: RunId) => Effect.Effect<void, { readonly message: string }>
}

/** The controller as its extension holds it: also what the status row reads. */
interface AgentsSource extends AgentsController {
  /**
   * The row of the session in view, when that session is a child (it names
   * a parent): the status row names it. `None` until a listing for the
   * session in view has come back.
   */
  readonly watched: () => Option.Option<AgentRowEntry>
}

/** The agents pane's name in the host's one pane slot. */
const AGENTS_PANE = "agents.pane"

type RowKey = Pick<AgentRowEntry, "sessionId" | "branchId">

const sameKey = (left: RowKey, right: RowKey): boolean =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

/** What a listing row says about its loop's progress: `updatedAt` moves on every step. */
const progressStamp = (row: AgentRowEntry): string =>
  `${String(row.status)} ${String(row.updatedAt)}`

/** One listing reply and what it was asked: a filter, and the root unless it covers the workspace. */
interface Listing {
  readonly rows: ReadonlyArray<AgentRowEntry>
  /** The shell's thread's runs, newest first: the open pane's alone, the tray's read none. */
  readonly runs: ReadonlyArray<MachineRunView>
  readonly query: string
  readonly root: Option.Option<string>
  readonly session: ActiveExtensionSession
  readonly view: number
  readonly activityRows: Option.Option<ReadonlyArray<AgentRowEntry>>
}

/** The slow clock a child's own turns are read on; they raise no event in this session. */
const POLL_EVERY = "2 seconds"

const isActiveRun = (run: Pick<MachineRunView, "status">): boolean =>
  run.status === "running" || run.status === "asking"

/**
 * The page after a read from `next.since`: the kept visits that began
 * before that step, then the read's.
 */
const mergePage = (kept: Option.Option<MachineRunPage>, next: MachineRunPage): MachineRunPage => {
  const before = Option.match(
    Option.filter(kept, (page) => page.run === next.run),
    {
      onNone: () => [],
      onSome: (page) => page.trail.filter((visit) => visit.seq < next.since),
    },
  )
  return { ...next, trail: [...before, ...next.trail] }
}

/** Ended runs the list keeps under the active ones. */
const RUN_HISTORY = 3

/**
 * The runs the list shows, from the server's newest first: each active run,
 * then the newest ended ones. A filter keeps the runs whose machine or state
 * holds it.
 */
const listedRuns = (
  runs: ReadonlyArray<MachineRunView>,
  query: string,
): ReadonlyArray<MachineRunView> => {
  const needle = query.trim().toLowerCase()
  const matching = runs.filter((run) =>
    `${run.machine} ${run.state}`.toLowerCase().includes(needle),
  )
  return [
    ...matching.filter(isActiveRun),
    ...matching.filter((run) => !isActiveRun(run)).slice(0, RUN_HISTORY),
  ]
}

export const makeAgentsController = (
  fetchRows: (
    input: ListAgentsInput,
  ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
  fetchDetail: (key: RowKey) => Effect.Effect<ExtensionAgentDetail, { readonly message: string }>,
  machines: MachineReads,
): Effect.Effect<AgentsSource, never, ClientContext> =>
  Effect.gen(function* () {
    const { transport, shell, lifecycle, activity } = yield* ClientContext
    const empty: ReadonlyArray<AgentRowEntry> = []
    const noRuns: ReadonlyArray<MachineRunView> = []
    // Returning to a session does not make its earlier activity current again.
    const [view, setView] = createSignal(0)
    // The filter the reader typed; a reload re-reads under it.
    let query = ""
    const open = () => shell.pane.isOpen(AGENTS_PANE)

    const [detail, setDetail] = createSignal<Option.Option<ExtensionAgentDetail>>(Option.none())
    // The row the cursor is on, while it has a loop to ask.
    let selected = Option.none<RowKey>()
    // The selected row's progress as the listing showed it at the last detail read.
    let readStamp = ""
    // The row the cursor is on, live or stored: its quality is no actor read.
    let pointed = Option.none<RowKey>()
    const [quality, setQuality] = createSignal<ReadonlyArray<ModelQuality>>([])
    // As with the detail, a reply writes only while its row is still the one pointed at.
    const readQuality = coalescedRead(shell.cast, () =>
      Option.match(pointed, {
        onNone: () => Effect.void,
        onSome: (key) =>
          machines.quality(key).pipe(
            Effect.map((next) => {
              if (Option.exists(pointed, (current) => sameKey(current, key))) setQuality(next)
            }),
          ),
      }),
    )
    // One detail read runs at a time, for the row the cursor is on when it
    // starts. Arrow keys move faster than a round trip, so a reply writes only
    // while its row is still selected; otherwise it would show one row's cost
    // next to another row's name.
    const readDetail = coalescedRead(shell.cast, () =>
      Option.match(selected, {
        onNone: () => Effect.void,
        onSome: (key) =>
          fetchDetail(key).pipe(
            Effect.match({
              // A detail read that fails leaves the line as it is rather than
              // replacing the list with an error: the rows are still correct.
              onFailure: () => {},
              onSuccess: (next) => {
                if (!Option.exists(selected, (current) => sameKey(current, key))) return
                setDetail(Option.some(next))
              },
            }),
          ),
      }),
    )

    // The run whose page shows, and its last read. As with the detail, a
    // reply writes only while its run is still the one viewed.
    // A read starts at the kept page's `next`: the visits before it never
    // change, so it carries only the open visit and the ones after it. A
    // reply from any other start (a read from before the run was viewed
    // again) is dropped, and the next read asks again.
    const [viewing, setViewing] = createSignal(Option.none<RunId>())
    const [page, setPage] = createSignal(Option.none<MachineRunPage>())
    const [pageError, setPageError] = createSignal(Option.none<string>())
    const sinceFor = (run: RunId): number =>
      Option.match(
        Option.filter(page(), (kept) => kept.run === run),
        { onNone: () => 0, onSome: (kept) => kept.next },
      )
    const readPage = coalescedRead(shell.cast, () =>
      Option.match(viewing(), {
        onNone: () => Effect.void,
        onSome: (run) =>
          machines.page(run, sinceFor(run)).pipe(
            Effect.match({
              onFailure: (error) => {
                if (Option.contains(viewing(), run)) setPageError(Option.some(error.message))
              },
              onSuccess: (next) => {
                if (!Option.contains(viewing(), run) || next.since !== sinceFor(run)) return
                setPageError(Option.none())
                setPage(Option.some(mergePage(page(), next)))
              },
            }),
          ),
      }),
    )

    // The detail is a whole session snapshot. A running loop's cost moves
    // between the steps of one turn while its listing row stays the same, so
    // each listing reply reads a running row's detail again. A row that is not
    // running changes only when its status or `updatedAt` moves.
    const detailAfterListing = (rows: ReadonlyArray<AgentRowEntry>): void => {
      if (Option.isNone(selected)) return
      const key = selected.value
      const now = rows.find((entry) => entry.live && sameKey(entry, key))
      if (Predicate.isUndefined(now)) return
      const stamp = progressStamp(now)
      if (!working(now) && stamp === readStamp) return
      readStamp = stamp
      readDetail()
    }

    // Whether each thread was in a turn at the last listing, and the side
    // threads that finished since, keyed by thread: a handoff moves a row to
    // a new session but keeps its thread. They live here, outside any
    // component, so the tray keeps them while it hides for the pane. An entry
    // also names the thread the shell was on when it finished (`scope`), the
    // root whose whole listing says whether the thread still exists.
    const lastWorking = new Map<string, boolean>()
    const [finished, setFinished] = createSignal<
      ReadonlyMap<string, { readonly row: AgentRowEntry; readonly scope: string }>
    >(new Map())
    const noteFinished = (reply: Listing): void => {
      const here = transport.currentSession().sessionId
      const scope = Option.fromUndefinedOr(reply.rows.find((row) => holds(row, here))).pipe(
        Option.map(threadOf),
        Option.getOrElse(() => here),
      )
      const listed = new Map(reply.rows.map((row) => [threadOf(row), row]))
      // Only a whole listing shows that a thread is gone: the workspace's, or
      // its root's under no filter. A filter hides threads that still exist.
      const whole = reply.query.trim() === ""
      const next = new Map<string, { readonly row: AgentRowEntry; readonly scope: string }>()
      for (const [key, entry] of finished()) {
        const now = listed.get(key)
        if (Predicate.isUndefined(now)) {
          const gone = whole && (Option.isNone(reply.root) || entry.scope === scope)
          if (!gone) next.set(key, entry)
          continue
        }
        if (working(now) || holds(now, here)) continue
        next.set(key, { ...entry, row: now })
      }
      // What finished is read in the shell's subtree, where the tray shows it.
      const inView = subtreeRows(reply.rows, { sessionId: here })
      for (const row of inView) {
        const key = threadOf(row)
        if (
          lastWorking.get(key) === true &&
          !working(row) &&
          finishesSilently(row) &&
          !next.has(key)
        ) {
          next.set(key, { row, scope })
        }
      }
      // The reader sees the thread the shell is on too: a finish watched from
      // inside it is seen, so it is no done row back at its starter.
      const seen = [...inView, ...reply.rows.filter((row) => holds(row, here))]
      for (const row of seen) lastWorking.set(threadOf(row), working(row))
      setFinished(next)
    }

    // The pane refetches across session switches (on `current()` changing and on
    // the poll), so the session query owns the guard that drops a reply for the
    // session the shell already left; a reply it drops changes nothing here.
    // The open pane lists the workspace under the reader's filter. The closed
    // pane leaves only the tray, which draws the current session's subtree,
    // so it reads that subtree alone: its cost follows the subtree, not the
    // number of stored sessions. The server reads a root as its whole thread.
    const read = (
      session: ActiveExtensionSession,
    ): Effect.Effect<Listing, { readonly message: string }> => {
      const asked = query
      const askedView = view()
      const root = Option.liftPredicate(session.sessionId, () => !open())
      // No `root` key for the whole workspace: an `undefined` value is no JSON
      // value, and an in-process request refuses it.
      const input: ListAgentsInput = Option.match(root, {
        onNone: () => ({ query: asked }),
        onSome: (sessionId) => ({ query: asked, root: sessionId }),
      })
      // The open pane lists the thread's machine runs beside its sessions.
      const runs = Option.match(root, {
        onNone: () => machines.runs(session),
        onSome: () => Effect.succeed(noRuns),
      })
      return Effect.all([fetchRows(input), runs], { concurrency: 2 }).pipe(
        Effect.flatMap(([rows, runs]) => {
          // A complete listing serves both views. Only a filtered pane needs
          // another read, on this same coalesced request and clock.
          const complete = () => {
            if (asked.trim() === "") return Effect.succeedSome(rows)
            return fetchRows({ query: "", root: session.sessionId }).pipe(
              Effect.asSome,
              Effect.orElseSucceed(Option.none),
            )
          }
          return complete().pipe(
            Effect.map((activityRows) => ({
              rows,
              runs,
              query: asked,
              root,
              session,
              view: askedView,
              activityRows,
            })),
          )
        }),
      )
    }
    const listing = yield* sessionQuery<Listing>({
      initial: {
        rows: empty,
        runs: noRuns,
        query: "",
        root: Option.none(),
        session: transport.currentSession(),
        view: view(),
        activityRows: Option.none(),
      },
      follow: false,
      fetch: read,
      accepted: (reply) => {
        noteFinished(reply)
        detailAfterListing(reply.rows)
        // Only the open pane draws quality: the tray's reads ask none.
        if (open() && Option.isSome(pointed)) readQuality()
        // A run page reads on the listing's clock: no loop of its own.
        if (open() && Option.isSome(viewing())) readPage()
      },
    })
    const rows = () => listing.value().rows
    const descendants = (): Option.Option<ReadonlyArray<AgentRowEntry>> => {
      const reply = listing.value()
      if (
        !sameKey(reply.session, transport.currentSession()) ||
        reply.view !== view() ||
        Option.isSome(listing.error())
      )
        return Option.none()
      return Option.map(reply.activityRows, (complete) => subtreeRows(complete, reply.session))
    }
    // The complete listing holds the session in view's own row: a child's
    // names its parent. Derived on each read, never stored.
    const watched = (): Option.Option<AgentRowEntry> => {
      const reply = listing.value()
      const here = transport.currentSession()
      if (!sameKey(reply.session, here) || reply.view !== view()) return Option.none()
      return Option.flatMap(reply.activityRows, (complete) =>
        Option.fromUndefinedOr(
          complete.find(
            (row) => holds(row, here.sessionId) && Predicate.isNotUndefined(row.parentSessionId),
          ),
        ),
      )
    }
    lifecycle.addCleanup(
      activity.include(() => {
        const sessionId = transport.currentSession().sessionId
        const children = descendants()
        if (Option.isNone(children)) return { sessionId, state: "unknown" }
        const live = children.value.filter((row) => row.section !== "inactive")
        if (live.some((row) => row.section === "needs" || row.status === "WaitingForInteraction"))
          return { sessionId, state: "blocked" }
        if (live.some((row) => row.status === "Running")) return { sessionId, state: "working" }
        if (live.some((row) => row.status !== "Idle")) return { sessionId, state: "unknown" }
        return { sessionId, state: "idle" }
      }),
    )
    // The shell's thread's subtree, as the latest listing shows it.
    const done = (): ReadonlyArray<AgentRowEntry> => {
      const inView = new Set(subtreeRows(rows(), transport.currentSession()).map(threadOf))
      return Array.from(finished().values(), (entry) => entry.row).filter((row) =>
        inView.has(threadOf(row)),
      )
    }
    const refresh = (next: string): void => {
      query = next
      listing.refresh()
    }

    const select = (row: Option.Option<AgentRowEntry>) => {
      const next = Option.map(row, (value) => ({
        sessionId: value.sessionId,
        branchId: value.branchId,
      }))
      const moved = !Option.makeEquivalence(sameKey)(pointed, next)
      pointed = next
      if (moved) {
        setQuality([])
        readQuality()
      }
      // A detail read goes through the loop actor, and an actor read spawns the
      // entity: asking a stored session what it is doing would make it live.
      // Only rows that already have a loop are asked.
      if (Option.isNone(row) || !row.value.live) {
        selected = Option.none()
        setDetail(Option.none())
        return
      }
      const key = { sessionId: row.value.sessionId, branchId: row.value.branchId }
      // One read per selection: a re-render that hands back the same row asks nothing.
      if (Option.exists(selected, (current) => sameKey(current, key))) return
      selected = Option.some(key)
      readStamp = progressStamp(row.value)
      setDetail(Option.none())
      readDetail()
    }

    /**
     * Read again what is showing: the open pane under its filter, or the
     * tray's subtree, unfiltered. The reply decides whether the detail is read.
     */
    const tick = (): void => {
      if (!open()) {
        refresh("")
        return
      }
      listing.refresh()
    }

    // Knowledge belongs to the controller, even when another extension
    // replaces its tray. The same coalescer reads initial and changed views.
    createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      createEffect(
        on(transport.currentSession, () => {
          setView((value) => value + 1)
          tick()
        }),
      )
    })

    // A session-tools pulse in the current session means its subtree changed:
    // the threads send one when a thread starts, when a round's end is
    // delivered and when an interrupt stops rounds. A BTW pulse discovers a
    // new fork when complete empty/inactive knowledge stopped polling; once a
    // child is live, its stream pulses leave the clock in charge.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (
          pulse.extensionId === SESSION_TOOLS_EXTENSION_ID ||
          (pulse.extensionId === BTW_EXTENSION_ID &&
            Option.exists(descendants(), (children) =>
              children.every((row) => row.section === "inactive"),
            ))
        ) {
          tick()
        }
      }),
    )
    // A child's own turns raise no event in this session, so while the pane is
    // open or a descendant has a live loop the listing is re-read on a slow
    // clock. Stored children alone never change on their own: a session-tools
    // pulse announces a new or woken one, so the tray stops polling for them. A
    // thread's row is live by its newest session, so its section says whether
    // any of its sessions has a loop.
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sync(() => {
          const watching = Option.match(descendants(), {
            onNone: () => true,
            onSome: (children) => children.some((row) => row.section !== "inactive"),
          })
          if (open() || watching) tick()
        }).pipe(Effect.repeat(Schedule.spaced(POLL_EVERY)), Effect.delay(POLL_EVERY)),
      ),
    )

    const runs: RunsController = {
      list: () => listedRuns(listing.value().runs, listing.value().query),
      viewing,
      page,
      error: pageError,
      view: (run) => {
        setViewing(run)
        setPage(Option.none())
        setPageError(Option.none())
        readPage()
      },
      stop: (run) =>
        shell.cast(
          machines.stop(run).pipe(
            // The reader asked for the stop, so a refusal shows on the status row.
            Effect.catch((error) =>
              Effect.sync(() => shell.notify(error.message)).pipe(
                Effect.andThen(Effect.logWarning("agents.stop-run failed")),
                Effect.annotateLogs({ run, error: error.message }),
              ),
            ),
            Effect.andThen(Effect.sync(() => listing.refresh())),
          ),
        ),
    }

    return {
      rows,
      current: transport.currentSession,
      error: listing.error,
      loading: listing.loading,
      refresh,
      reload: listing.refresh,
      detail,
      quality,
      select,
      open,
      done,
      runs,
      now: transport.serverNow,
      watched,
    }
  })

/** Section headings, with the count each carries. Empty sections are skipped. */
const SECTION_TITLE = {
  needs: "Needs you",
  running: "Running",
  idle: "Idle",
  inactive: "Inactive",
} satisfies Record<AgentRowEntry["section"], string>

/** `Idle (3) · $0.12`: the heading, its row count, and what its rows spent, when they spent any. */
export const sectionHeading = (
  section: AgentRowEntry["section"],
  count: number,
  rows: ReadonlyArray<AgentRowEntry>,
): string =>
  [`${SECTION_TITLE[section]} (${count})`, rowsCost(rows)]
    .filter((part) => part.length > 0)
    .join(" · ")

/** The state word the details column leads with. */
const SECTION_WORD = {
  needs: "needs you",
  running: "running",
  idle: "idle",
  inactive: "inactive",
} satisfies Record<AgentRowEntry["section"], string>

/**
 * The pane title: `Sessions · 1 needs you · 2 running · 3 idle`. Each loop
 * counts in its section, its own state; a state no loop is in is left out.
 */
const paneTitle = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const sections: ReadonlyArray<AgentRowEntry["section"]> = ["needs", "running", "idle", "inactive"]
  const counts = sections.flatMap((section) => {
    const count = rows.filter((row) => row.section === section).length
    if (count === 0) return []
    return [`${count} ${SECTION_WORD[section]}`]
  })
  return ["Sessions", ...counts].join(" · ")
}

/**
 * The status glyph: its shape says the state, so it reads without colour.
 * `●` needs the reader, the pulse works, `○` is idle, `·` has no loop.
 */
const statusGlyph = (section: AgentRowEntry["section"], frame: string): string => {
  if (section === "needs") return "●"
  if (section === "running") return frame
  if (section === "idle") return "○"
  return "·"
}

/**
 * Why a row needs the reader: its loop waits on an answer (the listing's
 * status, or the selected row's live detail), or it left background
 * questions open. Blank for a row that needs nothing.
 */
const needsReason = (row: AgentRowEntry, detail: Option.Option<ExtensionAgentDetail>): string => {
  if (
    row.status === "WaitingForInteraction" ||
    Option.exists(detail, (value) => value.status === "WaitingForInteraction")
  )
    return "waiting for an answer"
  const open = row.openQuestions ?? 0
  if (open === 1) return "1 open question"
  if (open > 1) return `${open} open questions`
  return ""
}

/** Tree prefix from depth. The server already ordered parents before children. */
const indentFor = (depth: number): string => "  ".repeat(Math.max(0, depth))

/** The selected row's live detail: the listing reports a resident loop as idle. */
const liveDetail = (
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
): Option.Option<ExtensionAgentDetail> => Option.filter(detail, () => selected)

/**
 * What a row's agent is doing now, as the tray says it (`doingFor`). The
 * glyph says the state, so no state word repeats it. A row that needs the
 * reader says why instead: that is what the reader acts on.
 */
const activityFor = (
  row: AgentRowEntry,
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
  place: PathPlace,
): string => {
  const reason = needsReason(row, liveDetail(selected, detail))
  if (reason.length > 0) return reason
  return doingFor(row, place)
}

/**
 * The section a row's glyph draws: a listing read between two steps can lag
 * the loop, so the selected row's live detail shows what it reads now. The
 * row stays under its listed heading.
 */
const glyphSection = (
  row: AgentRowEntry,
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
): AgentRowEntry["section"] =>
  Option.match(liveDetail(selected, detail), {
    onNone: () => row.section,
    onSome: (value) => {
      if (row.section === "needs" || value.status === "WaitingForInteraction") return "needs"
      if (value.status === "Running") return "running"
      return row.section
    },
  })

/** Age from the row's last update; blank when the row never ran. */
const ageFor = (row: AgentRowEntry, now: number): string =>
  Option.match(Option.fromUndefinedOr(row.updatedAt), {
    onNone: () => "",
    onSome: (updatedAt) => formatAge(now - updatedAt),
  })

/**
 * The right column's time. A running agent shows how long its current turn
 * has run (`1m 12s`), so a child woken by a correction reads its new run, not
 * its age; every other row shows the age of its last step (`3m`).
 */
const timeFor = (row: AgentRowEntry, now: number): string => {
  if (!working(row)) return ageFor(row, now)
  return Option.match(Option.fromUndefinedOr(row.runningSince), {
    onNone: () => ageFor(row, now),
    onSome: (runningSince) => formatDuration(now - runningSince, "compact"),
  })
}

/** A row label's name and its ` · <doing>`, each cut to its share of the row. */
interface RowParts {
  readonly name: string
  readonly doing: string
}

/**
 * `<head><name> · <doing>` in `width` columns, the name and the activity
 * apart so each draws in its own colour. The activity keeps up to half the
 * row and the name is cut to what is left, so a long task never pushes what
 * the agent is doing off the row.
 */
const rowParts = (head: string, name: string, doing: string, width: number): RowParts => {
  if (doing.length === 0) return { name, doing: "" }
  const shown = truncate(doing, Math.floor(width / 2))
  const nameWidth = Math.max(1, width - textWidth(head) - textWidth(" · ") - textWidth(shown))
  return { name: truncate(name, nameWidth), doing: ` · ${shown}` }
}

/**
 * Marks a session spawned beside its parent's work (a thread or a `/btw`
 * fork), so side work reads apart from a handoff before opening it.
 */
const sideThreadMark = (row: AgentRowEntry): string => {
  if (row.sideThread) return "side thread"
  return ""
}

/** `3 sessions` for a thread whose handoffs fold into the row; blank for one session. */
const sessionsMark = (row: AgentRowEntry): string => {
  const count = membersOf(row).length
  if (count < 2) return ""
  return `${count} sessions`
}

/**
 * The model the row's newest step ran on, by the name the status row gives
 * it, with that step's effort beside it as the status row puts it: `Sonnet
 * 5 high`. Blank before the row's first step.
 */
const modelLabel = (row: AgentRowEntry, models: ReadonlyArray<Model>, gap: string): string =>
  [
    ...Option.toArray(
      Option.map(Option.fromUndefinedOr(row.model), (id) => modelIdName(id, models)),
    ),
    ...Option.toArray(Option.fromUndefinedOr(row.effort)),
  ].join(gap)

/** What the row has spent; blank for a row that has spent nothing, so a never-run row stays quiet. */
const costMark = (row: AgentRowEntry): string => {
  if (row.costUsd <= 0) return ""
  return formatCost(row.costUsd)
}

/** The rows' summed cost, `$0.12`; blank when they have spent nothing. */
const rowsCost = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0)
  if (total <= 0) return ""
  return formatCost(total)
}

/** Columns a row keeps for its name; the right column never takes them. */
const NAME_ROOM = 24

/**
 * The right column: the side-thread mark, the session count, the model and
 * effort, the cost, the time. Each field goes when the column would eat into
 * the name's room: the side-thread mark first (the tree shape still shows the
 * nesting), then the model (the details say it), then the cost (the section
 * heading sums it), then the session count. The time always stays.
 */
export const rightColumn = (
  row: AgentRowEntry,
  now: number,
  rowWidth: number,
  models: ReadonlyArray<Model>,
): string => {
  const join = (parts: ReadonlyArray<string>) => parts.filter((part) => part.length > 0).join("  ")
  // The marker, the indent, the glyph and its space, and the gap before the column.
  const lead = textWidth(`${currentMarker(false)}${indentFor(row.depth)}`) + 4
  const room = rowWidth - lead - NAME_ROOM
  const time = timeFor(row, now)
  const sessions = sessionsMark(row)
  const cost = costMark(row)
  const model = modelLabel(row, models, " ")
  return (
    [
      [sideThreadMark(row), sessions, model, cost, time],
      [sessions, model, cost, time],
      [sessions, cost, time],
      [sessions, time],
    ]
      .map(join)
      .find((column) => textWidth(column) <= room) ?? time
  )
}

/**
 * How a pane row's run is drawn: the status glyph, the agent name, or muted
 * (the current marker and the tree indent, ` · <doing>`, the padding, the
 * right column, and an armed row's delete prompt).
 */
type RowTone = "glyph" | "name" | "muted"

/**
 * A pane row's runs in `rowWidth` columns: `<lead><glyph><name> · <doing>`
 * cut to the room `right` leaves, then `right` padded to the row's edge.
 */
const paneRow = (
  head: { readonly lead: string; readonly glyph: string },
  name: string,
  doing: string,
  right: string,
  rowWidth: number,
): ReadonlyArray<TextRun<RowTone>> => {
  const width = Math.max(0, rowWidth - textWidth(right) - 2)
  const parts = rowParts(`${head.lead}${head.glyph}`, name, doing, width)
  const left = truncateRuns<RowTone>(
    [
      { text: head.lead, tone: "muted" },
      { text: head.glyph, tone: "glyph" },
      { text: parts.name, tone: "name" },
      { text: parts.doing, tone: "muted" },
    ],
    width,
  )
  const used = left.reduce((sum, part) => sum + textWidth(part.text), 0)
  const pad = " ".repeat(Math.max(0, width - used) + 2)
  return [...left, { text: `${pad}${right}`, tone: "muted" }]
}

/** What a second Ctrl+X deletes: the row's session, or each session of its thread. */
const deletePrompt = (row: AgentRowEntry): string => {
  const count = membersOf(row).length
  if (count < 2) return "ctrl+x again to delete this session and its children"
  return `ctrl+x again to delete this thread's ${count} sessions and their children`
}

/** Marks the loop the shell is on, so a reader can find themselves in the list. */
const currentMarker = (current: boolean): string => {
  if (current) return "› "
  return "  "
}

/** "1 turn", not "1 turns". */
const formatTurns = (turns: number): string => {
  if (turns === 1) return "1 turn"
  return `${turns} turns`
}

const formatRounds = (rounds: number): string => {
  if (rounds === 1) return "1 round"
  return `${rounds} rounds`
}

/** A mean, with one decimal. */
const tenths = (value: number): string => String(Math.round(value * 10) / 10)

/** Lines after a model's own are indented under it. */
const QUALITY_INDENT = "  "

/**
 * `parts` joined by ` · ` into lines of at most `width` columns, the first
 * led by `lead` and the rest indented under it. A part wider than the line
 * keeps a line of its own, and the draw cuts that one.
 */
const packParts = (
  parts: ReadonlyArray<string>,
  width: number,
  lead: string,
): ReadonlyArray<string> => {
  const lines: Array<string> = []
  for (const part of parts) {
    const joined = `${lines.at(-1) ?? ""} · ${part}`
    if (lines.length === 0) lines.push(`${lead}${part}`)
    else if (textWidth(joined) <= width) lines[lines.length - 1] = joined
    else lines.push(`${QUALITY_INDENT}${part}`)
  }
  return lines
}

/**
 * How one model fared in the row's machine state, across the machine's
 * runs, in lines of the details column's `width`: `Haiku · 3 rounds ·
 * 1 dead · 1 oversize · $0.04/round`, then `pass 2/3 · green 1/1 · 2.5 rounds to
 * accept`, then its verdicts, each wrapped between its parts. A count with
 * nothing in it is left out, and so is a line left with nothing.
 */
const qualityLines = (
  row: ModelQuality,
  models: ReadonlyArray<Model>,
  width: number,
): ReadonlyArray<string> => {
  const head = [modelIdName(row.model, models), formatRounds(row.rounds)]
  if (row.dead > 0) head.push(`${row.dead} dead`)
  if (row.oversize > 0) head.push(`${row.oversize} oversize`)
  if (row.priced > 0) head.push(`${formatCost(row.costUsd / row.priced)}/round`)
  const checks = row.checks.pass + row.checks.fail
  const gates = row.gates.green + row.gates.red
  const outcome: Array<string> = []
  if (checks > 0) outcome.push(`pass ${row.checks.pass}/${checks}`)
  if (gates > 0) outcome.push(`green ${row.gates.green}/${gates}`)
  if (row.accepted.runs > 0) {
    outcome.push(`${tenths(row.accepted.rounds / row.accepted.runs)} rounds to accept`)
  }
  const verdicts = Object.entries(row.verdicts)
    .toSorted(([left], [right]) => Order.String(left, right))
    .map(([verdict, count]) => `${verdict} ${count}`)
  return [
    ...packParts(head, width, ""),
    ...[outcome, verdicts].flatMap((parts) => packParts(parts, width, QUALITY_INDENT)),
  ]
}

/**
 * Whether the row's loop is in a turn: the selected row's live detail says
 * so when it has one, since a listing read between two steps can lag the
 * loop; otherwise the listing does.
 */
const inTurn = (row: AgentRowEntry, detail: Option.Option<ExtensionAgentDetail>): boolean =>
  Option.match(detail, {
    onNone: () => working(row),
    onSome: (value) => value.status !== "Idle",
  })

/**
 * The detail line for the selected row, from the row's own totals, so a
 * stored session reads them too. Absent fields are dropped rather than
 * shown as placeholders — a session that never streamed has no model, and a
 * row of dashes reads as broken rather than as empty. A row with no turn
 * finished or running has nothing to say, so its line is blank.
 *
 * Turns and time count finished turns. A working loop names the turn it is
 * on instead and leaves the time out, so a child a minute into its first
 * turn does not read "0 turns · 0s". The model reads by the name the status
 * row gives it (`modelIdName` over `models`, the catalog).
 */
export const detailLabel = (
  row: AgentRowEntry,
  detail: Option.Option<ExtensionAgentDetail>,
  models: ReadonlyArray<Model>,
): string => {
  const model = Option.toArray(
    Option.map(Option.fromUndefinedOr(row.model), (id) => modelIdName(id, models)),
  )
  if (!inTurn(row, detail)) {
    if (row.turns === 0) return ""
    return [
      ...model,
      formatTurns(row.turns),
      formatCost(row.costUsd),
      formatDuration(row.durationMs, "padded"),
    ].join("  ·  ")
  }
  return [...model, `turn ${row.turns + 1} running`, formatCost(row.costUsd)].join("  ·  ")
}

// ── details column ──────────────────────────────────────────────────────────

/** Terminal columns from which the pane draws the details column beside the list. */
const DETAILS_FROM = 100

/** The details column's share of the pane: 40%, its `│` rule included. */
const detailsWidth = (width: number): number => Math.floor(width * 0.4)

/** Lines of the last answer the column shows at most; a cut answer ends in `…`. */
const ANSWER_LINES = 3

/** A path as the reader writes it: `~` for the home directory. */
const homePath = (path: string, home: string): string => {
  if (home.length === 0) return path
  if (path === home || path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

/** The first `count` non-blank lines of `text`; when more follow, the last kept ends in `…`. */
const headLines = (text: string, count: number): ReadonlyArray<string> => {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length <= count) return lines
  const kept = lines.slice(0, Math.max(1, count))
  return [...kept.slice(0, -1), `${kept.at(-1) ?? ""}…`]
}

/**
 * `3 turns · $0.01 · 1m 12s` once idle; `turn 4 running · $0.01` while the
 * loop is in a turn; blank before its first turn.
 */
const progressLabel = (row: AgentRowEntry, running: boolean): string => {
  if (!running) {
    if (row.turns === 0) return ""
    return [
      formatTurns(row.turns),
      formatCost(row.costUsd),
      formatDuration(row.durationMs, "compact"),
    ].join(" · ")
  }
  return [`turn ${row.turns + 1} running`, formatCost(row.costUsd)].join(" · ")
}

/**
 * How a details run is drawn: the agent name, the state glyph, plain text,
 * muted, a muted path (cut from its start), or a muted line of a model's
 * quality (the pane grows by those lines).
 */
type DetailTone = "name" | "glyph" | "plain" | "muted" | "path" | "quality"

type DetailRun = TextRun<DetailTone>

/**
 * The selected row's details, one array of runs per line: its name; its
 * glyph and state word (and why it needs the reader); `model · effort`;
 * turns, cost and time; how each model fared in a round thread's state; its
 * cwd; what it does now, else the head of its last answer; and its task. A
 * line with nothing to say is left out. The model and the totals are the
 * row's, so a stored session (no live detail) shows them beside its name,
 * state and cwd.
 */
const detailLines = (
  row: AgentRowEntry,
  section: AgentRowEntry["section"],
  glyph: string,
  detail: Option.Option<ExtensionAgentDetail>,
  quality: ReadonlyArray<ModelQuality>,
  place: PathPlace,
  answerLines: number,
  models: ReadonlyArray<Model>,
  width: number,
): ReadonlyArray<ReadonlyArray<DetailRun>> => {
  const reason = needsReason(row, detail)
  const state = [
    SECTION_WORD[section],
    ...Option.toArray(Option.liftPredicate(reason, (text) => text.length > 0)),
  ]
  const lines: Array<ReadonlyArray<DetailRun>> = [
    [{ text: nameFor(row), tone: "name" }],
    [
      { text: glyph, tone: "glyph" },
      { text: ` ${state.join(" · ")}`, tone: "plain" },
    ],
  ]
  const model = modelLabel(row, models, " · ")
  if (model.length > 0) lines.push([{ text: model, tone: "muted" }])
  const progress = progressLabel(row, inTurn(row, detail))
  if (progress.length > 0) lines.push([{ text: progress, tone: "muted" }])
  for (const entry of quality) {
    for (const text of qualityLines(entry, models, width)) lines.push([{ text, tone: "quality" }])
  }
  if (Predicate.isNotUndefined(row.cwd)) {
    lines.push([{ text: homePath(row.cwd, place.home), tone: "path" }])
  }
  const doing = doingFor(row, place)
  if (doing.length > 0) {
    lines.push([{ text: doing, tone: "plain" }])
  } else {
    const answer = Option.getOrElse(
      Option.flatMap(detail, (value) => value.lastAnswer),
      () => "",
    )
    for (const line of headLines(answer, answerLines)) lines.push([{ text: line, tone: "muted" }])
  }
  const task = Option.flatMap(detail, (value) => value.firstPrompt).pipe(
    Option.map(taskLine),
    Option.filter((line) => line.length > 0),
  )
  if (Option.isSome(task)) lines.push([{ text: `Task: ${task.value}`, tone: "muted" }])
  return lines
}

/**
 * The task a first prompt states: its first line once a round's source
 * lines are stripped, as the thread view's preview reads it.
 */
const taskLine = (prompt: string): string =>
  Option.getOrElse(
    Option.fromUndefinedOr(
      threadRoundBody(prompt)
        .split("\n")
        .find((line) => line.trim().length > 0),
    ),
    () => "",
  ).trim()

/**
 * The runs of one details line cut to `width` columns. A path, alone on its
 * line, keeps its tail, where its name is.
 */
const fitRuns = (runs: ReadonlyArray<DetailRun>, width: number): ReadonlyArray<DetailRun> =>
  truncateRuns(
    runs.map((run) => {
      if (run.tone !== "path") return run
      return { ...run, text: truncatePath(run.text, width) }
    }),
    width,
  )

// ── machine runs ────────────────────────────────────────────────────────────

/** One entry of the pane's list: a session's row, or a machine run of the shell's thread. */
const PaneEntry = Schema.Union([
  Schema.TaggedStruct("Agent", { row: AgentRowEntry }),
  Schema.TaggedStruct("Run", { run: MachineRunView }),
]).pipe(Schema.toTaggedUnion("_tag"))
type PaneEntry = typeof PaneEntry.Type

const agentEntry = (row: AgentRowEntry): PaneEntry => PaneEntry.cases.Agent.make({ row })
const runEntry = (run: MachineRunView): PaneEntry => PaneEntry.cases.Run.make({ run })

/** The entry's session row; none for a run. */
const entryRow = (entry: PaneEntry): Option.Option<AgentRowEntry> =>
  PaneEntry.match(entry, {
    Agent: ({ row }) => Option.some(row),
    Run: () => Option.none(),
  })

/** The list group an entry sits in: the runs, or a session's section. */
const entryGroup = (entry: PaneEntry): string =>
  PaneEntry.match(entry, {
    Agent: ({ row }) => row.listedUnder,
    Run: () => "runs",
  })

/**
 * The tone of a run's or a visit's glyph: at work, waiting for the reader,
 * waiting for its account, done, failed, stopped.
 */
type RunTone = "running" | "needs" | "waiting" | "done" | "failed" | "stopped"

interface RunMark {
  readonly glyph: string
  readonly tone: RunTone
}

/** What a run's glyph reads: a listed run's and a run page's alike. */
type RunState = Pick<MachineRunView, "status" | "pending">

/** Whether a run's round waits for its account until a time still ahead. */
const runWaits = (run: RunState, now: number): boolean => {
  const pending = run.pending
  if (Predicate.isUndefined(pending) || pending._tag !== "Round") return false
  return Predicate.isNotUndefined(pending.notBefore) && pending.notBefore > now
}

/**
 * A run's glyph, in the pane's own shapes: the pulse while it works, `●`
 * while it asks the reader, `◷` while its round waits for its account, `✓`
 * once final, `✕` failed, `■` stopped.
 */
const runMark = (run: RunState, now: number, frame: string): RunMark => {
  if (run.status === "asking") return { glyph: "●", tone: "needs" }
  if (run.status === "final") return { glyph: "✓", tone: "done" }
  if (run.status === "failed") return { glyph: "✕", tone: "failed" }
  if (run.status === "stopped") return { glyph: "■", tone: "stopped" }
  if (runWaits(run, now)) return { glyph: "◷", tone: "waiting" }
  return { glyph: frame, tone: "running" }
}

/**
 * A run's or a visit's glyph color: the warning's while it asks the reader,
 * the error's once it failed, the text's at work, muted otherwise.
 */
const runToneColor = (
  theme: ReturnType<typeof useTheme>["theme"],
  tone: RunTone,
  selected: boolean,
) => {
  if (selected) return theme.selectedListItemText
  if (tone === "needs") return theme.warning
  if (tone === "failed") return theme.error
  if (tone === "running") return theme.text
  return theme.textMuted
}

/**
 * The outcomes that failed their visit: a check's `fail`, a gate's `red`,
 * a state out of rounds, a round too big for its thread, a run that failed in it.
 */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set([
  "fail",
  "red",
  "exhausted",
  "oversize",
  "failed",
])

type StateVisit = MachineRunPage["trail"][number]

/** Whether the visit is the run's open one: it never ended. */
const isOpenVisit = (visit: StateVisit): boolean => Predicate.isUndefined(visit.endedAt)

/**
 * A visit's glyph: an ended visit's `✓`, `■` for the visit a stop ended,
 * or `✕` for a failed outcome or a last round with no verdict; the open
 * visit's is its run's.
 */
const visitMark = (visit: StateVisit, run: MachineRunPage, now: number, frame: string): RunMark => {
  if (isOpenVisit(visit)) return runMark(run, now, frame)
  if (visit.outcome === "stopped") return { glyph: "■", tone: "stopped" }
  const failed =
    Option.exists(Option.fromUndefinedOr(visit.outcome), (outcome) =>
      FAILED_OUTCOMES.has(outcome),
    ) ||
    (visit.dead && Predicate.isUndefined(visit.outcome))
  if (failed) return { glyph: "✕", tone: "failed" }
  return { glyph: "✓", tone: "done" }
}

/** What the run is doing, beside its state: blank while it works. */
const RUN_STATUS_WORD = {
  running: "",
  asking: "asking",
  final: "final",
  failed: "failed",
  stopped: "stopped",
} satisfies Record<MachineRunView["status"], string>

/** `implement #2`: a state and the visit of it the run is on. */
const runAt = (run: MachineRunView): string => `${run.state} #${run.visits[run.state] ?? 1}`

/** `implement #2 · asking`: where a run is, and its status once it is not at work. */
const runDoing = (run: MachineRunView): string =>
  [runAt(run), RUN_STATUS_WORD[run.status]].filter((part) => part.length > 0).join(" · ")

/** The open pane's detail line for a run row. */
const runDetailLabel = (run: MachineRunView, now: number): string =>
  [runDoing(run), `started ${formatAge(now - run.createdAt)} ago`, "enter opens its page"].join(
    "  ·  ",
  )

/** The details column's lines for a run row: its machine, its glyph and where it is, its age. */
const runDetailLines = (
  run: MachineRunView,
  mark: RunMark,
  now: number,
): ReadonlyArray<ReadonlyArray<DetailRun>> => [
  [{ text: `${run.machine} run`, tone: "name" }],
  [
    { text: mark.glyph, tone: "glyph" },
    { text: ` ${runDoing(run)}`, tone: "plain" },
  ],
  [{ text: `started ${formatAge(now - run.createdAt)} ago`, tone: "muted" }],
  [{ text: run.run, tone: "muted" }],
]

/** A visit's outcome and where the run went: `accepted → verify`, `→ review`. */
const visitOutcome = (visit: StateVisit): string => {
  const outcome = visit.outcome ?? ""
  if (Predicate.isUndefined(visit.to)) return outcome
  return [outcome, `→ ${visit.to}`].filter((part) => part.length > 0).join(" ")
}

/** The priced rounds' cost; blank when none was priced. */
const visitCost = (visit: StateVisit): string => {
  if (visit.priced === 0) return ""
  return formatCost(visit.costUsd)
}

/** What the run's priced rounds cost, over every visit. */
const runCost = (page: MachineRunPage): Option.Option<number> => {
  const priced = page.trail.filter((visit) => visit.priced > 0)
  if (priced.length === 0) return Option.none()
  return Option.some(priced.reduce((sum, visit) => sum + visit.costUsd, 0))
}

/** "1 visit", not "1 visits". */
const formatVisits = (count: number): string => {
  if (count === 1) return "1 visit"
  return `${count} visits`
}

/**
 * The page's title: `Run track · asking · 6 visits · 7 rounds · $0.42 ·
 * 4m`. Its status is blank while it works; the cost shows once a round was
 * priced; the age counts from its start.
 */
const runPageTitle = (page: MachineRunPage, now: number): string =>
  [
    `Run ${page.machine}`,
    RUN_STATUS_WORD[page.status],
    formatVisits(page.trail.length),
    formatRounds(page.trail.reduce((sum, visit) => sum + visit.rounds, 0)),
    ...Option.toArray(Option.map(runCost(page), formatCost)),
    formatAge(now - page.createdAt),
  ]
    .filter((part) => part.length > 0)
    .join(" · ")

/**
 * The detail line for the visit under the cursor: its rounds, a dead last
 * round, its cost, how long it took, and whether Enter opens a thread.
 */
const visitDetailLabel = (visit: StateVisit, threadListed: boolean, now: number): string => {
  const parts = [`${visit.state} #${visit.visit}`]
  if (visit.rounds > 0) parts.push(formatRounds(visit.rounds))
  if (visit.dead) parts.push("last round dead")
  const cost = visitCost(visit)
  if (cost.length > 0) parts.push(cost)
  const took = Option.match(Option.fromUndefinedOr(visit.endedAt), {
    onNone: () => `for ${formatDuration(now - visit.at, "compact")}`,
    onSome: (endedAt) => `took ${formatDuration(endedAt - visit.at, "compact")}`,
  })
  parts.push(took)
  if (threadListed) parts.push("enter opens its thread")
  return parts.join("  ·  ")
}

/** The second Ctrl+X's warning on a run page. */
const STOP_PROMPT = "ctrl+x again to stop this run"

/**
 * A run's page: one row per state visit, oldest first, with its model, its
 * outcome and where the run went, its cost and its age. Enter on a visit
 * opens its round's thread; a double Ctrl+X stops an active run; Esc or ←
 * goes back to the list.
 */
function RunPage(props: {
  readonly run: RunId
  readonly controller: AgentsController
  readonly models: () => ReadonlyArray<Model>
  readonly onBack: () => void
  /** Open a round's thread, by its row in the listing. */
  readonly onOpen: (row: AgentRowEntry) => void
}) {
  const { theme } = useTheme()
  const { rowWidth, sectionWidth } = usePickerGeometry()
  const tick = useSpinnerClock()
  // A first Ctrl+X arms the stop; the second stops, any other key disarms.
  const [armed, setArmed] = createSignal(false)
  const page = () => Option.filter(props.controller.runs.page(), (value) => value.run === props.run)
  const now = props.controller.now
  const frame = () => workingIconFrame(tick())
  const active = () => Option.exists(page(), isActiveRun)

  // A visit's round thread opens by its row in the listing, the row a
  // session pick opens: a thread's row is on its newest session.
  const threadRow = (visit: StateVisit): Option.Option<AgentRowEntry> =>
    Option.flatMap(Option.fromUndefinedOr(visit.thread), (thread) =>
      Option.fromUndefinedOr(
        props.controller.rows().find((row) => threadOf(row) === thread || holds(row, thread)),
      ),
    )

  /**
   * `<marker><glyph> state #n · model · outcome → to` on the left, the
   * cost and the age against the right edge. The open visit carries the
   * marker; a narrow row drops the model before it cuts the outcome, and
   * a very narrow one drops the cost.
   */
  const visitRuns = (visit: StateVisit, run: MachineRunPage): ReadonlyArray<TextRun<RowTone>> => {
    const age = formatAge(now() - visit.at)
    const cost = visitCost(visit)
    const right =
      [[cost, age].filter((part) => part.length > 0).join("  "), age].find(
        (column) => textWidth(column) <= Math.max(0, rowWidth() - 4 - NAME_ROOM),
      ) ?? age
    const model = Option.match(Option.fromUndefinedOr(visit.model), {
      onNone: () => "",
      onSome: (id) => modelIdName(id, props.models()),
    })
    const outcome = visitOutcome(visit)
    const room = Math.floor(Math.max(0, rowWidth() - textWidth(right) - 2) / 2)
    const withModel = [model, outcome].filter((part) => part.length > 0).join(" · ")
    const doing = [withModel, outcome].find((text) => textWidth(text) <= room) ?? outcome
    return paneRow(
      {
        lead: currentMarker(isOpenVisit(visit)),
        glyph: `${visitMark(visit, run, now(), frame()).glyph} `,
      },
      `${visit.state} #${visit.visit}`,
      doing,
      right,
      rowWidth(),
    )
  }

  const rows = (): ReadonlyArray<SelectListRow<StateVisit>> =>
    Option.match(page(), {
      onNone: () => [],
      onSome: (run) =>
        run.trail.map((visit) =>
          selectable(visit, (selected, id) => {
            const runColor = (kind: RowTone) => {
              if (kind === "glyph")
                return runToneColor(theme, visitMark(visit, run, now(), frame()).tone, selected())
              if (selected()) return theme.selectedListItemText
              if (kind === "name") return theme.info
              return theme.textMuted
            }
            const background = () => {
              if (selected()) return theme.primary
              return "transparent"
            }
            return (
              <box id={id} backgroundColor={background()} paddingLeft={1}>
                <text wrapMode="none" truncate>
                  <ToneRuns runs={visitRuns(visit, run)} color={runColor} />
                </text>
              </box>
            )
          }),
        ),
    })

  // The visit under the cursor, for the detail line.
  const [cursor, setCursor] = createSignal(Option.none<StateVisit>())
  // A re-read builds new visits; the cursor follows the visit's first step.
  const cursorVisit = () =>
    Option.flatMap(cursor(), (visit) =>
      Option.flatMap(page(), (run) =>
        Option.fromUndefinedOr(run.trail.find((entry) => entry.seq === visit.seq)),
      ),
    )

  const armOrStop = (): boolean => {
    if (!active()) return true
    if (armed()) {
      setArmed(false)
      props.controller.runs.stop(props.run)
      return true
    }
    setArmed(true)
    return true
  }

  const openVisit = (visit: StateVisit) =>
    Option.match(threadRow(visit), { onNone: () => {}, onSome: props.onOpen })

  // Enter shows only on a visit whose round thread is listed: a command's visit opens nothing.
  const keys = () => [
    KeyHints.move,
    ...Option.toArray(
      Option.liftPredicate(keyHint("enter", "thread"), () =>
        Option.isSome(Option.flatMap(cursorVisit(), threadRow)),
      ),
    ),
    ...Option.toArray(Option.liftPredicate(keyHint("ctrl+x", "stop"), active)),
    KeyHints.back,
  ]

  return (
    <PickerFrame
      title={Option.match(page(), {
        onNone: () => "Run",
        onSome: (run) => truncate(runPageTitle(run, now()), Math.max(1, sectionWidth() - 2)),
      })}
      keys={keys()}
      detail={Option.map(cursorVisit(), (visit) =>
        visitDetailLabel(visit, Option.isSome(threadRow(visit)), now()),
      )}
      error={Option.orElse(
        Option.liftPredicate(STOP_PROMPT, () => armed() && active()),
        props.controller.runs.error,
      )}
    >
      <SelectList
        id="run-page"
        open
        rows={rows}
        rowKey={(visit) => String(visit.seq)}
        // The page opens on the visit the run is on, else its last.
        sticky={(visits) => {
          const open = visits.findIndex(isOpenVisit)
          if (open >= 0) return Option.some(open)
          return Option.some(Math.max(0, visits.length - 1))
        }}
        onCursor={setCursor}
        extraKeys={(event, selected) => {
          if (event.ctrl === true && event.name === "x") return armOrStop()
          const wasArmed = armed()
          setArmed(false)
          if (event.name === "escape" && wasArmed) return true
          if (event.name === "left") {
            props.onBack()
            return true
          }
          if (event.name === "right") {
            Option.match(selected, { onNone: () => {}, onSome: openVisit })
            return true
          }
          return false
        }}
        loading={() => Option.isNone(page())}
        onSelect={openVisit}
        onDismiss={props.onBack}
      />
    </PickerFrame>
  )
}

export function AgentsPane(props: {
  open: boolean
  onClose: () => void
  controller: AgentsController
  onSelect: (row: AgentRowEntry) => void
  /** Where the TUI launched: a row's running call reads its paths against it. */
  place: PathPlace
  /** The catalog the status row names models by: a row's model reads by the same name. */
  models: () => ReadonlyArray<Model>
  /** Delete a session tree. Bound to Ctrl+X pressed twice on the same row. */
  onDelete: (row: AgentRowEntry) => void
}) {
  const { theme } = useTheme()
  // The row a first Ctrl+X armed; the second press on it deletes, any other key disarms.
  const [armed, setArmed] = createSignal(Option.none<string>())

  // A thread's row holds the shell's session when the reader went back to an
  // older session of it; a row for one session matches on the branch too.
  const isCurrent = (row: AgentRowEntry): boolean => {
    const active = props.controller.current()
    if (active.sessionId === row.sessionId) return active.branchId === row.branchId
    return holds(row, active.sessionId)
  }

  // Filtering is the server's job — it owns the same search the projection
  // tests cover — so typing refetches rather than filtering a local copy.
  const visible = () => props.controller.rows()

  // The same framing the slash-command popup uses: ruled off top and bottom
  // under the composer, so the columns come from the picker's budget rather
  // than a bordered pane's.
  const { rowWidth } = usePickerGeometry()

  const dimensions = useTerminalDimensions()
  // A wide terminal draws the selected row's details in a column beside the
  // list; a narrower one keeps the one-line detail under it.
  const wide = () => dimensions().width >= DETAILS_FROM
  const columnWidth = () => {
    if (wide()) return detailsWidth(dimensions().width)
    return 0
  }
  // The columns a details line may use: the column's, less its border and gutter.
  const detailTextWidth = () => Math.max(0, columnWidth() - 3)
  // The columns a list row may use: the picker's, less the details column.
  const listWidth = () => Math.max(0, rowWidth() - columnWidth())

  const tick = useSpinnerClock()
  // The shape says the state; the pulse animates while the loop works.
  const glyphFor = (section: AgentRowEntry["section"]): string =>
    statusGlyph(section, workingIconFrame(tick()))

  // Colour follows the shape: attention in `warning`, work in `text`, rest muted.
  const glyphColorFor = (section: AgentRowEntry["section"], selected: boolean) => {
    if (selected) return theme.selectedListItemText
    if (section === "needs") return theme.warning
    if (section === "running") return theme.text
    return theme.textMuted
  }

  // The name in the agent-name colour; a stored session's is muted with its dot.
  const nameColorFor = (row: AgentRowEntry, selected: boolean) => {
    if (selected) return theme.selectedListItemText
    if (row.section === "inactive") return theme.textMuted
    return theme.info
  }

  const mutedFor = (selected: boolean) => {
    if (selected) return theme.selectedListItemText
    return theme.textMuted
  }

  // The selected entry, for the details column: the list reports its cursor.
  const [cursor, setCursor] = createSignal(Option.none<PaneEntry>())
  const onCursor = (entry: Option.Option<PaneEntry>) => {
    setCursor(entry)
    props.controller.select(Option.flatMap(entry, entryRow))
  }

  // The list's entries: the thread's machine runs, then the sessions.
  const entries = (): ReadonlyArray<PaneEntry> => [
    ...props.controller.runs.list().map(runEntry),
    ...visible().map(agentEntry),
  ]

  // Enter on a session switches to it; on a run, opens its page.
  const choose = (entry: PaneEntry): void =>
    PaneEntry.match(entry, {
      Agent: ({ row }) => props.onSelect(row),
      // The page unmounts the list, and the list's cleanup clears its typed
      // filter: the page reads the whole listing, which holds each round's thread.
      Run: ({ run }) => props.controller.runs.view(Option.some(run.run)),
    })

  // First Ctrl+X arms the selected row; the second deletes it. The shell's own
  // loop is never a target: the pane would be deleting the session it lives on.
  const armOrDelete = (selected: Option.Option<AgentRowEntry>): boolean => {
    if (Option.isNone(selected) || isCurrent(selected.value)) return true
    if (Option.contains(armed(), selected.value.sessionId)) {
      setArmed(Option.none())
      props.onDelete(selected.value)
      return true
    }
    setArmed(Option.some(selected.value.sessionId))
    return true
  }

  /**
   * `<marker><indent><glyph> name · activity` on the left, padded so the
   * right column (the side-thread mark, then the run time or age) sits on
   * the right edge.
   */
  const rowRuns = (row: AgentRowEntry, selected: boolean): ReadonlyArray<TextRun<RowTone>> => {
    if (Option.contains(armed(), row.sessionId)) return [{ text: deletePrompt(row), tone: "muted" }]
    const right = rightColumn(row, props.controller.now(), listWidth(), props.models())
    return paneRow(
      {
        lead: `${currentMarker(isCurrent(row))}${indentFor(row.depth)}`,
        glyph: `${glyphFor(glyphSection(row, selected, props.controller.detail()))} `,
      },
      nameFor(row),
      activityFor(row, selected, props.controller.detail(), props.place),
      right,
      listWidth(),
    )
  }

  const armedColor = (row: AgentRowEntry) =>
    Option.liftPredicate(theme.error, () => Option.contains(armed(), row.sessionId))

  /**
   * A run's row: `<glyph> machine · state #n`, its age against the right
   * edge, in the session rows' columns.
   */
  const runRowRuns = (run: MachineRunView): ReadonlyArray<TextRun<RowTone>> => {
    const now = props.controller.now()
    return paneRow(
      {
        lead: currentMarker(false),
        glyph: `${runMark(run, now, workingIconFrame(tick())).glyph} `,
      },
      run.machine,
      runDoing(run),
      formatAge(now - run.createdAt),
      listWidth(),
    )
  }

  const runRow = (run: MachineRunView): SelectListRow<PaneEntry> =>
    selectable(runEntry(run), (selected, id) => {
      const background = () => {
        if (selected()) return theme.primary
        return "transparent"
      }
      const runColor = (kind: RowTone) => {
        if (kind === "glyph") {
          return runToneColor(theme, runMark(run, props.controller.now(), "").tone, selected())
        }
        if (selected()) return theme.selectedListItemText
        if (kind === "name") return theme.info
        return theme.textMuted
      }
      return (
        <box id={id} backgroundColor={background()} paddingLeft={1}>
          <text wrapMode="none" truncate>
            <ToneRuns runs={runRowRuns(run)} color={runColor} />
          </text>
        </box>
      )
    })

  /** The list's rows: a heading opens the runs and each section; a tree sits under one. */
  const rows = (): ReadonlyArray<SelectListRow<PaneEntry>> =>
    groupedRows(
      entries(),
      entryGroup,
      (first, count) =>
        decoration<PaneEntry>(() => (
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }}>
              {PaneEntry.match(first, {
                Agent: ({ row: head }) =>
                  sectionHeading(
                    head.listedUnder,
                    count,
                    visible().filter((row) => row.listedUnder === head.listedUnder),
                  ),
                Run: () => `Runs (${count})`,
              })}
            </text>
          </box>
        )),
      (entry) =>
        PaneEntry.match(entry, {
          Run: ({ run }) => runRow(run),
          Agent: ({ row }) => agentRow(row),
        }),
    )

  const agentRow = (row: AgentRowEntry): SelectListRow<PaneEntry> =>
    selectable(agentEntry(row), (selected, id) => {
      const background = () => {
        if (selected()) return theme.primary
        return "transparent"
      }
      const section = () => glyphSection(row, selected(), props.controller.detail())
      // An armed row is one warning: every run in `error`.
      const tone = (color: ReturnType<typeof mutedFor>) =>
        Option.getOrElse(armedColor(row), () => color)
      const runColor = (kind: RowTone) => {
        if (kind === "glyph") return tone(glyphColorFor(section(), selected()))
        if (kind === "name") return tone(nameColorFor(row, selected()))
        return tone(mutedFor(selected()))
      }
      return (
        <box id={id} backgroundColor={background()} paddingLeft={1}>
          {/* One row, one line: the time is right-aligned into the budget, so
                  an overflowing label is cut rather than wrapped under it, the
                  way the autocomplete popup and the thread rows clamp theirs. */}
          <text wrapMode="none" truncate style={{ fg: tone(theme.text) }}>
            <ToneRuns runs={rowRuns(row, selected())} color={runColor} />
          </text>
        </box>
      )
    })

  /** Open on the loop the shell is already on. */
  const sticky = (values: ReadonlyArray<PaneEntry>): Option.Option<number> =>
    Option.some(
      Math.max(
        0,
        values.findIndex((entry) => Option.exists(entryRow(entry), isCurrent)),
      ),
    )

  // The row under the cursor as the latest listing shows it: a re-read
  // moves its state and activity while the cursor stays on it.
  const cursorRow = () =>
    Option.flatMap(Option.flatMap(cursor(), entryRow), (row) =>
      Option.fromUndefinedOr(visible().find((entry) => sameKey(entry, row))),
    )
  // The run under the cursor, as the latest listing shows it.
  const cursorRun = () =>
    Option.flatMap(cursor(), (entry) =>
      PaneEntry.match(entry, {
        Agent: () => Option.none<MachineRunView>(),
        Run: ({ run }) =>
          Option.fromUndefinedOr(
            props.controller.runs.list().find((listed) => listed.run === run.run),
          ),
      }),
    )
  // The selected row's detail is the controller's, which it reads for that row alone.
  const cursorDetail = (row: AgentRowEntry) =>
    Option.filter(props.controller.detail(), () => row.live)
  const cursorSection = () =>
    Option.match(cursorRow(), {
      onNone: () => "idle" as const,
      onSome: (row) => glyphSection(row, true, cursorDetail(row)),
    })
  // The details column's lines for the row under the cursor.
  const details = (answerLines: number): ReadonlyArray<ReadonlyArray<DetailRun>> =>
    Option.match(cursorRow(), {
      onNone: () =>
        Option.match(cursorRun(), {
          onNone: () => [],
          onSome: (run) => {
            const now = props.controller.now()
            return runDetailLines(run, runMark(run, now, workingIconFrame(tick())), now)
          },
        }),
      onSome: (row) =>
        detailLines(
          row,
          cursorSection(),
          glyphFor(cursorSection()),
          cursorDetail(row),
          props.controller.quality(),
          props.place,
          answerLines,
          props.models(),
          detailTextWidth(),
        ),
    })
  // Lines the list draws: its filter row, each row, and a heading per section.
  const listLines = () => {
    const listed = entries()
    if (listed.length === 0) return 2
    const headings = listed.filter((entry, index) =>
      Option.match(Option.fromUndefinedOr(listed[index - 1]), {
        onNone: () => true,
        onSome: (previous) => entryGroup(previous) !== entryGroup(entry),
      }),
    ).length
    return 1 + listed.length + headings
  }
  // A wide pane asks for the rows its taller column needs: the list's, or
  // the details' with the whole answer head. The frame keeps its own caps.
  // A round thread's quality lines come on top of the rows the pane keeps.
  const qualityRows = () => details(0).filter((line) => line[0]?.tone === "quality").length
  const wideHeight = () =>
    Option.liftPredicate(
      pickerHeight(
        Math.max(listLines(), details(ANSWER_LINES).length - qualityRows()) - 1,
        dimensions().height,
        1 + qualityRows(),
      ),
      wide,
    )
  // The answer head takes what the column's rows leave, at least one line.
  const columnLines = () => {
    const rows = Option.getOrElse(wideHeight(), () => 0) - 4
    const fixed = details(0).length
    return details(Math.min(ANSWER_LINES, Math.max(1, rows - fixed)))
  }
  const columnColor = (tone: DetailTone, section: AgentRowEntry["section"]) => {
    if (tone === "name") return theme.info
    if (tone === "glyph") return glyphColorFor(section, false)
    if (tone === "plain") return theme.text
    return theme.textMuted
  }

  return (
    <Show when={props.open}>
      {/* A run's page takes the pane while it shows; Esc or ← brings the
          list back. */}
      <Show
        when={Option.getOrUndefined(props.controller.runs.viewing())}
        keyed
        fallback={
          // A heading opens each section, so the pane draws more lines than it
          // has rows. Under 100 columns the frame adds the detail line under
          // them; from 100 the details column stands beside the list instead.
          <PickerFrame
            title={paneTitle(visible())}
            keys={[KeyHints.move, KeyHints.select, KeyHints.delete, KeyHints.close]}
            height={Option.getOrUndefined(wideHeight())}
            detail={Option.getOrUndefined(
              Option.liftPredicate(
                Option.liftPredicate(
                  Option.match(cursorRow(), {
                    onNone: () =>
                      Option.match(cursorRun(), {
                        onNone: () => "",
                        onSome: (run) => runDetailLabel(run, props.controller.now()),
                      }),
                    onSome: (row) => detailLabel(row, cursorDetail(row), props.models()),
                  }),
                  () => entries().length > 0,
                ),
                () => !wide(),
              ),
            )}
            error={props.controller.error()}
          >
            {/* The list and the column share one row box that stays mounted, so
            a resize across the threshold redraws the column alone and the
            list keeps its cursor and filter. */}
            <box flexDirection="row" flexGrow={1}>
              <box flexDirection="column" flexGrow={1} flexShrink={1}>
                <SelectList
                  id="agents"
                  open={props.open}
                  rows={rows}
                  rowKey={(entry) =>
                    PaneEntry.match(entry, {
                      Agent: ({ row }) => `${row.sessionId}/${row.branchId}`,
                      Run: ({ run }) => `run ${run.run}`,
                    })
                  }
                  filter={{ onQueryChange: props.controller.refresh }}
                  sticky={sticky}
                  // One detail read per selection, not per keystroke batch: the
                  // controller ignores a repeat of the row it is already fetching.
                  onCursor={onCursor}
                  extraKeys={(event, selected) => {
                    if (event.name === "escape" && Option.isSome(armed())) {
                      setArmed(Option.none())
                      return true
                    }
                    if (event.ctrl === true && event.name === "x")
                      return armOrDelete(Option.flatMap(selected, entryRow))
                    setArmed(Option.none())
                    // The arrows the palette uses between levels: ← leaves the pane for
                    // the composer, → opens the entry under the cursor as ↵ does.
                    if (event.name === "left") {
                      props.onClose()
                      return true
                    }
                    if (event.name === "right") {
                      Option.match(selected, { onNone: () => {}, onSome: choose })
                      return true
                    }
                    return false
                  }}
                  loading={props.controller.loading}
                  onSelect={choose}
                  onDismiss={props.onClose}
                />
              </box>
              <Show when={wide()}>
                <box
                  flexDirection="column"
                  flexShrink={0}
                  width={columnWidth()}
                  border={["left"]}
                  borderColor={theme.border}
                  paddingLeft={1}
                  paddingRight={1}
                  overflow="hidden"
                >
                  <For each={columnLines()}>
                    {(runs) => (
                      <text wrapMode="none" height={1} flexShrink={0}>
                        <ToneRuns
                          runs={fitRuns(runs, detailTextWidth())}
                          color={(tone) => columnColor(tone, cursorSection())}
                        />
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          </PickerFrame>
        }
      >
        {(run) => (
          <RunPage
            run={run}
            controller={props.controller}
            models={props.models}
            onBack={() => props.controller.runs.view(Option.none())}
            onOpen={props.onSelect}
          />
        )}
      </Show>
    </Show>
  )
}

export default defineClientExtension(AGENTS_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, shell, workspace } = yield* ClientContext
    const place = { cwd: workspace.cwd, home: workspace.home }

    const controller = yield* makeAgentsController(
      (input) =>
        transport.request(ref(AgentsViewRpc.ListAgents), input).pipe(
          Effect.map((reply) => reply.rows),
          Effect.mapError((error) => ({ message: String(error) })),
        ),
      (key) =>
        transport.agentDetail(key).pipe(Effect.mapError((error) => ({ message: String(error) }))),
      {
        // A session that is no round thread, or a run the caller does not
        // own, has no quality to show.
        quality: (key) =>
          transport
            .request(ref(MachinesRpc.Quality), { session: key.sessionId })
            .pipe(Effect.orElseSucceed((): ReadonlyArray<ModelQuality> => [])),
        // A server with no machines extension lists no runs.
        runs: (session) =>
          transport
            .request(ref(MachinesRpc.Runs), {}, session)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<MachineRunView> => [])),
        page: (run, since) =>
          transport
            .request(ref(MachinesRpc.Page), { run, since })
            .pipe(Effect.mapError((error) => ({ message: error.message }))),
        stop: (run) =>
          transport.request(ref(MachinesRpc.Stop), { run }).pipe(
            Effect.asVoid,
            Effect.mapError((error) => ({ message: error.message })),
          ),
      },
    )
    const openPane = () => {
      shell.pane.open(AGENTS_PANE)
      controller.runs.view(Option.none())
      controller.refresh("")
    }

    return clientContributions(
      // A child session in view says so on the status row, and how to get
      // back to the tree: the reader can tell a child from its parent at a
      // glance. On a narrow row the child label gives way first, whole, then
      // the way back, both before the cwd: the label never costs the reader
      // the way back or the cwd.
      statusLabelContribution({
        priority: 0,
        produce: () =>
          Option.match(controller.watched(), {
            onNone: () => [],
            onSome: (row) => [
              {
                text: `↳ child ${wholeWords(nameFor(row), WATCHED_NAME)}`,
                color: "info",
                short: { text: "", rank: STATUS_YIELD.debug - 1 },
              },
              {
                text: TRAY_HINT,
                color: "textMuted",
                key: TRAY_KEY,
                short: { text: "", rank: STATUS_YIELD.cwd - 0.5 },
              },
            ],
          }),
      }),
      widgetContribution({
        id: "agents.tray",
        // Under the status line, not between the transcript and the composer:
        // the tray is chrome about background work, and the reply stays next
        // to the prompt it answers.
        slot: "below-input",
        component: () => <SubagentTray controller={controller} place={place} />,
      }),
      clientCommandContribution({
        id: "agents.view",
        // The one session browser: the palette item, `/sessions`, `/agents` and
        // `/tree` all open this pane.
        title: "Sessions",
        description: "Browse and switch sessions: every agent loop, live and stored",
        category: "Session",
        slash: "sessions",
        aliases: ["agents", "tree"],
        // A bare key: the host fires it only while the composer is empty and
        // nothing else is open, so ← in a draft still moves the text cursor.
        keybind: "left",
        onSelect: openPane,
      }),
      widgetContribution({
        id: AGENTS_PANE,
        // Docked under the composer rather than covering the transcript: the
        // agent list is something you read *while* working, not instead of it.
        slot: "below-input",
        component: () => (
          <AgentsPane
            place={place}
            models={() => Option.getOrElse(transport.modelCatalog(), () => [])}
            open={controller.open()}
            controller={controller}
            onClose={() => shell.pane.close(AGENTS_PANE)}
            onDelete={(row) =>
              shell.cast(
                // A thread's row is all its sessions. A delete keeps a handoff
                // of the session it removes, so the newest goes first and each
                // older one then has no handoff left to keep.
                Effect.forEach(membersOf(row).toReversed(), (sessionId) =>
                  transport.deleteSession(sessionId),
                ).pipe(
                  // The reader asked for the delete, so a refusal shows on the
                  // status row; the row stays in the listing.
                  Effect.catch((error) =>
                    Effect.sync(() => shell.notify(error.message)).pipe(
                      Effect.andThen(Effect.logWarning("agents.delete failed")),
                      Effect.annotateLogs({ sessionId: row.sessionId, error: error.message }),
                    ),
                  ),
                  // The pane is open and may be filtered, so the listing is
                  // re-read under the query the reader typed, not under "".
                  Effect.andThen(Effect.sync(() => controller.reload())),
                ),
              )
            }
            onSelect={(row) => {
              shell.pane.close(AGENTS_PANE)
              // Rows are already keyed per branch, so there is no active-branch
              // lookup to do — the row *is* the loop being switched to.
              shell.switchSession({
                sessionId: row.sessionId,
                branchId: row.branchId,
                name: Option.fromUndefinedOr(row.name).pipe(Option.getOrElse(() => "Unnamed")),
              })
            }}
          />
        ),
      }),
    )
  }),
})
