/**
 * Branch picker route - choose branch when resuming multi-branch session
 */

import { createEffect, createSignal, For, Show } from "solid-js"
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

type BranchPickerState =
  | { _tag: "loading"; error?: string }
  | { _tag: "ready"; selectedIndex: number; messageCounts: Map<string, number>; error?: string }

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

  const [state, setState] = createSignal<BranchPickerState>({
    _tag: "loading",
  })
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  useScrollSync(
    () => {
      const current = state()
      return `branch-picker-${current._tag === "ready" ? current.selectedIndex : 0}`
    },
    { getRef: () => scrollRef },
  )

  createEffect(() => {
    cast(
      client.client.getBranchTree(props.sessionId).pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setState((current) => ({
              _tag: "ready",
              selectedIndex: current._tag === "ready" ? current.selectedIndex : 0,
              messageCounts: collectCounts(tree),
              error: undefined,
            }))
          }),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => {
            setState((current) => {
              const error = formatError(err)
              switch (current._tag) {
                case "loading":
                  return { _tag: "loading", error }
                case "ready":
                  return {
                    _tag: "ready",
                    selectedIndex: current.selectedIndex,
                    messageCounts: current.messageCounts,
                    error,
                  }
              }
            })
          }),
        ),
      ),
    )
  })

  createEffect(() => {
    const current = state()
    if (current._tag !== "ready") return
    if (props.branches.length === 0) return
    if (current.selectedIndex >= props.branches.length) {
      setState({
        _tag: "ready",
        selectedIndex: props.branches.length - 1,
        messageCounts: current.messageCounts,
        error: current.error,
      })
    }
  })

  useKeyboard((e) => {
    if (e.name === "escape") {
      router.navigateToHome()
      return
    }

    const current = state()
    if (current._tag !== "ready" || props.branches.length === 0) return

    if (e.name === "return") {
      const branch = props.branches[current.selectedIndex]
      if (branch !== undefined) {
        client.switchSession(props.sessionId, branch.id, props.sessionName)
        router.navigateToSession(props.sessionId, branch.id, props.prompt)
      }
      return
    }

    if (e.name === "up") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex > 0 ? prev.selectedIndex - 1 : props.branches.length - 1
        return {
          _tag: "ready",
          selectedIndex: next,
          messageCounts: prev.messageCounts,
          error: prev.error,
        }
      })
      return
    }

    if (e.name === "down") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        const next = prev.selectedIndex < props.branches.length - 1 ? prev.selectedIndex + 1 : 0
        return {
          _tag: "ready",
          selectedIndex: next,
          messageCounts: prev.messageCounts,
          error: prev.error,
        }
      })
      return
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)
  const readyState = () => {
    const current = state()
    return current._tag === "ready" ? current : null
  }

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

        <Show when={state().error !== undefined}>
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{state().error}</text>
          </box>
        </Show>

        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={props.branches}>
            {(branch, index) => {
              const current = readyState()
              const isSelected = () => current !== null && current.selectedIndex === index()
              const count = () =>
                current !== null ? current.messageCounts.get(branch.id) : undefined
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
