/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Option, Order, Predicate, Schedule } from "effect"
import { createEffect, createRoot, createSignal, For, on, Show } from "solid-js"
import {
  type AgentRowEntry,
  AgentsViewRpc,
  BTW_EXTENSION_ID,
  childTaskBody,
  DELEGATE_EXTENSION_ID,
  type ListAgentsInput,
  SESSION_TOOLS_EXTENSION_ID,
  threadTaskBody,
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
  keyHint,
  KeyHints,
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

const TRAY_KEY = "ctrl+t"
const TRAY_HINT = `${TRAY_KEY} sessions`
const TRAY_MAX_ROWS = 3
/**
 * Columns of a child's name on the status row; a delegate's name is often its
 * whole task. At 100 columns the left group has 71 beside the right group
 * (`cache 5m · ctx 0% · $0.002`). The phase, the cwd, `Claude Sonnet 5.5` and
 * the way back take 49 of them, and ` · ↳ child ` 11 more: 11 are left for
 * the name. At 60 and 40 columns the way back alone does not fit, so the
 * label never shows there.
 */
const WATCHED_NAME = 11

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
 * A finished side thread reports to no one: its starter is not woken, so the
 * tray says it is done. A delegate child's completion lands in its parent's
 * transcript, so it gets no done row.
 */
const finishesSilently = (row: AgentRowEntry): boolean => row.sideThread && row.delegate !== true

export function SubagentTray(props: { controller: AgentsController; place: PathPlace }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()
  const running = () =>
    subtreeRows(props.controller.rows(), props.controller.current()).filter(working)
  // A done thread the shell is on is shown, so it leaves the tray at once.
  const finished = () =>
    props.controller.done().filter((row) => !holds(row, props.controller.current().sessionId))
  // Two columns of padding, the glyph and its space, and the hint on the first line.
  const rowWidth = () => Math.max(8, dimensions().width - 4 - textWidth(TRAY_HINT) - 2)
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
                  {`${" ".repeat(Math.max(1, rowWidth() - textWidth(line.text) + 2))}${TRAY_HINT}`}
                </span>
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
  readonly query: string
  readonly root: Option.Option<string>
  readonly session: ActiveExtensionSession
  readonly view: number
  readonly activityRows: Option.Option<ReadonlyArray<AgentRowEntry>>
}

/** The slow clock a child's own turns are read on; they raise no event in this session. */
const POLL_EVERY = "2 seconds"

export const makeAgentsController = (
  fetchRows: (
    input: ListAgentsInput,
  ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
  fetchDetail: (key: RowKey) => Effect.Effect<ExtensionAgentDetail, { readonly message: string }>,
): Effect.Effect<AgentsSource, never, ClientContext> =>
  Effect.gen(function* () {
    const { transport, shell, lifecycle, activity } = yield* ClientContext
    const empty: ReadonlyArray<AgentRowEntry> = []
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
      return fetchRows(input).pipe(
        Effect.flatMap((rows) => {
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

    // A delegate pulse in the current session means its subtree changed; so
    // does a session-tools pulse, which `thread.start` sends. A BTW pulse
    // discovers a new fork when complete empty/inactive knowledge stopped
    // polling; once a child is live, its stream pulses leave the clock in charge.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (
          pulse.extensionId === DELEGATE_EXTENSION_ID ||
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
    // clock. Stored children alone never change on their own: a delegate pulse
    // announces a new or woken one, so the tray stops polling for them. A
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

    return {
      rows,
      current: transport.currentSession,
      error: listing.error,
      loading: listing.loading,
      refresh,
      reload: listing.refresh,
      detail,
      select,
      open,
      done,
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
 * Marks a session spawned beside its parent's work (a delegate child or a
 * `/btw` fork), so side work reads apart from a handoff before opening it.
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

/** Rows narrower than this drop the side-thread mark. */
const NARROW_ROW = 80

/**
 * The right column: the side-thread mark, the session count, the time. In
 * a narrow pane the side-thread mark goes first, so the name keeps its
 * room; the tree shape still shows the nesting.
 */
const rightColumn = (row: AgentRowEntry, now: number, rowWidth: number): string => {
  const join = (parts: ReadonlyArray<string>) => parts.filter((part) => part.length > 0).join("  ")
  if (rowWidth < NARROW_ROW) return join([sessionsMark(row), timeFor(row, now)])
  return join([sideThreadMark(row), sessionsMark(row), timeFor(row, now)])
}

/**
 * How a pane row's run is drawn: the status glyph, the agent name, or muted
 * (the current marker and the tree indent, ` · <doing>`, the padding, the
 * right column, and an armed row's delete prompt).
 */
type RowTone = "glyph" | "name" | "muted"

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

/**
 * Drop the provider prefix from a model id: `anthropic/claude-sonnet-5` becomes
 * `claude-sonnet-5`. The detail line is the widest content in the panel, and
 * the prefix is the least informative part of it — every row in a given install
 * usually shares one.
 */
const shortModel = (model: string): string => {
  const slash = model.lastIndexOf("/")
  if (slash < 0) return model
  return model.slice(slash + 1)
}

/** "1 turn", not "1 turns". */
const formatTurns = (turns: number): string => {
  if (turns === 1) return "1 turn"
  return `${turns} turns`
}

/**
 * The detail line for the selected row. Absent fields are dropped rather than
 * shown as placeholders — a session that never streamed has no model, and a
 * row of dashes reads as broken rather than as empty.
 *
 * Turns and time count finished turns. A working loop names the turn it is
 * on instead and leaves the time out, so a child a minute into its first
 * turn does not read "0 turns · 0s".
 */
export const detailLabel = (detail: Option.Option<ExtensionAgentDetail>): string =>
  Option.match(detail, {
    onNone: () => "",
    onSome: (value) => {
      if (value.status === "Idle") {
        return [
          ...Option.toArray(Option.map(value.model, shortModel)),
          formatTurns(value.turns),
          formatCost(value.costUsd),
          formatDuration(value.durationMs, "padded"),
        ].join("  ·  ")
      }
      return [
        ...Option.toArray(Option.map(value.model, shortModel)),
        `turn ${value.turns + 1} running`,
        formatCost(value.costUsd),
      ].join("  ·  ")
    },
  })

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

/** `3 turns · $0.01 · 1m 12s` once idle; `turn 4 running · $0.01` while the loop is in a turn. */
const progressLabel = (value: ExtensionAgentDetail): string => {
  if (value.status === "Idle") {
    return [
      formatTurns(value.turns),
      formatCost(value.costUsd),
      formatDuration(value.durationMs, "compact"),
    ].join(" · ")
  }
  return [`turn ${value.turns + 1} running`, formatCost(value.costUsd)].join(" · ")
}

/**
 * How a details run is drawn: the agent name, the state glyph, plain text,
 * muted, or a muted path (cut from its start).
 */
type DetailTone = "name" | "glyph" | "plain" | "muted" | "path"

type DetailRun = TextRun<DetailTone>

/**
 * The selected row's details, one array of runs per line: its name; its
 * glyph and state word (and why it needs the reader); `model · effort`;
 * turns, cost and time; its cwd; what it does now, else the head of its last
 * answer; and its task. A line with nothing to say is left out, so a stored
 * session (no live detail) shows its name, state and cwd.
 */
const detailLines = (
  row: AgentRowEntry,
  section: AgentRowEntry["section"],
  glyph: string,
  detail: Option.Option<ExtensionAgentDetail>,
  place: PathPlace,
  answerLines: number,
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
  if (Option.isSome(detail)) {
    const model = [
      ...Option.toArray(Option.map(detail.value.model, shortModel)),
      ...Option.toArray(detail.value.effort),
    ].join(" · ")
    if (model.length > 0) lines.push([{ text: model, tone: "muted" }])
    lines.push([{ text: progressLabel(detail.value), tone: "muted" }])
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
 * The task a first prompt states: its first line once a child's or a
 * thread's source line is stripped, as the thread view's preview reads it.
 */
const taskLine = (prompt: string): string =>
  Option.getOrElse(
    Option.fromUndefinedOr(
      threadTaskBody(childTaskBody(prompt))
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

export function AgentsPane(props: {
  open: boolean
  onClose: () => void
  controller: AgentsController
  onSelect: (row: AgentRowEntry) => void
  /** Where the TUI launched: a row's running call reads its paths against it. */
  place: PathPlace
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

  // The selected row, for the details column: the list reports its cursor.
  const [cursor, setCursor] = createSignal(Option.none<AgentRowEntry>())
  const onCursor = (row: Option.Option<AgentRowEntry>) => {
    setCursor(row)
    props.controller.select(row)
  }

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
    const right = rightColumn(row, DateTime.toEpochMillis(DateTime.nowUnsafe()), listWidth())
    const width = Math.max(0, listWidth() - textWidth(right) - 2)
    const lead = `${currentMarker(isCurrent(row))}${indentFor(row.depth)}`
    const glyph = `${glyphFor(glyphSection(row, selected, props.controller.detail()))} `
    const parts = rowParts(
      `${lead}${glyph}`,
      nameFor(row),
      activityFor(row, selected, props.controller.detail(), props.place),
      width,
    )
    const left = truncateRuns<RowTone>(
      [
        { text: lead, tone: "muted" },
        { text: glyph, tone: "glyph" },
        { text: parts.name, tone: "name" },
        { text: parts.doing, tone: "muted" },
      ],
      width,
    )
    const used = left.reduce((sum, run) => sum + textWidth(run.text), 0)
    const pad = " ".repeat(Math.max(0, width - used) + 2)
    return [...left, { text: `${pad}${right}`, tone: "muted" }]
  }

  const armedColor = (row: AgentRowEntry) =>
    Option.liftPredicate(theme.error, () => Option.contains(armed(), row.sessionId))

  /** The list's rows: a heading opens each section. */
  const rows = (): ReadonlyArray<SelectListRow<AgentRowEntry>> =>
    groupedRows(
      visible(),
      (row) => row.section,
      (first, count) =>
        decoration<AgentRowEntry>(() => (
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }}>
              {`${SECTION_TITLE[first.section]} (${count})`}
            </text>
          </box>
        )),
      (row) =>
        selectable(row, (selected, id) => {
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
        }),
    )

  /** Open on the loop the shell is already on. */
  const sticky = (values: ReadonlyArray<AgentRowEntry>): Option.Option<number> =>
    Option.some(Math.max(0, values.findIndex(isCurrent)))

  // The row under the cursor as the latest listing shows it: a re-read
  // moves its state and activity while the cursor stays on it.
  const cursorRow = () =>
    Option.flatMap(cursor(), (row) =>
      Option.fromUndefinedOr(visible().find((entry) => sameKey(entry, row))),
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
  const details = (answerLines: number) =>
    Option.match(cursorRow(), {
      onNone: () => [],
      onSome: (row) =>
        detailLines(
          row,
          cursorSection(),
          glyphFor(cursorSection()),
          cursorDetail(row),
          props.place,
          answerLines,
        ),
    })
  // Lines the list draws: its filter row, each row, and a heading per section.
  const listLines = () => {
    const rows = visible()
    if (rows.length === 0) return 2
    const headings = rows.filter((row, index) => rows[index - 1]?.section !== row.section).length
    return 1 + rows.length + headings
  }
  // A wide pane asks for the rows its taller column needs: the list's, or
  // the details' with the whole answer head. The frame keeps its own caps.
  const wideHeight = () =>
    Option.liftPredicate(
      pickerHeight(Math.max(listLines(), details(ANSWER_LINES).length) - 1, dimensions().height, 1),
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
      {/* A heading opens each section, so the pane draws more lines than it
          has rows. Under 100 columns the frame adds the detail line under
          them; from 100 the details column stands beside the list instead. */}
      <PickerFrame
        title={paneTitle(visible())}
        keys={[
          KeyHints.move,
          KeyHints.select,
          KeyHints.delete,
          keyHint("ctrl+t", "hide"),
          KeyHints.close,
        ]}
        height={Option.getOrUndefined(wideHeight())}
        detail={Option.getOrUndefined(
          Option.liftPredicate(
            Option.liftPredicate(
              detailLabel(props.controller.detail()),
              () => visible().length > 0,
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
              rowKey={(row) => `${row.sessionId}/${row.branchId}`}
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
                if (event.ctrl === true && event.name === "x") return armOrDelete(selected)
                setArmed(Option.none())
                // The arrows the palette uses between levels: ← leaves the pane for
                // the composer, → opens the agent under the cursor as ↵ does.
                if (event.name === "left") {
                  props.onClose()
                  return true
                }
                if (event.name === "right") {
                  Option.match(selected, { onNone: () => {}, onSome: props.onSelect })
                  return true
                }
                return false
              }}
              loading={props.controller.loading}
              onSelect={props.onSelect}
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
                      runs={fitRuns(runs, Math.max(0, columnWidth() - 3))}
                      color={(tone) => columnColor(tone, cursorSection())}
                    />
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </PickerFrame>
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
    )
    const openPane = () => {
      shell.pane.open(AGENTS_PANE)
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
      clientCommandContribution({
        id: "agents.toggle",
        title: "Show or hide sessions",
        category: "Session",
        // A ctrl key: it fires over a draft and over the open pane, so it
        // closes the pane as well as opening it.
        keybind: "ctrl+t",
        onSelect: () => {
          if (controller.open()) shell.pane.close(AGENTS_PANE)
          else openPane()
        },
      }),
      widgetContribution({
        id: AGENTS_PANE,
        // Docked under the composer rather than covering the transcript: the
        // agent list is something you read *while* working, not instead of it.
        slot: "below-input",
        component: () => (
          <AgentsPane
            place={place}
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
