/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Option, Predicate, Schedule } from "effect"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { type AgentRowEntry, AgentsViewRpc, DelegateRpc } from "@gent/extensions/client"
import { useScopedKeyboard, useTerminalDimensions } from "../terminal"
import { useTheme } from "../theme"
import { formatAge, formatDuration, truncate, workingIconFrame } from "../utils"
import {
  ChromePanel,
  decoration,
  PickerFrame,
  pickerHeight,
  pickerLines,
  selectable,
  SelectList,
  type SelectListRow,
  usePickerGeometry,
  useSpinnerClock,
} from "../ui"
import { ref } from "@gent/core/extensions/api"
import {
  clientCommandContribution,
  clientContributions,
  ClientLifecycle,
  ClientShell,
  ClientTransport,
  defineClientExtension,
  type ActiveExtensionSession,
  type ExtensionAgentDetail,
  sessionQuery,
  widgetContribution,
} from "./client-facets"

// ── builtins/agents-tray.client ─────────────────────────────────────────────

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

interface SubtreeCounts {
  readonly total: number
  readonly running: number
  readonly idle: number
  readonly inactive: number
}

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

/** Section counts over every row descending from `root`; the root itself is not counted. */
export const subtreeCounts = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: Option.Option<{ readonly sessionId: string }>,
): SubtreeCounts => {
  const counts = { total: 0, running: 0, idle: 0, inactive: 0 }
  for (const row of subtreeRows(rows, root)) {
    counts.total += 1
    counts[row.section] += 1
  }
  return counts
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
 * nothing else. Past the cap the rest collapse into one count line.
 */
export const trayLines = (
  running: ReadonlyArray<AgentRowEntry>,
  width: number,
): ReadonlyArray<{ readonly pulse: boolean; readonly text: string }> => {
  const shown = running.slice(0, TRAY_MAX_ROWS)
  const lines = shown.map((row) => ({
    pulse: true,
    text: truncate(`working · ${nameFor(row)}`, width),
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
  const textWidth = () => Math.max(8, dimensions().width - 4 - TRAY_HINT.length - 2)
  const lines = () => trayLines(running(), textWidth())
  const glyph = (pulse: boolean): string => {
    if (pulse) return workingIconFrame(tick())
    return " "
  }
  return (
    <Show when={!props.controller.open() && running().length > 0}>
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <For each={lines()}>
          {(line, index) => (
            <text wrapMode="none">
              <span style={{ fg: theme.success }}>{`${glyph(line.pulse)} `}</span>
              <span style={{ fg: theme.textMuted }}>{line.text}</span>
              <Show when={index() === 0}>
                <span style={{ fg: theme.textMuted }}>
                  {`${" ".repeat(Math.max(1, textWidth() - line.text.length + 2))}${TRAY_HINT}`}
                </span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

// ── builtins/agents-view.client ─────────────────────────────────────────────

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
 * either component.
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
  /**
   * Whether the pane is showing. A docked widget is always mounted, so
   * visibility is controller state.
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
): Effect.Effect<AgentsController, never, ClientTransport | ClientShell | ClientLifecycle> =>
  Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    // The pane refetches across session switches (on `current()` changing and on
    // a 2 s poll), so the session query owns the guard that drops a reply for the
    // session the shell already left.
    const empty: ReadonlyArray<AgentRowEntry> = []
    // The filter the reader typed; a reload re-reads under it.
    let query = ""
    const listing = yield* sessionQuery({
      initial: empty,
      follow: false,
      fetch: () => fetchRows(query),
    })
    const refresh = (next: string): void => {
      query = next
      listing.refresh()
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
      shell.cast(
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
      setOpen,
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

/** "1 running, 0 idle, 3 inactive" for the pane title. */
const countsLabel = (rows: ReadonlyArray<AgentRowEntry>): string => {
  const count = (section: AgentRowEntry["section"]) =>
    rows.filter((row) => row.section === section).length
  return `${count("running")} running, ${count("idle")} idle, ${count("inactive")} inactive`
}

/** Tree prefix from depth. The server already ordered parents before children. */
const indentFor = (depth: number): string => "  ".repeat(Math.max(0, depth))

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
        formatDuration(value.durationMs, "padded"),
      ]
      return parts.join("  ·  ")
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
  const { rowWidth, sectionWidth } = usePickerGeometry()
  const dimensions = useTerminalDimensions()

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

  /** `<marker><indent><glyph> name  ·  activity` padded so the age sits on the right edge. */
  const rowLine = (row: AgentRowEntry, selected: boolean): string => {
    if (Option.contains(armed(), row.sessionId)) {
      return "^x again to delete this session and its children"
    }
    const age = ageFor(row, DateTime.toEpochMillis(DateTime.nowUnsafe()))
    let activity = ""
    if (selected) activity = activityFor(props.controller.detail())
    let left = `${currentMarker(isCurrent(row))}${indentFor(row.depth)}${glyphFor(row.section)} ${nameFor(row)}`
    if (activity.length > 0) left = `${left}  ·  ${activity}`
    const width = Math.max(0, rowWidth() - age.length - 2)
    return `${truncate(left, width).padEnd(width)}  ${age}`
  }

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
        return (
          <box id={id} backgroundColor={background()} paddingLeft={1}>
            {/* One row, one line: the age is right-aligned into the budget, so
                an overflowing label is cut rather than wrapped under it, the
                way the autocomplete popup and the thread rows clamp theirs. */}
            <text
              wrapMode="none"
              truncate
              style={{ fg: lineColor(item.row, section(), selected()) }}
            >
              <span style={{ fg: glyphColorFor(section(), selected()) }}>
                {rowLine(item.row, selected()).slice(0, 1)}
              </span>
              {rowLine(item.row, selected()).slice(1)}
            </text>
          </box>
        )
      })
    })

  /** Open on the loop the shell is already on, the way the session tree did. */
  const sticky = (values: ReadonlyArray<AgentRowEntry>): Option.Option<number> =>
    Option.some(Math.max(0, values.findIndex(isCurrent)))

  // A heading opens each section and a detail line sits under the list, so the
  // pane draws more lines than it has rows.
  const paneHeight = () =>
    pickerHeight(pickerLines(paneItems(visible()).length, 1), dimensions().height)

  return (
    <Show when={props.open}>
      <PickerFrame
        height={paneHeight()}
        title={`Agents · ${countsLabel(visible())}`}
        footer={"↑↓ move   ↵ open   ^x delete   esc close   ^t hide"}
      >
        <SelectList
          id="agents"
          open={props.open}
          rows={rows}
          filter={{ onQueryChange: (query) => props.controller.refresh(query) }}
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
            return false
          }}
          empty={() => (
            <text style={{ fg: theme.textMuted }}>{emptyLabel(props.controller.loading())}</text>
          )}
          onSelect={props.onSelect}
          onDismiss={props.onClose}
        />

        <Show when={visible().length > 0}>
          <ChromePanel.Section>
            <text style={{ fg: theme.textMuted }}>
              {truncate(detailLabel(props.controller.detail()), sectionWidth())}
            </text>
          </ChromePanel.Section>
        </Show>

        <ChromePanel.Error error={Option.getOrUndefined(props.controller.error())} />
      </PickerFrame>
    </Show>
  )
}

export default defineClientExtension(AGENTS_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle

    const controller = yield* makeAgentsController(
      (query) =>
        transport.request(ref(AgentsViewRpc.ListAgents), { query }).pipe(
          Effect.map((reply) => reply.rows),
          Effect.mapError((error) => ({ message: String(error) })),
        ),
      (key) =>
        transport.agentDetail(key).pipe(Effect.mapError((error) => ({ message: String(error) }))),
    )

    // A delegate pulse in the current session means its subtree changed.
    // The pane owns its own query while open, so only a closed pane refetches.
    const delegateExtensionId = ref(DelegateRpc.Children).extensionId
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId !== delegateExtensionId) return
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
                  // The pane is open and may be filtered, so the listing is
                  // re-read under the query the reader typed, not under "".
                  Effect.andThen(Effect.sync(() => controller.reload())),
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
