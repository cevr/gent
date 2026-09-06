import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { BranchTreeNode } from "../client"
import { BranchId } from "@gent/core-internal/domain/ids.js"
import { truncate } from "../utils/format-tool"
import { useScopedKeyboard } from "../keyboard/context"
import { Option } from "effect"

interface FlatNode {
  id: string
  label: string
  // eslint-disable-next-line effect/noNullish -- branch summaries are optional transport fields.
  summary: string | undefined
  depth: number
  isActive: boolean
}

export interface BranchTreeProps {
  open: boolean
  tree: readonly BranchTreeNode[]
  // eslint-disable-next-line effect/noNullish -- picker props preserve an absent active branch.
  activeBranchId?: BranchId
  onSelect: (branchId: BranchId) => void
  onClose: () => void
}

const flattenTree = (
  nodes: readonly BranchTreeNode[],
  // eslint-disable-next-line effect/noNullish -- tree props preserve an absent active branch.
  activeBranchId: BranchId | undefined,
  depth = 0,
  acc: FlatNode[] = [],
): FlatNode[] => {
  for (const node of nodes) {
    const name = node.branch.name ?? node.branch.id.slice(0, 8)
    const label = `${name} (${node.messageCount})`
    acc.push({
      id: node.branch.id,
      label,
      summary: node.branch.summary,
      depth,
      isActive: node.branch.id === activeBranchId,
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
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const items = () => flattenTree(props.tree, props.activeBranchId)

  useScrollSync(() => `branch-tree-${selectedIndex()}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  createEffect(() => {
    if (!props.open) return
    const list = items()
    if (list.length === 0) {
      setSelectedIndex(0)
      return
    }
    const activeIndex = list.findIndex((item) => item.isActive)
    if (activeIndex >= 0) setSelectedIndex(activeIndex)
    else setSelectedIndex(0)
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
        const item = Option.fromNullishOr(list[selectedIndex()])
        if (Option.isSome(item)) {
          // SAFETY: FlatNode.id originates from BranchTreeNode.id which is a BranchId
          props.onSelect(BranchId.make(item.value.id))
        }
        return true
      }

      if (e.name === "up") {
        setSelectedIndex((i) => {
          if (i > 0) return i - 1
          return list.length - 1
        })
        return true
      }

      if (e.name === "down") {
        setSelectedIndex((i) => {
          if (i < list.length - 1) return i + 1
          return 0
        })
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
    let active = ""
    if (item.isActive) active = " <- active"
    let summary = ""
    const summaryValue = Option.fromNullishOr(item.summary)
    if (Option.isSome(summaryValue) && summaryValue.value.length > 0) {
      summary = ` - ${summaryValue.value.replace(/\s+/g, " ")}`
    }
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
        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              const backgroundColor = () => {
                if (isSelected()) return theme.primary
                return "transparent"
              }
              const textColor = () => {
                if (isSelected()) return theme.selectedListItemText
                return theme.text
              }
              return (
                <box
                  id={`branch-tree-${index()}`}
                  backgroundColor={backgroundColor()}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: textColor(),
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
