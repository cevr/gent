import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { BranchTreeNode } from "../client"
import type { BranchId } from "@gent/core/domain/ids.js"
import { truncate } from "../utils/truncate"
import { useScopedKeyboard } from "../keyboard/context"

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
  activeBranchId?: BranchId
  onSelect: (branchId: BranchId) => void
  onClose: () => void
}

const flattenTree = (
  nodes: readonly BranchTreeNode[],
  activeBranchId: BranchId | undefined,
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

  useScopedKeyboard(
    (e) => {
      if (e.name === "escape") {
        props.onClose()
        return true
      }

      const list = items()
      if (list.length === 0) return false

      if (e.name === "return") {
        const item = list[selectedIndex()]
        if (item !== undefined) {
          // SAFETY: FlatNode.id originates from BranchTreeNode.id which is a BranchId
          props.onSelect(item.id as BranchId)
        }
        return true
      }

      if (e.name === "up") {
        setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
        return true
      }

      if (e.name === "down") {
        setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
        return true
      }
      return false
    },
    { when: () => props.open },
  )

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const formatLine = (item: FlatNode, width: number) => {
    const indent = "  ".repeat(item.depth)
    const active = item.isActive ? " <- active" : ""
    const summary =
      item.summary !== undefined && item.summary.length > 0
        ? ` - ${item.summary.replace(/\s+/g, " ")}`
        : ""
    return truncate(`${indent}${item.label}${active}${summary}`, width)
  }

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title="Branch Tree"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Body ref={scrollRef}>
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
        </ChromePanel.Body>

        <ChromePanel.Footer>Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
