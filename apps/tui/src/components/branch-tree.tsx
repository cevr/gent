import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { BranchTreeNode } from "../client"

interface FlatNode {
  id: string
  label: string
  summary: string | undefined
  depth: number
  isActive: boolean
}

export interface BranchTreeProps {
  open: boolean
  tree: readonly BranchTreeNode[]
  activeBranchId?: string
  onSelect: (branchId: string) => void
  onClose: () => void
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value

const flattenTree = (
  nodes: readonly BranchTreeNode[],
  activeBranchId: string | undefined,
  depth = 0,
  acc: FlatNode[] = [],
): FlatNode[] => {
  for (const node of nodes) {
    const name = node.name ?? node.id.slice(0, 8)
    const label = `${name} (${node.messageCount})`
    acc.push({
      id: node.id,
      label,
      summary: node.summary,
      depth,
      isActive: node.id === activeBranchId,
    })
    if (node.children.length > 0) {
      flattenTree(node.children, activeBranchId, depth + 1, acc)
    }
  }
  return acc
}

export function BranchTree(props: BranchTreeProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = () => flattenTree(props.tree, props.activeBranchId)

  useScrollSync(() => `branch-tree-${selectedIndex()}`, { getRef: () => scrollRef })

  createEffect(() => {
    if (!props.open) return
    const list = items()
    if (list.length === 0) {
      setSelectedIndex(0)
      return
    }
    const activeIndex = list.findIndex((item) => item.isActive)
    setSelectedIndex(activeIndex >= 0 ? activeIndex : 0)
  })

  useKeyboard((e) => {
    if (!props.open) return

    if (e.name === "escape") {
      props.onClose()
      return
    }

    const list = items()
    if (list.length === 0) return

    if (e.name === "return") {
      const item = list[selectedIndex()]
      if (item) {
        props.onSelect(item.id)
      }
      return
    }

    if (e.name === "up") {
      setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
      return
    }

    if (e.name === "down") {
      setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
      return
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const formatLine = (item: FlatNode, width: number) => {
    const indent = "  ".repeat(item.depth)
    const active = item.isActive ? " <- active" : ""
    const summary = item.summary ? ` - ${item.summary.replace(/\s+/g, " ")}` : ""
    return truncate(`${indent}${item.label}${active}${summary}`, width)
  }

  return (
    <Show when={props.open}>
      {/* Overlay */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Panel */}
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={panelWidth()}
        height={panelHeight()}
        backgroundColor={theme.backgroundMenu}
        border
        borderColor={theme.borderSubtle}
        flexDirection="column"
      >
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.text }}>Branch Tree</text>
        </box>

        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"-".repeat(panelWidth() - 2)}</text>
        </box>

        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              return (
                <box
                  id={`branch-tree-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {formatLine(item, panelWidth() - 4)}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>

        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>Up/Down | Enter | Esc</text>
        </box>
      </box>
    </Show>
  )
}
