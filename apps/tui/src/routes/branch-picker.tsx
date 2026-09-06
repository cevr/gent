/**
 * Branch picker route - choose branch when resuming multi-branch session
 */

import { createEffect, createSignal, For } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Effect, Match, Option } from "effect"
import { useTheme } from "../theme/index"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useClient } from "../client/index"
import { useRouter } from "../router"
import { useEnv } from "../env/context"
import { useRuntime } from "../hooks/use-runtime"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { ChromePanel } from "../components/chrome-panel"
import type { Branch, BranchTreeNode } from "../client"
import type { SessionId } from "@gent/core-internal/domain/ids.js"
import { formatError } from "../utils/format-error"
import { truncate } from "../utils/format-tool"
import { useScopedKeyboard } from "../keyboard/context"

export interface BranchPickerProps {
  sessionId: SessionId
  sessionName: string
  branches: readonly Branch[]
  prompt?: string
}

type BranchPickerState =
  | { _tag: "loading"; error: Option.Option<string> }
  | {
      _tag: "ready"
      selectedIndex: number
      messageCounts: Map<string, number>
      error: Option.Option<string>
    }

const formatBranchLabel = (
  branch: Branch,
  messageCount: Option.Option<number> = Option.none(),
): string => {
  const name = Option.getOrElse(Option.fromNullishOr(branch.name), () => branch.id.slice(0, 8))
  const count = Option.match(messageCount, {
    onNone: () => "",
    onSome: (value) => ` (${value})`,
  })
  return `${name}${count}`
}

const collectCounts = (nodes: readonly BranchTreeNode[]) => {
  const map = new Map<string, number>()
  const walk = (list: readonly BranchTreeNode[]) => {
    for (const node of list) {
      map.set(node.branch.id, node.messageCount)
      if (node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return map
}

export function BranchPicker(props: BranchPickerProps) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const client = useClient()
  const router = useRouter()
  const env = useEnv()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime()

  const [state, setState] = createSignal<BranchPickerState>({
    _tag: "loading",
    error: Option.none(),
  })
  let scrollRef = Option.none<ScrollBoxRenderable>()

  useScrollSync(
    () => {
      const current = state()
      let selectedIndex = 0
      if (current._tag === "ready") selectedIndex = current.selectedIndex
      return `branch-picker-${selectedIndex}`
    },
    { getRef: () => Option.getOrUndefined(scrollRef) },
  )

  createEffect(() => {
    cast(
      client.client.branch.getTree({ sessionId: props.sessionId }).pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setState((current): BranchPickerState => {
              let selectedIndex = 0
              if (current._tag === "ready") selectedIndex = current.selectedIndex
              return {
                _tag: "ready",
                selectedIndex,
                messageCounts: collectCounts(tree),
                error: Option.none(),
              }
            })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            setState((current): BranchPickerState => {
              const error = formatError(err)
              return Match.value(current).pipe(
                Match.tagsExhaustive({
                  loading: (): BranchPickerState => ({
                    _tag: "loading",
                    error: Option.some(error),
                  }),
                  ready: (current): BranchPickerState => ({
                    _tag: "ready",
                    selectedIndex: current.selectedIndex,
                    messageCounts: current.messageCounts,
                    error: Option.some(error),
                  }),
                }),
              )
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

  useScopedKeyboard((e) => {
    if (e.name === "escape") {
      if (router.canGoBack()) {
        router.back()
      } else {
        renderer.destroy()
        env.shutdown()
      }
      return true
    }

    const current = state()
    if (current._tag !== "ready" || props.branches.length === 0) return false

    if (e.name === "return") {
      const branch = Option.fromNullishOr(props.branches[current.selectedIndex])
      if (Option.isSome(branch)) {
        client.switchSession(props.sessionId, branch.value.id, props.sessionName)
        router.navigateToSession(props.sessionId, branch.value.id, props.prompt)
      }
      return true
    }

    if (e.name === "up") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        let next = props.branches.length - 1
        if (prev.selectedIndex > 0) next = prev.selectedIndex - 1
        return {
          _tag: "ready",
          selectedIndex: next,
          messageCounts: prev.messageCounts,
          error: prev.error,
        }
      })
      return true
    }

    if (e.name === "down") {
      setState((prev) => {
        if (prev._tag !== "ready") return prev
        let next = 0
        if (prev.selectedIndex < props.branches.length - 1) next = prev.selectedIndex + 1
        return {
          _tag: "ready",
          selectedIndex: next,
          messageCounts: prev.messageCounts,
          error: prev.error,
        }
      })
      return true
    }
    return false
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)
  const readyState = (): Option.Option<Extract<BranchPickerState, { _tag: "ready" }>> => {
    const current = state()
    if (current._tag !== "ready") return Option.none()
    return Option.some(current)
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <ChromePanel.Root
        title={`Resume: ${props.sessionName}`}
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Error error={Option.getOrUndefined(state().error)} />

        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
          <For each={props.branches}>
            {(branch, index) => {
              const isSelected = () =>
                Option.exists(readyState(), (current) => current.selectedIndex === index())
              const count = () =>
                Option.flatMap(readyState(), (current) =>
                  Option.fromNullishOr(current.messageCounts.get(branch.id)),
                )
              const summary = () => {
                const value = Option.fromNullishOr(branch.summary)
                if (Option.isNone(value) || value.value.length === 0) return ""
                return ` - ${value.value.replace(/\s+/g, " ")}`
              }
              const backgroundColor = () => {
                if (isSelected()) return theme.primary
                return "transparent"
              }
              const foregroundColor = () => {
                if (isSelected()) return theme.selectedListItemText
                return theme.text
              }
              const line = () => `${formatBranchLabel(branch, count())}${summary()}`
              return (
                <box
                  id={`branch-picker-${index()}`}
                  backgroundColor={backgroundColor()}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: foregroundColor(),
                    }}
                  >
                    {truncate(line(), panelWidth() - 4)}
                  </text>
                </box>
              )
            }}
          </For>
        </ChromePanel.Body>

        <ChromePanel.Footer>Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
