import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { SessionId } from "@gent/core/domain/ids.js"
import type { SessionTreeNode } from "../client"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncate } from "../utils/truncate"

interface FlatNode {
  id: SessionId
  line: string
  isCurrent: boolean
}

const fuzzyMatch = (text: string, query: string): boolean => {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

const labelFor = (node: SessionTreeNode): string => {
  const name = node.name ?? node.id.slice(0, 8)
  const cwd = node.cwd?.split("/").filter(Boolean).pop()
  return cwd !== undefined ? `${name} · ${cwd}` : name
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
    fuzzyMatch(label, query) ||
    node.id === currentSessionId ||
    childMatches.length > 0

  if (!visible) return []

  const prefix =
    guides.length === 0
      ? ""
      : guides
          .slice(0, -1)
          .map((show) => (show ? "│  " : "   "))
          .join("") + (isLast ? "└─ " : "├─ ")
  const current = node.id === currentSessionId

  return [
    {
      id: node.id,
      line: `${prefix}${label}${current ? " •" : ""}`,
      isCurrent: current,
    },
    ...childMatches,
  ]
}

export interface SessionTreeProps {
  open: boolean
  tree: SessionTreeNode | null
  currentSessionId: SessionId
  onSelect: (sessionId: SessionId) => void
  onClose: () => void
}

export function SessionTree(props: SessionTreeProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [query, setQuery] = createSignal("")
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = createMemo(() => {
    const tree = props.tree
    if (tree === null) return [] as FlatNode[]
    return buildTreeLines(tree, props.currentSessionId, query().trim())
  })

  useScrollSync(() => `session-tree-${selectedIndex()}`, { getRef: () => scrollRef })

  createEffect(() => {
    if (!props.open) return
    setQuery("")
    const currentIndex = items().findIndex((item) => item.isCurrent)
    setSelectedIndex(currentIndex >= 0 ? currentIndex : 0)
  })

  useKeyboard((e) => {
    if (!props.open) return

    if (e.name === "escape") {
      props.onClose()
      return
    }

    if (e.name === "backspace") {
      setQuery((current) => current.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    const visible = items()
    if (visible.length === 0) return

    if (e.name === "return") {
      const next = visible[selectedIndex()]
      if (next !== undefined) props.onSelect(next.id)
      return
    }

    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((index) => (index > 0 ? index - 1 : visible.length - 1))
      return
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((index) => (index < visible.length - 1 ? index + 1 : 0))
      return
    }

    if (e.sequence !== undefined && e.sequence.length === 1) {
      const char = e.sequence
      if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
        setQuery((current) => current + char)
        setSelectedIndex(0)
      }
    }
  })

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
            {query()}
            <span style={{ fg: theme.primary }}>│</span>
          </text>
        </ChromePanel.Section>

        <ChromePanel.Body ref={scrollRef}>
          <For each={items()}>
            {(item, index) => {
              const selected = () => selectedIndex() === index()
              return (
                <box
                  id={`session-tree-${index()}`}
                  backgroundColor={selected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: selected() ? theme.selectedListItemText : theme.text,
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
