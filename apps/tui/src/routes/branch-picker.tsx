/**
 * Branch picker route - choose branch when resuming multi-branch session
 */

import { createEffect, createSignal, For } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { Effect } from "effect"
import { useTheme } from "../theme/index"
import { useClient } from "../client/index"
import { useRouter } from "../router/index"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { BranchInfo, BranchTreeNode } from "../client"
import { formatError } from "../utils/format-error"

export interface BranchPickerProps {
  sessionId: string
  sessionName: string
  branches: readonly BranchInfo[]
  prompt?: string
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value

const formatBranchLabel = (branch: BranchInfo, messageCount?: number): string => {
  const name = branch.name ?? branch.id.slice(0, 8)
  const count = messageCount !== undefined ? ` (${messageCount})` : ""
  return `${name}${count}`
}

const collectCounts = (nodes: readonly BranchTreeNode[]) => {
  const map = new Map<string, number>()
  const walk = (list: readonly BranchTreeNode[]) => {
    for (const node of list) {
      map.set(node.id, node.messageCount)
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return map
}

export function BranchPicker(props: BranchPickerProps) {
  const { theme } = useTheme()
  const client = useClient()
  const router = useRouter()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime(client.client.runtime)

  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [messageCounts, setMessageCounts] = createSignal<Map<string, number>>(new Map())
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(() => `branch-picker-${selectedIndex()}`, { getRef: () => scrollRef })

  createEffect(() => {
    cast(
      client.client.getBranchTree(props.sessionId).pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setMessageCounts(collectCounts(tree))
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            client.setError(formatError(err))
          }),
        ),
      ),
    )
  })

  useKeyboard((e) => {
    if (e.name === "escape") {
      router.navigateToHome()
      return
    }

    if (props.branches.length === 0) return

    if (e.name === "return") {
      const branch = props.branches[selectedIndex()]
      if (branch !== undefined) {
        client.switchSession(props.sessionId, branch.id, props.sessionName, branch.model)
        router.navigateToSession(props.sessionId, branch.id, props.prompt)
      }
      return
    }

    if (e.name === "up") {
      setSelectedIndex((i) => (i > 0 ? i - 1 : props.branches.length - 1))
      return
    }

    if (e.name === "down") {
      setSelectedIndex((i) => (i < props.branches.length - 1 ? i + 1 : 0))
      return
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  return (
    <box flexDirection="column" width="100%" height="100%">
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
          <text style={{ fg: theme.text }}>Resume: {props.sessionName}</text>
        </box>

        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"-".repeat(panelWidth() - 2)}</text>
        </box>

        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={props.branches}>
            {(branch, index) => {
              const isSelected = () => selectedIndex() === index()
              const count = () => messageCounts().get(branch.id)
              const summary =
                branch.summary !== undefined && branch.summary.length > 0
                  ? ` - ${branch.summary.replace(/\s+/g, " ")}`
                  : ""
              const line = `${formatBranchLabel(branch, count())}${summary}`
              return (
                <box
                  id={`branch-picker-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {truncate(line, panelWidth() - 4)}
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
    </box>
  )
}
