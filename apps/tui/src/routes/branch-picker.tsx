/**
 * Branch picker route - choose branch when resuming multi-branch session
 */

import { createEffect, createSignal } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { Effect, Option } from "effect"
import { useTheme } from "../theme/index"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useClient } from "../client/index"
import { useRouter } from "../router"
import { useEnv } from "../env/context"
import { useRuntime } from "../hooks/use-runtime"
import { ChromePanel } from "../components/chrome-panel"
import { SelectList, selectable, type SelectListRow } from "../components/select-list"
import type { Branch, BranchTreeNode } from "../client"
import type { SessionId } from "@gent/core/protocol"
import { formatError } from "../utils/format-error"
import { truncate } from "../utils/format-tool"

export interface BranchPickerProps {
  sessionId: SessionId
  sessionName: string
  branches: readonly Branch[]
  prompt?: string
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

  const [messageCounts, setMessageCounts] = createSignal(new Map<string, number>())
  const [error, setError] = createSignal(Option.none<string>())

  createEffect(() => {
    cast(
      client.client.branch.getTree({ sessionId: props.sessionId }).pipe(
        Effect.tap((tree) =>
          Effect.sync(() => {
            setMessageCounts(collectCounts(tree))
            setError(Option.none())
          }),
        ),
        Effect.catchEager((err) => Effect.sync(() => setError(Option.some(formatError(err))))),
      ),
    )
  })

  /**
   * Escape leaves the route, not the list. This picker is where a session with
   * several branches starts, so with nowhere to go back to the only way out is
   * to quit.
   */
  const leave = () => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    renderer.destroy()
    env.shutdown()
  }

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const rows = (): ReadonlyArray<SelectListRow<Branch>> =>
    props.branches.map((branch) =>
      selectable(branch, (isSelected, id) => {
        const count = () => Option.fromNullishOr(messageCounts().get(branch.id))
        const backgroundColor = () => {
          if (isSelected()) return theme.primary
          return "transparent"
        }
        const foregroundColor = () => {
          if (isSelected()) return theme.selectedListItemText
          return theme.text
        }
        const line = () => formatBranchLabel(branch, count())
        return (
          <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
            <text
              style={{
                fg: foregroundColor(),
              }}
            >
              {truncate(line(), panelWidth() - 4)}
            </text>
          </box>
        )
      }),
    )

  const choose = (branch: Branch) => {
    client.switchSession(props.sessionId, branch.id, props.sessionName)
    router.navigateToSession(props.sessionId, branch.id, props.prompt)
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
        <ChromePanel.Error error={Option.getOrUndefined(error())} />

        <SelectList
          id="branch-picker"
          open={true}
          rows={rows}
          onSelect={choose}
          onDismiss={leave}
        />

        <ChromePanel.Footer>Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </box>
  )
}
