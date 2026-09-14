/** @jsxImportSource @opentui/solid */
/**
 * Agents view — the client half.
 *
 * Renders the rows the `@gent/agents-view` server half projects: every agent
 * loop, live or stored, grouped by section and nested under its parent. The
 * server owns the projection, so this file only renders and navigates.
 *
 * Replaces the former `session-tree.tsx` overlay: this shows every loop rather
 * than one session's descendants, adds liveness, and is keyed per branch. The
 * shared reducer lives in `filter-list-state`.
 *
 * @module
 */

import { DateTime, Effect, Option, Predicate, Schedule } from "effect"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { AgentsViewRpc, type AgentRowEntry } from "@gent/extensions/client"
import { ref } from "@gent/core/extensions/api"
import { ChromePanel } from "../../components/chrome-panel"
import {
  FilterListEvent,
  FilterListState,
  transitionFilterList,
} from "../../components/filter-list-state"
import { useScopedKeyboard } from "../../keyboard/context"
import { useScrollSync } from "../../hooks/use-scroll-sync"
import { useTerminalDimensions } from "../../terminal-dimensions"
import { useTheme } from "../../theme"
import { truncate } from "../../utils/format-tool"
import { formatAge, workingIconFrame } from "../../components/message-list-utils"
import { useSpinnerClock } from "../../hooks/use-spinner-clock"
import {
  clientCommandContribution,
  clientContributions,
  defineClientExtension,
  widgetContribution,
  type OverlayProps,
} from "../client-facets"
import { ClientLifecycle, ClientShell } from "../client-services"
import { ClientTransport, type ExtensionAgentDetail } from "../client-transport"

export const AGENTS_VIEW_EXTENSION_ID = "@gent/agents-view"

/**
 * Rows plus the load state, held in the setup closure.
 *
 * The overlay component remounts on every open, so anything that must survive
 * a close lives here instead. See `btw.client.tsx` for the same split.
 */
interface AgentsController {
  readonly rows: () => ReadonlyArray<AgentRowEntry>
  /** The loop the shell is currently on, so the pane can mark and preselect it. */
  readonly current: () => Option.Option<{ sessionId: string; branchId: string }>
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: (query: string) => void
  /**
   * Detail for the row the reader is on, or `None` while it loads. Listings
   * stay cheap by carrying identity and liveness only; this is the second
   * read, made for one row at a time.
   */
  readonly detail: () => Option.Option<ExtensionAgentDetail>
  /** Tell the controller which row is selected, so it can fetch that detail. */
  readonly select: (row: Option.Option<AgentRowEntry>) => void
  /**
   * Whether the pane is showing. A docked widget is always mounted, unlike the
   * overlay this replaced, so visibility is controller state rather than
   * something the overlay registry decides.
   */
  readonly open: () => boolean
  readonly setOpen: (open: boolean) => void
}

export const makeAgentsController = (
  fetchRows: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
  fetchDetail: (
    key: Pick<AgentRowEntry, "sessionId" | "branchId">,
  ) => Effect.Effect<ExtensionAgentDetail, { readonly message: string }>,
  cast: (effect: Effect.Effect<void>) => void,
  current: () => Option.Option<{ sessionId: string; branchId: string }>,
): AgentsController => {
  const [rows, setRows] = createSignal<ReadonlyArray<AgentRowEntry>>([])
  const [error, setError] = createSignal<Option.Option<string>>(Option.none())
  const [loading, setLoading] = createSignal(false)

  const refresh = (query: string) => {
    setLoading(true)
    cast(
      fetchRows(query).pipe(
        Effect.match({
          onFailure: (failure) => {
            setError(Option.some(failure.message))
            setLoading(false)
          },
          onSuccess: (next) => {
            setRows(next)
            setError(Option.none())
            setLoading(false)
          },
        }),
      ),
    )
  }

  const [detail, setDetail] = createSignal<Option.Option<ExtensionAgentDetail>>(Option.none())
  // Arrow keys move faster than a round trip, so replies can land out of order.
  // Only the reply for the row still selected is allowed to win; anything else
  // would show one row's cost next to another row's name.
  const [pending, setPending] = createSignal(Option.none<string>())

  const select = (row: Option.Option<AgentRowEntry>) => {
    // A detail read goes through the loop actor, and an actor read spawns the
    // entity: asking a stored session what it is doing would make it live.
    // Only rows that already have a loop are asked.
    if (Option.isNone(row) || !row.value.live) {
      setPending(Option.none())
      setDetail(Option.none())
      return
    }
    const key = { sessionId: row.value.sessionId, branchId: row.value.branchId }
    const token = `${key.sessionId.length}:${key.sessionId}:${key.branchId}`
    if (Option.contains(pending(), token)) return
    setPending(Option.some(token))
    setDetail(Option.none())
    cast(
      fetchDetail(key).pipe(
        Effect.match({
          // A detail read that fails leaves the line blank rather than
          // replacing the list with an error: the rows are still correct.
          onFailure: () => {},
          onSuccess: (next) => {
            if (!Option.contains(pending(), token)) return
            setDetail(Option.some(next))
          },
        }),
      ),
    )
  }

  const [open, setOpen] = createSignal(false)

  return { rows, current, error, loading, refresh, detail, select, open, setOpen }
}

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

export const paneItems = (rows: ReadonlyArray<AgentRowEntry>): ReadonlyArray<PaneItem> => {
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

/** "1 running, 0 idle, 3 inactive" for the pane title. */
export const countsLabel = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const count = (section: AgentRowEntry["section"]) =>
    rows.filter((row) => row.section === section).length
  return `${count("running")} running, ${count("idle")} idle, ${count("inactive")} inactive`
}

// ── Subagent tray ──
// One line above the composer: how many loops hang off the current session.

export interface SubtreeCounts {
  readonly total: number
  readonly running: number
  readonly idle: number
  readonly inactive: number
}

/** Section counts over every row descending from `root`, at any depth; the root itself is not counted. */
export const subtreeCounts = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: Option.Option<{ readonly sessionId: string }>,
): SubtreeCounts => {
  const counts = { total: 0, running: 0, idle: 0, inactive: 0 }
  if (Option.isNone(root)) return counts
  const known = new Set<string>([root.value.sessionId])
  let pending = rows.filter((row) => row.sessionId !== root.value.sessionId)
  for (;;) {
    const next = pending.filter(
      (row) => Predicate.isNotUndefined(row.parentSessionId) && known.has(row.parentSessionId),
    )
    if (next.length === 0) return counts
    for (const row of next) {
      counts.total += 1
      counts[row.section] += 1
      known.add(row.sessionId)
    }
    pending = pending.filter((row) => !known.has(row.sessionId))
  }
}

/** prime-agent's tray line: `● 1 running   ◐ 2 idle   ○ 3 inactive`. */
export const traySegments = (
  counts: SubtreeCounts,
): ReadonlyArray<{
  readonly section: AgentRowEntry["section"]
  readonly text: string
}> => [
  { section: "running", text: `● ${counts.running} running` },
  { section: "idle", text: `◐ ${counts.idle} idle` },
  { section: "inactive", text: `○ ${counts.inactive} inactive` },
]

const TRAY_HINT = "^t agents"

export function SubagentTray(props: { controller: AgentsController }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const counts = () => subtreeCounts(props.controller.rows(), props.controller.current())
  // Switching sessions changes whose subtree the tray counts; refetch for it.
  createEffect(
    on(
      () => Option.getOrUndefined(Option.map(props.controller.current(), (row) => row.sessionId)),
      () => props.controller.refresh(""),
    ),
  )
  const sectionColor = (section: AgentRowEntry["section"]) => {
    if (section === "running") return theme.success
    if (section === "idle") return theme.warning
    return theme.textMuted
  }
  const segments = () => traySegments(counts())
  const gap = () => {
    const used = segments().reduce((sum, segment) => sum + segment.text.length + 3, 0)
    // Margins, border, and padding take six columns; the text box is the rest.
    return " ".repeat(Math.max(1, dimensions().width - 6 - used - TRAY_HINT.length))
  }
  return (
    <Show when={!props.controller.open() && counts().total > 0}>
      <box
        alignSelf="stretch"
        marginLeft={1}
        marginRight={1}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        title="subagents"
        titleAlignment="left"
        paddingLeft={1}
        height={3}
      >
        <text wrapMode="none" style={{ fg: theme.textMuted }}>
          <For each={segments()}>
            {(segment) => (
              <span style={{ fg: sectionColor(segment.section) }}>{`${segment.text}   `}</span>
            )}
          </For>
          {gap()}
          {TRAY_HINT}
        </text>
      </box>
    </Show>
  )
}

/** Tree prefix from depth. The server already ordered parents before children. */
const indentFor = (depth: number): string => "  ".repeat(Math.max(0, depth))

const labelFor = (row: AgentRowEntry): string => {
  const name = Option.fromUndefinedOr(row.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(row.cwd)),
    Option.getOrElse(() => row.sessionId),
  )
  const agent = Option.fromUndefinedOr(row.agent).pipe(Option.getOrElse(() => "—"))
  return `${name}  ·  ${agent}`
}

/** What the selected row is doing, from its detail read; other rows carry nothing. */
const activityFor = (detail: Option.Option<ExtensionAgentDetail>): string =>
  Option.match(
    Option.flatMap(detail, (value) => value.status),
    {
      onNone: () => "",
      onSome: (status) => status.toLowerCase(),
    },
  )

/** Right-aligned age from the row's last update; blank when the row never ran. */
const ageFor = (row: AgentRowEntry, now: number): string =>
  Option.match(Option.fromUndefinedOr(row.updatedAt), {
    onNone: () => "",
    onSome: (updatedAt) => formatAge(now - updatedAt),
  })

/** Marks the loop the shell is on, so a reader can find themselves in the list. */
const currentMarker = (current: boolean): string => {
  if (current) return "› "
  return "  "
}

/** Whole seconds under a minute, then `m:ss` — a detail line has no room for more. */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`
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
 * Status is deliberately absent: every row already carries it in the section
 * column, and this line is the widest content in the panel — repeating it here
 * costs the columns that cost and duration need.
 */
const detailLabel = (detail: Option.Option<ExtensionAgentDetail>): string =>
  Option.match(detail, {
    onNone: () => "",
    onSome: (value) => {
      const parts = [
        ...Option.match(value.model, {
          onNone: () => [],
          onSome: (model) => [shortModel(model)],
        }),
        formatTurns(value.turns),
        formatCost(value.costUsd),
        formatDuration(value.durationMs),
      ]
      return parts.join("  ·  ")
    },
  })

/** An empty list means one of two different things; say which. */
const emptyLabel = (loading: boolean): string => {
  if (loading) return "loading…"
  return "no agents"
}

export function AgentsPane(
  props: OverlayProps & {
    controller: AgentsController
    onSelect: (row: AgentRowEntry) => void
    /** Show the pane if hidden, hide it if shown. Bound to Ctrl+T. */
    onToggle: () => void
    /** Delete a session tree. Bound to Ctrl+X pressed twice on the same row. */
    onDelete: (row: AgentRowEntry) => void
  },
) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(FilterListState.initial())
  // The row a first Ctrl+X armed; the second press on it deletes, any other key disarms.
  const [armed, setArmed] = createSignal(Option.none<string>())
  let scrollRef: Option.Option<ScrollBoxRenderable> = Option.none()

  const isCurrent = (row: AgentRowEntry): boolean =>
    Option.match(props.controller.current(), {
      onNone: () => false,
      onSome: (active) => active.sessionId === row.sessionId && active.branchId === row.branchId,
    })

  // Open on the loop the shell is already on, the way the session tree did.
  // Re-runs when rows arrive, since the fetch resolves after the pane mounts.
  createEffect(
    on([() => props.open, () => props.controller.rows()], ([open, rows]) => {
      if (!open) return
      const index = rows.findIndex(isCurrent)
      setState(FilterListState.initial(Math.max(0, index)))
    }),
  )

  // Filtering is the server's job — it owns the same search the projection
  // tests cover — so typing refetches rather than filtering a local copy.
  const visible = () => props.controller.rows()

  // One detail read per selection, not per keystroke batch: the controller
  // ignores a repeat of the row it is already fetching.
  createEffect(
    on([() => props.open, visible, () => state().selectedIndex], ([open, rows, index]) => {
      if (!open) {
        props.controller.select(Option.none())
        return
      }
      props.controller.select(Option.fromNullishOr(rows[index]))
    }),
  )

  useScrollSync(() => `agents-row-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  // The toggle binds whether or not the pane is showing, so it can open as well
  // as close. Registered separately from the pane's own keys, which are gated on
  // `open` and would otherwise swallow every keystroke while docked.
  useScopedKeyboard((event) => {
    if (event.ctrl !== true || event.name !== "t") return false
    props.onToggle()
    return true
  })

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        if (Option.isSome(armed())) {
          setArmed(Option.none())
          return true
        }
        props.onClose()
        return true
      }

      if (event.ctrl === true && event.name === "x") return armOrDelete()
      setArmed(Option.none())

      if (event.name === "backspace") {
        const next = transitionFilterList(state(), FilterListEvent.cases.Backspace.make({}))
        setState(next)
        props.controller.refresh(next.query)
        return true
      }

      const rows = visible()
      if (event.name === "return") {
        const selected = Option.fromNullishOr(rows[state().selectedIndex])
        if (Option.isNone(selected)) return true
        props.onSelect(selected.value)
        return true
      }

      if (event.name === "up" || (event.ctrl === true && event.name === "p")) {
        setState((current) =>
          transitionFilterList(
            current,
            FilterListEvent.cases.MoveUp.make({ itemCount: rows.length }),
          ),
        )
        return true
      }

      if (event.name === "down" || (event.ctrl === true && event.name === "n")) {
        setState((current) =>
          transitionFilterList(
            current,
            FilterListEvent.cases.MoveDown.make({ itemCount: rows.length }),
          ),
        )
        return true
      }

      const sequence = Option.fromNullishOr(event.sequence)
      if (Option.isSome(sequence) && sequence.value.length === 1) {
        const char = sequence.value
        if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          const next = transitionFilterList(state(), FilterListEvent.cases.TypeChar.make({ char }))
          setState(next)
          props.controller.refresh(next.query)
          return true
        }
      }
      return false
    },
    { when: () => props.open },
  )

  // Docked under the composer rather than floating. The pane fills the width of
  // the container it is docked in, so it never sets one; the truncation budget
  // still needs a number, and the terminal width minus the surrounding margin
  // is what that container actually gets.
  const panelWidth = () => Math.max(0, dimensions().width - 2)
  /**
   * Columns a row may actually use: the pane border takes 2, `ChromePanel.Body`
   * pads 1 each side, and the row itself pads 1 more on the left. Budgeting less
   * than that wraps the line and breaks the one-row-per-agent alignment.
   */
  const rowWidth = () => Math.max(0, panelWidth() - 5)
  /**
   * A `ChromePanel.Section` pads 1 each side inside the 2 border columns, and
   * unlike a row it carries no extra left pad — so it gets one more column
   * than {@link rowWidth}. Reusing the row budget here truncates a column early.
   */
  const sectionWidth = () => Math.max(0, panelWidth() - 4)
  /**
   * Rows of list body, on top of the pane's own chrome (border, query, detail,
   * footer). Fixed rather than a fraction of the terminal: the pane shares the
   * screen with the transcript, and a fraction of a short terminal collapses
   * the list to a line or two. The body scrolls within this, which is what
   * gives the pane its own scroll buffer.
   */
  const BODY_ROWS = 10
  const CHROME_ROWS = 6
  const paneHeight = () => Math.max(6, Math.min(BODY_ROWS + CHROME_ROWS, dimensions().height - 4))

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

  const items = () => paneItems(visible())

  // First Ctrl+X arms the selected row; the second deletes it. The shell's own
  // loop is never a target: the pane would be deleting the session it lives on.
  const armOrDelete = (): boolean => {
    const selected = Option.fromNullishOr(visible()[state().selectedIndex])
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

  /** `<marker><indent><glyph> name · agent  ·  activity` padded so the age sits on the right edge. */
  const rowLine = (row: AgentRowEntry, selected: boolean): string => {
    if (Option.contains(armed(), row.sessionId)) {
      return "^x again to delete this session and its children"
    }
    const age = ageFor(row, DateTime.toEpochMillis(DateTime.nowUnsafe()))
    let activity = ""
    if (selected) activity = activityFor(props.controller.detail())
    let left = `${currentMarker(isCurrent(row))}${indentFor(row.depth)}${glyphFor(row.section)} ${labelFor(row)}`
    if (activity.length > 0) left = `${left}  ·  ${activity}`
    const width = Math.max(0, rowWidth() - age.length - 2)
    return `${truncate(left, width).padEnd(width)}  ${age}`
  }

  return (
    <Show when={props.open}>
      <box
        height={paneHeight()}
        // Stretch to the docked container's width instead of shrinking to the
        // longest row: this is a pane, and a pane that hugs its content reads
        // as a floating box again.
        alignSelf="stretch"
        marginLeft={1}
        marginRight={1}
        backgroundColor={theme.backgroundMenu}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={`Agents · ${countsLabel(visible())}`}
      >
        <ChromePanel.Section>
          <text style={{ fg: theme.text }}>
            <span style={{ fg: theme.textMuted }}>› </span>
            {state().query}
            <span style={{ fg: theme.primary }}>│</span>
          </text>
        </ChromePanel.Section>

        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
          <Show
            when={visible().length > 0}
            fallback={
              <text style={{ fg: theme.textMuted }}>{emptyLabel(props.controller.loading())}</text>
            }
          >
            <For each={items()}>
              {(item) => {
                if (item.kind === "heading") {
                  return (
                    <box paddingLeft={1}>
                      <text style={{ fg: theme.textMuted }}>
                        {`${SECTION_TITLE[item.section]} (${item.count})`}
                      </text>
                    </box>
                  )
                }
                const selected = () => state().selectedIndex === item.index
                const background = () => {
                  if (selected()) return theme.primary
                  return "transparent"
                }
                const section = () => item.row.section
                return (
                  <box
                    id={`agents-row-${item.index}`}
                    backgroundColor={background()}
                    paddingLeft={1}
                  >
                    <text style={{ fg: lineColor(item.row, section(), selected()) }}>
                      <span style={{ fg: glyphColorFor(section(), selected()) }}>
                        {rowLine(item.row, selected()).slice(0, 1)}
                      </span>
                      {rowLine(item.row, selected()).slice(1)}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </ChromePanel.Body>

        <Show when={visible().length > 0}>
          <ChromePanel.Section>
            <text style={{ fg: theme.textMuted }}>
              {truncate(detailLabel(props.controller.detail()), sectionWidth())}
            </text>
          </ChromePanel.Section>
        </Show>

        <ChromePanel.Error error={Option.getOrUndefined(props.controller.error())} />
        <ChromePanel.Footer>
          {"↑↓ move   ↵ open   ^x delete   esc close   ^t hide"}
        </ChromePanel.Footer>
      </box>
    </Show>
  )
}

export default defineClientExtension(AGENTS_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const controller = makeAgentsController(
      (query) =>
        transport.request(ref(AgentsViewRpc.ListAgents), { query }).pipe(
          Effect.map((reply) => reply.rows),
          Effect.mapError((error) => ({ message: String(error) })),
        ),
      (key) =>
        transport.agentDetail(key).pipe(Effect.mapError((error) => ({ message: String(error) }))),
      shell.cast,
      () =>
        Option.map(Option.fromNullishOr(transport.currentSession()), (active) => ({
          sessionId: active.sessionId,
          branchId: active.branchId,
        })),
    )

    // A delegate receipt in the current session means its subtree changed.
    // The pane owns its own query while open, so only a closed pane refetches.
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        const tag = envelope.event._tag
        if (tag !== "AgentRunSpawned" && tag !== "AgentRunSucceeded" && tag !== "AgentRunFailed")
          return
        if (!controller.open()) controller.refresh("")
      }),
    )
    // A child's own turns raise no event in this session, so while the tray
    // shows children the listing is re-read on a slow clock. The read is a
    // registry lookup per loop, cheap enough to poll.
    yield* lifecycle.scoped(
      Effect.forkScoped(
        Effect.sync(() => {
          if (controller.open()) return
          if (subtreeCounts(controller.rows(), controller.current()).total === 0) return
          controller.refresh("")
        }).pipe(Effect.repeat(Schedule.spaced("2 seconds"))),
      ),
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
        title: "Agents",
        description: "Show every agent loop, live and stored",
        category: "Session",
        slash: "agents",
        // `/tree` was the session-tree overlay, which this view replaces: it
        // shows every loop rather than one session's descendants, adds liveness,
        // and is keyed per branch. Kept as an alias so the habit still works.
        aliases: ["tree"],
        onSelect: () => {
          controller.setOpen(true)
          controller.refresh("")
        },
      }),
      widgetContribution({
        id: "agents.pane",
        // Docked under the composer rather than covering the transcript: the
        // agent list is something you read *while* working, not instead of it.
        slot: "below-input",
        component: () => (
          <AgentsPane
            open={controller.open()}
            controller={controller}
            onClose={() => controller.setOpen(false)}
            onToggle={() => {
              const next = !controller.open()
              controller.setOpen(next)
              if (next) controller.refresh("")
            }}
            onDelete={(row) =>
              shell.cast(
                transport.deleteSession(row.sessionId).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("agents.delete failed").pipe(
                      Effect.annotateLogs({ sessionId: row.sessionId, error: String(cause) }),
                    ),
                  ),
                  Effect.andThen(Effect.sync(() => controller.refresh(""))),
                ),
              )
            }
            onSelect={(row) => {
              controller.setOpen(false)
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
