/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Option, Predicate, Schedule } from "effect"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import {
  type AgentRowEntry,
  AgentsViewRpc,
  DELEGATE_EXTENSION_ID,
  type ListAgentsInput,
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
  formatDuration,
  PickerFrame,
  selectable,
  SelectList,
  type SelectListApi,
  type SelectListRow,
  sessionQuery,
  textWidth,
  TrayFrame,
  truncate,
  usePickerGeometry,
  useScopedKeyboard,
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

/** Descendants of `root` at any depth, in the server's parent-before-child order. */
const subtreeRows = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: Option.Option<{ readonly sessionId: string }>,
): ReadonlyArray<AgentRowEntry> => {
  if (Option.isNone(root)) return []
  const known = new Set<string>([root.value.sessionId])
  const descendants: Array<AgentRowEntry> = []
  let pending = rows.filter((row) => row.sessionId !== root.value.sessionId)
  for (;;) {
    const next = pending.filter(
      (row) => Predicate.isNotUndefined(row.parentSessionId) && known.has(row.parentSessionId),
    )
    if (next.length === 0) return descendants
    for (const row of next) {
      descendants.push(row)
      known.add(row.sessionId)
    }
    pending = pending.filter((row) => !known.has(row.sessionId))
  }
}

const TRAY_HINT = "^t agents"
const TRAY_MAX_ROWS = 3

/** What a row is called: its session name, else its cwd, else its id. */
const nameFor = (row: AgentRowEntry): string =>
  Option.fromUndefinedOr(row.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(row.cwd)),
    Option.getOrElse(() => row.sessionId),
  )

/**
 * fx's subagent rows: `working · <name>`, one per running child and
 * nothing else, with what the child is doing now when the server reports it
 * (`· running bash`, or its last streamed line). Past the cap the rest
 * collapse into one count line.
 *
 * A child's name is often its whole task text. The activity keeps up to half
 * the row and the name is cut to what is left, so a long task never pushes
 * what the child is doing off the row.
 */
const trayText = (row: AgentRowEntry, width: number): string => {
  const head = "working · "
  return Option.fromUndefinedOr(row.activity).pipe(
    Option.map((activity) => {
      const doing = truncate(activity, Math.floor(width / 2))
      const nameWidth = width - textWidth(head) - textWidth(" · ") - textWidth(doing)
      return `${head}${truncate(nameFor(row), nameWidth)} · ${doing}`
    }),
    Option.getOrElse(() => `${head}${nameFor(row)}`),
    (text) => truncate(text, width),
  )
}

/**
 * Rows in the order their sessions were created. The listing orders by last
 * update, which a working child changes on every step, so a tray in listing
 * order reshuffles on each poll.
 */
const inStartOrder = (rows: ReadonlyArray<AgentRowEntry>): ReadonlyArray<AgentRowEntry> =>
  rows.toSorted((left, right) => {
    const byStart = (left.createdAt ?? 0) - (right.createdAt ?? 0)
    if (byStart !== 0) return byStart
    return `${left.sessionId}:${left.branchId}`.localeCompare(
      `${right.sessionId}:${right.branchId}`,
    )
  })

export const trayLines = (
  running: ReadonlyArray<AgentRowEntry>,
  width: number,
): ReadonlyArray<{ readonly pulse: boolean; readonly text: string }> => {
  const shown = inStartOrder(running).slice(0, TRAY_MAX_ROWS)
  const lines = shown.map((row) => ({
    pulse: true,
    text: trayText(row, width),
  }))
  const rest = running.length - shown.length
  if (rest > 0) lines.push({ pulse: false, text: `+${rest} more working` })
  return lines
}

export function SubagentTray(props: { controller: AgentsController }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()
  const running = () =>
    subtreeRows(props.controller.rows(), props.controller.current()).filter(
      (row) => row.section === "running",
    )
  // Switching sessions changes whose subtree the tray lists; refetch for it.
  createEffect(
    on(
      () => Option.getOrUndefined(Option.map(props.controller.current(), (row) => row.sessionId)),
      () => props.controller.refresh(""),
    ),
  )
  // Two columns of padding, the pulse and its space, and the hint on the first line.
  const rowWidth = () => Math.max(8, dimensions().width - 4 - textWidth(TRAY_HINT) - 2)
  const lines = () => trayLines(running(), rowWidth())
  const glyph = (pulse: boolean): string => {
    if (pulse) return workingIconFrame(tick())
    return " "
  }
  return (
    <Show when={running().length > 0}>
      <TrayFrame>
        <For each={lines()}>
          {(line, index) => (
            <text wrapMode="none">
              <span style={{ fg: theme.success }}>{`${glyph(line.pulse)} `}</span>
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
  readonly current: () => Option.Option<ActiveExtensionSession>
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
}

/** The agents pane's name in the host's one pane slot. */
const AGENTS_PANE = "agents.pane"

type RowKey = Pick<AgentRowEntry, "sessionId" | "branchId">

const sameKey = (left: RowKey, right: RowKey): boolean =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

/** What a listing row says about its loop's progress: `updatedAt` moves on every step. */
const progressStamp = (row: AgentRowEntry): string =>
  `${String(row.status)} ${String(row.updatedAt)}`

/** The slow clock a child's own turns are read on; they raise no event in this session. */
const POLL_EVERY = "2 seconds"

export const makeAgentsController = (
  fetchRows: (
    input: ListAgentsInput,
  ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
  fetchDetail: (key: RowKey) => Effect.Effect<ExtensionAgentDetail, { readonly message: string }>,
): Effect.Effect<AgentsController, never, ClientContext> =>
  Effect.gen(function* () {
    const { transport, shell, lifecycle } = yield* ClientContext
    const empty: ReadonlyArray<AgentRowEntry> = []
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

    // The pane refetches across session switches (on `current()` changing and on
    // the poll), so the session query owns the guard that drops a reply for the
    // session the shell already left.
    // The open pane lists the workspace under the reader's filter. The closed
    // pane leaves only the tray, which draws the current session's subtree,
    // so it reads that subtree alone: its cost follows the subtree, not the
    // number of stored sessions. With no current session it has nothing to draw.
    const read = (): Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }> => {
      if (open()) return fetchRows({ query })
      return Option.match(transport.currentSession(), {
        onNone: () => Effect.succeed(empty),
        onSome: (current) => fetchRows({ query, root: current.sessionId }),
      })
    }
    const listing = yield* sessionQuery({
      initial: empty,
      follow: false,
      fetch: () => read().pipe(Effect.tap((rows) => Effect.sync(() => detailAfterListing(rows)))),
    })
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

    // A delegate pulse in the current session means its subtree changed.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId === DELEGATE_EXTENSION_ID) tick()
      }),
    )
    // A child's own turns raise no event in this session, so while the pane is
    // open or a descendant has a live loop the listing is re-read on a slow
    // clock. Stored children alone never change on their own: a delegate pulse
    // announces a new or woken one, so the tray stops polling for them.
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sync(() => {
          const watching = subtreeRows(listing.value(), transport.currentSession()).some(
            (row) => row.live,
          )
          if (open() || watching) tick()
        }).pipe(Effect.repeat(Schedule.spaced(POLL_EVERY))),
      ),
    )

    return {
      rows: listing.value,
      current: transport.currentSession,
      error: listing.error,
      loading: listing.loading,
      refresh,
      reload: listing.refresh,
      detail,
      select,
      open,
    }
  })

/** Section headings, with the count each carries. Empty sections are skipped. */
const SECTION_TITLE = {
  running: "Running",
  idle: "Idle",
  inactive: "Inactive",
} satisfies Record<AgentRowEntry["section"], string>

/** The list as drawn: a heading opens each section, rows keep their index for selection. */
type PaneItem =
  | { readonly kind: "heading"; readonly section: AgentRowEntry["section"]; readonly count: number }
  | { readonly kind: "row"; readonly row: AgentRowEntry; readonly index: number }

const paneItems = (rows: ReadonlyArray<AgentRowEntry>): ReadonlyArray<PaneItem> => {
  const items: PaneItem[] = []
  rows.forEach((row, index) => {
    const previous = rows[index - 1]
    if (Option.isNone(Option.fromNullishOr(previous)) || previous?.section !== row.section) {
      const count = rows.filter((entry) => entry.section === row.section).length
      items.push({ kind: "heading", section: row.section, count })
    }
    items.push({ kind: "row", row, index })
  })
  return items
}

/** "1 running, 0 idle, 3 inactive" for the pane title: each loop counted by its section, its own state. */
const countsLabel = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const count = (state: AgentRowEntry["section"]) =>
    rows.filter((row) => row.section === state).length
  return `${count("running")} running, ${count("idle")} idle, ${count("inactive")} inactive`
}

/** Tree prefix from depth. The server already ordered parents before children. */
const indentFor = (depth: number): string => "  ".repeat(Math.max(0, depth))

/**
 * What a row's agent is doing now: the server's activity line (its running
 * tool, else its last streamed line). A row without one says only when it is
 * selected, with the status its detail read names.
 */
const activityFor = (
  row: AgentRowEntry,
  selected: boolean,
  detail: Option.Option<ExtensionAgentDetail>,
): string =>
  Option.fromUndefinedOr(row.activity).pipe(
    Option.orElse(() =>
      Option.map(
        Option.filter(detail, () => selected),
        (value) => value.status.toLowerCase(),
      ),
    ),
    Option.getOrElse(() => ""),
  )

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

/** Marks the loop the shell is on, so a reader can find themselves in the list. */
const currentMarker = (current: boolean): string => {
  if (current) return "› "
  return "  "
}

/** Sub-cent costs still deserve a number, so keep three decimals throughout. */
const formatCost = (usd: number): string => `$${usd.toFixed(3)}`

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
          shortModel(value.model),
          formatTurns(value.turns),
          formatCost(value.costUsd),
          formatDuration(value.durationMs, "padded"),
        ].join("  ·  ")
      }
      return [
        shortModel(value.model),
        `turn ${value.turns + 1} running`,
        formatCost(value.costUsd),
      ].join("  ·  ")
    },
  })

/** An empty list means one of two different things; say which. */
const emptyLabel = (loading: boolean): string => {
  if (loading) return "loading…"
  return "no agents"
}

export function AgentsPane(props: {
  open: boolean
  onClose: () => void
  controller: AgentsController
  onSelect: (row: AgentRowEntry) => void
  /** Show the pane if hidden, hide it if shown. Bound to Ctrl+T. */
  onToggle: () => void
  /** Delete a session tree. Bound to Ctrl+X pressed twice on the same row. */
  onDelete: (row: AgentRowEntry) => void
}) {
  const { theme } = useTheme()
  // The row a first Ctrl+X armed; the second press on it deletes, any other key disarms.
  const [armed, setArmed] = createSignal(Option.none<string>())

  const isCurrent = (row: AgentRowEntry): boolean =>
    Option.match(props.controller.current(), {
      onNone: () => false,
      onSome: (active) => active.sessionId === row.sessionId && active.branchId === row.branchId,
    })

  // Filtering is the server's job — it owns the same search the projection
  // tests cover — so typing refetches rather than filtering a local copy.
  const visible = () => props.controller.rows()
  // Esc clears a typed query before it closes the pane, as the palette does.
  const [query, setQuery] = createSignal("")
  let list = Option.none<SelectListApi>()

  // The toggle binds whether or not the pane is showing, so it can open as well
  // as close. Registered separately from the pane's own keys, which the list
  // gates on `open` and would otherwise swallow every keystroke while docked.
  useScopedKeyboard((event) => {
    if (event.ctrl !== true || event.name !== "t") return false
    props.onToggle()
    return true
  })

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
      return {
        left: "^x again to delete this session and its children",
        glyphAt: Option.none(),
        right: "",
      }
    }
    const right = [sideThreadMark(row), timeFor(row, DateTime.toEpochMillis(DateTime.nowUnsafe()))]
      .filter((part) => part.length > 0)
      .join("  ")
    const width = Math.max(0, rowWidth() - textWidth(right) - 2)
    const lead = `${currentMarker(isCurrent(row))}${indentFor(row.depth)}`
    const label = rowLabel(
      `${lead}${glyphFor(row.section)} `,
      nameFor(row),
      activityFor(row, selected, props.controller.detail()),
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
    paneItems(visible()).map((item) => {
      if (item.kind === "heading") {
        return decoration<AgentRowEntry>(() => (
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }}>
              {`${SECTION_TITLE[item.section]} (${item.count})`}
            </text>
          </box>
        ))
      }
      return selectable(item.row, (selected, id) => {
        const background = () => {
          if (selected()) return theme.primary
          return "transparent"
        }
        const section = () => item.row.section
        const line = () => rowLine(item.row, selected())
        return (
          <box id={id} backgroundColor={background()} paddingLeft={1}>
            {/* One row, one line: the time is right-aligned into the budget, so
                an overflowing label is cut rather than wrapped under it, the
                way the autocomplete popup and the thread rows clamp theirs. */}
            <text
              wrapMode="none"
              truncate
              style={{ fg: lineColor(item.row, section(), selected()) }}
            >
              {leftRuns(line()).before}
              <span style={{ fg: glyphColorFor(section(), selected()) }}>
                {leftRuns(line()).glyph}
              </span>
              {leftRuns(line()).after}
              <span style={{ fg: rightColor(item.row, selected()) }}>{line().right}</span>
            </text>
          </box>
        )
      })
    })

  /** Open on the loop the shell is already on. */
  const sticky = (values: ReadonlyArray<AgentRowEntry>): Option.Option<number> =>
    Option.some(Math.max(0, values.findIndex(isCurrent)))

  return (
    <Show when={props.open}>
      {/* A heading opens each section, so the pane draws more lines than it
          has rows; the frame adds the detail line under them. */}
      <PickerFrame
        title={`Agents · ${countsLabel(visible())}`}
        footer={"↑↓ move   ↵ → open   ← esc close   ^x delete   ^t hide"}
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
          filter={{
            onQueryChange: (next) => {
              setQuery(next)
              props.controller.refresh(next)
            },
          }}
          api={(api) => (list = Option.some(api))}
          sticky={sticky}
          // One detail read per selection, not per keystroke batch: the
          // controller ignores a repeat of the row it is already fetching.
          onCursor={props.controller.select}
          extraKeys={(event, selected) => {
            if (event.name === "escape" && Option.isSome(armed())) {
              setArmed(Option.none())
              return true
            }
            if (event.name === "escape" && query().length > 0) {
              Option.map(list, (api) => api.reset())
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
          empty={() => (
            <text style={{ fg: theme.textMuted }}>{emptyLabel(props.controller.loading())}</text>
          )}
          onSelect={props.onSelect}
          onDismiss={props.onClose}
        />
      </PickerFrame>
    </Show>
  )
}

export default defineClientExtension(AGENTS_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, shell } = yield* ClientContext

    const controller = yield* makeAgentsController(
      (input) =>
        transport.request(ref(AgentsViewRpc.ListAgents), input).pipe(
          Effect.map((reply) => reply.rows),
          Effect.mapError((error) => ({ message: String(error) })),
        ),
      (key) =>
        transport.agentDetail(key).pipe(Effect.mapError((error) => ({ message: String(error) }))),
    )

    return clientContributions(
      widgetContribution({
        id: "agents.tray",
        // Under the status line, not between the transcript and the composer:
        // the tray is chrome about background work, and the reply stays next
        // to the prompt it answers.
        slot: "below-input",
        component: () => <SubagentTray controller={controller} />,
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
        onSelect: () => {
          shell.pane.open(AGENTS_PANE)
          controller.refresh("")
        },
      }),
      widgetContribution({
        id: AGENTS_PANE,
        // Docked under the composer rather than covering the transcript: the
        // agent list is something you read *while* working, not instead of it.
        slot: "below-input",
        component: () => (
          <AgentsPane
            open={controller.open()}
            controller={controller}
            onClose={() => shell.pane.close(AGENTS_PANE)}
            onToggle={() => {
              if (controller.open()) {
                shell.pane.close(AGENTS_PANE)
                return
              }
              shell.pane.open(AGENTS_PANE)
              controller.refresh("")
            }}
            onDelete={(row) =>
              shell.cast(
                transport.deleteSession(row.sessionId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("agents.delete failed").pipe(
                      Effect.annotateLogs({ sessionId: row.sessionId, error: String(cause) }),
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
