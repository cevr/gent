/** @jsxImportSource @opentui/solid */
/**
 * Agents view — the client half.
 *
 * Renders the rows the `@gent/agents-view` server half projects: every agent
 * loop, live or stored, grouped by section and nested under its parent. The
 * server owns the projection, so this file only renders and navigates.
 *
 * Structure follows `session-tree.tsx`, which is the repo's template for a
 * centered filter-list overlay, and shares its reducer via `filter-list-state`.
 *
 * @module
 */

import { Effect, Option } from "effect"
import { createSignal, For, Show } from "solid-js"
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
import {
  clientCommandContribution,
  clientContributions,
  defineClientExtension,
  overlayContribution,
  type OverlayProps,
} from "../client-facets"
import { ClientShell } from "../client-services"
import { ClientTransport } from "../client-transport"

export const AGENTS_VIEW_EXTENSION_ID = "@gent/agents-view"
export const AGENTS_VIEW_OVERLAY_ID = "agents"

/**
 * Rows plus the load state, held in the setup closure.
 *
 * The overlay component remounts on every open, so anything that must survive
 * a close lives here instead. See `btw.client.tsx` for the same split.
 */
interface AgentsController {
  readonly rows: () => ReadonlyArray<AgentRowEntry>
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: (query: string) => void
}

const makeAgentsController = (
  fetchRows: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<AgentRowEntry>, { readonly message: string }>,
  cast: (effect: Effect.Effect<void>) => void,
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

  return { rows, error, loading, refresh }
}

/** Section headers, rendered inline so the list stays one flat navigable array. */
const SECTION_LABEL = {
  running: "running",
  idle: "idle",
  inactive: "inactive",
} satisfies Record<AgentRowEntry["section"], string>

/** Tree prefix from depth. The server already ordered parents before children. */
const indentFor = (depth: number): string => {
  if (depth <= 0) return ""
  return `${"  ".repeat(depth - 1)}└─ `
}

const labelFor = (row: AgentRowEntry): string => {
  const name = Option.fromUndefinedOr(row.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(row.cwd)),
    Option.getOrElse(() => row.sessionId),
  )
  const agent = Option.fromUndefinedOr(row.agent).pipe(Option.getOrElse(() => "—"))
  return `${indentFor(row.depth)}${name}  ·  ${agent}`
}

/** An empty list means one of two different things; say which. */
const emptyLabel = (loading: boolean): string => {
  if (loading) return "loading…"
  return "no agents"
}

export function AgentsPane(props: OverlayProps & { controller: AgentsController }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(FilterListState.initial())
  let scrollRef: Option.Option<ScrollBoxRenderable> = Option.none()

  // Filtering is the server's job — it owns the same search the projection
  // tests cover — so typing refetches rather than filtering a local copy.
  const visible = () => props.controller.rows()

  useScrollSync(() => `agents-row-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  useScopedKeyboard(
    (event) => {
      if (event.name === "escape") {
        props.onClose()
        return true
      }

      if (event.name === "backspace") {
        const next = transitionFilterList(state(), FilterListEvent.cases.Backspace.make({}))
        setState(next)
        props.controller.refresh(next.query)
        return true
      }

      const rows = visible()
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

  const panelWidth = () => Math.min(90, dimensions().width - 6)
  const panelHeight = () => Math.min(20, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const colorFor = (row: AgentRowEntry, selected: boolean) => {
    if (selected) return theme.selectedListItemText
    if (row.section === "running") return theme.success
    if (row.section === "inactive") return theme.textMuted
    return theme.text
  }

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title="Agents"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
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
            <For each={visible()}>
              {(row, index) => {
                const selected = () => state().selectedIndex === index()
                const background = () => {
                  if (selected()) return theme.primary
                  return "transparent"
                }
                return (
                  <box id={`agents-row-${index()}`} backgroundColor={background()} paddingLeft={1}>
                    <text style={{ fg: colorFor(row, selected()) }}>
                      {truncate(
                        `${SECTION_LABEL[row.section].padEnd(9)}${labelFor(row)}`,
                        panelWidth() - 4,
                      )}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </ChromePanel.Body>

        <ChromePanel.Error error={Option.getOrUndefined(props.controller.error())} />
        <ChromePanel.Footer>Type | Up/Down | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}

export default defineClientExtension(AGENTS_VIEW_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell

    const controller = makeAgentsController(
      (query) =>
        transport.request(ref(AgentsViewRpc.ListAgents), { query }).pipe(
          Effect.map((reply) => reply.rows),
          Effect.mapError((error) => ({ message: String(error) })),
        ),
      shell.cast,
    )

    return clientContributions(
      clientCommandContribution({
        id: "agents.view",
        title: "Agents",
        description: "Show every agent loop, live and stored",
        category: "Session",
        slash: "agents",
        onSelect: () => {
          shell.openOverlay(AGENTS_VIEW_OVERLAY_ID)
          controller.refresh("")
        },
      }),
      overlayContribution({
        id: AGENTS_VIEW_OVERLAY_ID,
        component: (props) => <AgentsPane {...props} controller={controller} />,
      }),
    )
  }),
})
