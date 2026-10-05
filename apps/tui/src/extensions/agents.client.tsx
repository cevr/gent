/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Option, Order, Predicate, Schedule } from "effect"
import { createEffect, createRoot, createSignal, For, on, Show } from "solid-js"
import {
  type AgentRowEntry,
  AgentsViewRpc,
  BTW_EXTENSION_ID,
  DELEGATE_EXTENSION_ID,
  type ListAgentsInput,
  SESSION_TOOLS_EXTENSION_ID,
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
  fitWidth,
  formatAge,
  formatCost,
  formatDuration,
  groupedRows,
  keyHint,
  KeyHints,
  type PathPlace,
  PickerFrame,
  runningCallLabel,
  selectable,
  SelectList,
  type SelectListRow,
  sessionQuery,
  textWidth,
  TrayFrame,
  truncate,
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

const TRAY_HINT = "ctrl+t sessions"
const TRAY_MAX_ROWS = 3

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
): ReadonlyArray<{ readonly mark: TrayMark; readonly text: string }> => {
  const working = inStartOrder(running).slice(0, TRAY_MAX_ROWS)
  const finished = done.slice(0, TRAY_MAX_ROWS - working.length)
  const lines: Array<{ readonly mark: TrayMark; readonly text: string }> = [
    ...working.map((row) => ({
      mark: "running" as const,
      text: truncate(rowLabel("", nameFor(row), doingFor(row, place), width), width),
    })),
    ...finished.map((row) => ({ mark: "done" as const, text: truncate(nameFor(row), width) })),
  ]
  const rest = running.length - working.length + done.length - finished.length
  if (rest > 0) lines.push({ mark: "none", text: `+${rest} more` })
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
    subtreeRows(props.controller.rows(), props.controller.current()).filter(
      (row) => row.section === "running",
    )
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
              <span style={{ fg: theme.textMuted }}>{line.text}</span>
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
): Effect.Effect<AgentsController, never, ClientContext> =>
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
      if (now.section !== "running" && stamp === readStamp) return
      readStamp = stamp
      readDetail()
    }

    // Each thread's section at the last listing, and the side threads that
    // finished since, keyed by thread: a handoff moves a row to a new session
    // but keeps its thread. They live here, outside any component, so the
    // tray keeps them while it hides for the pane. An entry also names the
    // thread the shell was on when it finished (`scope`), the root whose
    // whole listing says whether the thread still exists.
    const lastSection = new Map<string, AgentRowEntry["section"]>()
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
        if (now.section === "running" || holds(now, here)) continue
        next.set(key, { ...entry, row: now })
      }
      // What finished is read in the shell's subtree, where the tray shows it.
      const inView = subtreeRows(reply.rows, { sessionId: here })
      for (const row of inView) {
        const key = threadOf(row)
        if (
          lastSection.get(key) === "running" &&
          row.section !== "running" &&
          finishesSilently(row) &&
          !next.has(key)
        ) {
          next.set(key, { row, scope })
        }
      }
      // The reader sees the thread the shell is on too: a finish watched from
      // inside it is seen, so it is no done row back at its starter.
      const seen = [...inView, ...reply.rows.filter((row) => holds(row, here))]
      for (const row of seen) lastSection.set(threadOf(row), row.section)
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
    lifecycle.addCleanup(
      activity.include(() => {
        const sessionId = transport.currentSession().sessionId
        const children = descendants()
        if (Option.isNone(children)) return { sessionId, state: "unknown" }
        const live = children.value.filter((row) => row.section !== "inactive")
        if (live.some((row) => row.status === "WaitingForInteraction"))
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
    }
  })

/** Section headings, with the count each carries. Empty sections are skipped. */
const SECTION_TITLE = {
  running: "Running",
  idle: "Idle",
  inactive: "Inactive",
} satisfies Record<AgentRowEntry["section"], string>

/** "1 running, 0 idle, 3 inactive" for the pane title: each loop counted by its section, its own state. */
const countsLabel = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const count = (state: AgentRowEntry["section"]) =>
    rows.filter((row) => row.section === state).length
  return `${count("running")} running, ${count("idle")} idle, ${count("inactive")} inactive`
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
 * glyph says running or idle, so no state word repeats it; a selected row
 * whose detail waits on an answer says so, which no glyph shows.
 */
const activityFor = (
  row: AgentRowEntry,
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
  place: PathPlace,
): string => {
  const doing = doingFor(row, place)
  if (doing.length > 0) return doing
  return liveDetail(selected, detail).pipe(
    Option.filter((value) => value.status === "WaitingForInteraction"),
    Option.match({ onNone: () => "", onSome: () => "waiting for an answer" }),
  )
}

/**
 * The section a row's glyph draws: the listing reports a resident loop as
 * idle (it never reads state), so the selected row's live detail shows the
 * pulse when the loop runs. The row stays under its listed heading.
 */
const glyphSection = (
  row: AgentRowEntry,
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
): AgentRowEntry["section"] =>
  Option.match(liveDetail(selected, detail), {
    onNone: () => row.section,
    onSome: (value) => {
      if (value.status === "Running" || value.status === "WaitingForInteraction") return "running"
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
  if (row.section !== "running") return ageFor(row, now)
  return Option.match(Option.fromUndefinedOr(row.runningSince), {
    onNone: () => ageFor(row, now),
    onSome: (runningSince) => formatDuration(now - runningSince, "compact"),
  })
}

/**
 * `<head><name> · <doing>` in `width` columns. The activity keeps up to half
 * the row and the name is cut to what is left, so a long task never pushes
 * what the agent is doing off the row.
 */
const rowLabel = (head: string, name: string, doing: string, width: number): string => {
  if (doing.length === 0) return `${head}${name}`
  const shown = truncate(doing, Math.floor(width / 2))
  const nameWidth = Math.max(1, width - textWidth(head) - textWidth(" · ") - textWidth(shown))
  return `${head}${truncate(name, nameWidth)} · ${shown}`
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
 * One pane row: the left text, padded, and the right column drawn muted. The
 * status glyph is the column at `glyphAt` in `left`, drawn in its own colour;
 * `None` when the row draws no glyph.
 */
interface RowLine {
  readonly left: string
  readonly glyphAt: Option.Option<number>
  readonly right: string
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

  const tick = useSpinnerClock()
  // The running pulse animates; idle and inactive share a dot and differ by colour.
  const glyphFor = (section: AgentRowEntry["section"]): string => {
    if (section === "running") return workingIconFrame(tick())
    return "•"
  }

  const colorFor = (section: AgentRowEntry["section"], selected: boolean) => {
    if (selected) return theme.selectedListItemText
    if (section === "running") return theme.success
    if (section === "inactive") return theme.textMuted
    return theme.text
  }

  const glyphColorFor = (section: AgentRowEntry["section"], selected: boolean) => {
    if (selected) return theme.selectedListItemText
    if (section === "idle") return theme.warning
    return colorFor(section, selected)
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

  const lineColor = (row: AgentRowEntry, section: AgentRowEntry["section"], selected: boolean) => {
    if (Option.contains(armed(), row.sessionId)) return theme.error
    return colorFor(section, selected)
  }

  /**
   * `<marker><indent><glyph> task · activity` on the left, padded so the
   * right column (the side-thread mark, then the run time or age) sits on
   * the right edge.
   */
  const rowLine = (row: AgentRowEntry, selected: boolean): RowLine => {
    if (Option.contains(armed(), row.sessionId)) {
      return { left: deletePrompt(row), glyphAt: Option.none(), right: "" }
    }
    const right = rightColumn(row, DateTime.toEpochMillis(DateTime.nowUnsafe()), rowWidth())
    const width = Math.max(0, rowWidth() - textWidth(right) - 2)
    const lead = `${currentMarker(isCurrent(row))}${indentFor(row.depth)}`
    const label = rowLabel(
      `${lead}${glyphFor(glyphSection(row, selected, props.controller.detail()))} `,
      nameFor(row),
      activityFor(row, selected, props.controller.detail(), props.place),
      width,
    )
    const left = fitWidth(label, width)
    return {
      left: `${left}  `,
      glyphAt: Option.liftPredicate(lead.length, (at) => at < left.length),
      right,
    }
  }

  /** The row's left text in three runs: before the glyph, the glyph, after it. */
  const leftRuns = (line: RowLine) =>
    Option.match(line.glyphAt, {
      onNone: () => ({ before: line.left, glyph: "", after: "" }),
      onSome: (at) => ({
        before: line.left.slice(0, at),
        glyph: line.left.slice(at, at + 1),
        after: line.left.slice(at + 1),
      }),
    })

  const rightColor = (row: AgentRowEntry, selected: boolean) => {
    if (selected || Option.contains(armed(), row.sessionId))
      return lineColor(row, row.section, selected)
    return theme.textMuted
  }

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
          const line = () => rowLine(row, selected())
          return (
            <box id={id} backgroundColor={background()} paddingLeft={1}>
              {/* One row, one line: the time is right-aligned into the budget, so
                  an overflowing label is cut rather than wrapped under it, the
                  way the autocomplete popup and the thread rows clamp theirs. */}
              <text wrapMode="none" truncate style={{ fg: lineColor(row, section(), selected()) }}>
                {leftRuns(line()).before}
                <span style={{ fg: glyphColorFor(section(), selected()) }}>
                  {leftRuns(line()).glyph}
                </span>
                {leftRuns(line()).after}
                <span style={{ fg: rightColor(row, selected()) }}>{line().right}</span>
              </text>
            </box>
          )
        }),
    )

  /** Open on the loop the shell is already on. */
  const sticky = (values: ReadonlyArray<AgentRowEntry>): Option.Option<number> =>
    Option.some(Math.max(0, values.findIndex(isCurrent)))

  return (
    <Show when={props.open}>
      {/* A heading opens each section, so the pane draws more lines than it
          has rows; the frame adds the detail line under them. */}
      <PickerFrame
        title={`Sessions · ${countsLabel(visible())}`}
        keys={[
          KeyHints.move,
          KeyHints.select,
          KeyHints.delete,
          keyHint("ctrl+t", "hide"),
          KeyHints.close,
        ]}
        detail={Option.liftPredicate(
          detailLabel(props.controller.detail()),
          () => visible().length > 0,
        )}
        error={props.controller.error()}
      >
        <SelectList
          id="agents"
          open={props.open}
          rows={rows}
          rowKey={(row) => `${row.sessionId}/${row.branchId}`}
          filter={{ onQueryChange: props.controller.refresh }}
          sticky={sticky}
          // One detail read per selection, not per keystroke batch: the
          // controller ignores a repeat of the row it is already fetching.
          onCursor={props.controller.select}
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
