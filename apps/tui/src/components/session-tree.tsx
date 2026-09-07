import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { matchSorter } from "match-sorter"
import type { SessionId } from "@gent/core-internal/domain/ids.js"
import type { SessionTreeNode } from "../client"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncate } from "../utils/format-tool"
import { useScopedKeyboard } from "../keyboard/context"
import { SessionTreeEvent, SessionTreeState, transitionSessionTree } from "./session-tree-state"
import { Option } from "effect"

interface FlatNode {
  id: SessionId
  line: string
  isCurrent: boolean
}

const labelMatches = (label: string, query: string): boolean =>
  matchSorter([label], query).length > 0

const labelFor = (node: SessionTreeNode): string => {
  const name = Option.getOrElse(Option.fromNullishOr(node.session.name), () =>
    node.session.id.slice(0, 8),
  )
  const cwd = Option.fromNullishOr(node.session.cwd).pipe(
    Option.map((value) => value.split("/").filter(Boolean).pop()),
  )
  if (Option.isSome(cwd)) return `${name} · ${cwd.value}`
  return name
}

const buildTreeLines = (
  node: SessionTreeNode,
  currentSessionId: SessionId,
  query: string,
  guides: ReadonlyArray<boolean> = [],
  isLast = true,
): FlatNode[] => {
  const label = labelFor(node)
  const childMatches = node.children.flatMap((child, index) =>
    buildTreeLines(
      child,
      currentSessionId,
      query,
      [...guides, !isLast],
      index === node.children.length - 1,
    ),
  )
  const visible =
    query.length === 0 ||
    labelMatches(label, query) ||
    node.session.id === currentSessionId ||
    childMatches.length > 0

  if (!visible) return []

  let prefix = ""
  if (guides.length > 0) {
    prefix = guides
      .slice(0, -1)
      .map((show) => {
        if (show) return "│  "
        return "   "
      })
      .join("")
    if (isLast) prefix += "└─ "
    else prefix += "├─ "
  }
  const current = node.session.id === currentSessionId
  let currentMarker = ""
  if (current) currentMarker = " •"

  return [
    {
      id: node.session.id,
      line: `${prefix}${label}${currentMarker}`,
      isCurrent: current,
    },
    ...childMatches,
  ]
}

export interface SessionTreeProps {
  open: boolean
  // eslint-disable-next-line effect/noNullish -- tree is absent while the session query is loading.
  tree: SessionTreeNode | null
  currentSessionId: SessionId
  onSelect: (sessionId: SessionId) => void
  onClose: () => void
}

export function SessionTree(props: SessionTreeProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [state, setState] = createSignal(SessionTreeState.initial())
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const items = createMemo<FlatNode[]>(() => {
    const tree = props.tree
    // eslint-disable-next-line effect/noNullish -- loading state is represented by a null tree at this UI boundary.
    if (tree === null) return []
    return buildTreeLines(tree, props.currentSessionId, state().query.trim())
  })

  useScrollSync(() => `session-tree-${state().selectedIndex}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  createEffect(
    on([() => props.open, () => props.tree, () => props.currentSessionId], ([open, tree, id]) => {
      // eslint-disable-next-line effect/noNullish -- the tree is absent while its query loads.
      if (!open || tree === null) return
      const currentIndex = buildTreeLines(tree, id, "").findIndex((item) => item.isCurrent)
      setState(SessionTreeState.initial(Math.max(0, currentIndex)))
    }),
  )

  useScopedKeyboard(
    (e) => {
      if (e.name === "escape") {
        props.onClose()
        return true
      }

      if (e.name === "backspace") {
        setState((current) =>
          transitionSessionTree(current, SessionTreeEvent.cases.Backspace.make({})),
        )
        return true
      }

      const visible = items()
      if (visible.length === 0) return false

      if (e.name === "return") {
        const next = Option.fromNullishOr(visible[state().selectedIndex])
        if (Option.isSome(next)) props.onSelect(next.value.id)
        return true
      }

      if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
        setState((current) =>
          transitionSessionTree(
            current,
            SessionTreeEvent.cases.MoveUp.make({ itemCount: visible.length }),
          ),
        )
        return true
      }

      if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
        setState((current) =>
          transitionSessionTree(
            current,
            SessionTreeEvent.cases.MoveDown.make({ itemCount: visible.length }),
          ),
        )
        return true
      }

      const sequence = Option.fromNullishOr(e.sequence)
      if (Option.isSome(sequence) && sequence.value.length === 1) {
        const char = sequence.value
        if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          setState((current) =>
            transitionSessionTree(current, SessionTreeEvent.cases.TypeChar.make({ char })),
          )
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

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title="Session Tree"
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
          <For each={items()}>
            {(item, index) => {
              const selected = () => state().selectedIndex === index()
              const backgroundColor = () => {
                if (selected()) return theme.primary
                return "transparent"
              }
              const textColor = () => {
                if (selected()) return theme.selectedListItemText
                return theme.text
              }
              return (
                <box
                  id={`session-tree-${index()}`}
                  backgroundColor={backgroundColor()}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: textColor(),
                    }}
                  >
                    {truncate(item.line, panelWidth() - 4)}
                  </text>
                </box>
              )
            }}
          </For>
        </ChromePanel.Body>

        <ChromePanel.Footer>Type | Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
