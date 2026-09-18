/** @jsxImportSource @opentui/solid */
/**
 * Branch picker — one docked pane for choosing which loop of a session to
 * resume.
 *
 * It used to be a route, and a router existed to reach it. Nothing ever
 * navigated to that route: the bootstrap built it once, so the history stack
 * behind it was always empty and escape could only quit. The pane keeps the
 * behaviour and drops the router.
 *
 * The session underneath is already mounted on its active branch, so the pane
 * only has to say which branch to switch to. It opens at boot when the resumed
 * session has more than one branch, and on `/branches` after that. While it is
 * open the startup prompt waits, so a reader never sends a `-p` prompt into a
 * branch they did not choose.
 *
 * It draws the `PickerFrame` every docked pane draws — ruled off top and
 * bottom under the composer, not a bordered box — so its height and its
 * columns come from the picker's budget rather than a dialect of its own.
 *
 * @module
 */

import { createEffect, createSignal, Show } from "solid-js"
import { Effect, Option } from "effect"
import { useTheme } from "../theme"
import { useTerminalDimensions } from "../terminal"
import { useClient } from "../client/index"
import { useRuntime } from "../hooks/use-runtime"
import { ChromePanel } from "./chrome-panel"
import { PickerFrame, pickerHeight, usePickerGeometry } from "./picker-frame"
import { SelectList, selectable, type SelectListRow } from "./select-list"
import type { Branch, BranchTreeNode } from "@gent/sdk"
import type { BranchId, SessionId } from "@gent/core/protocol"
import { formatError, truncate } from "../utils"

interface BranchPickerProps {
  readonly open: boolean
  readonly sessionId: SessionId
  readonly sessionName: string
  readonly branches: readonly Branch[]
  readonly onSelect: (branchId: BranchId) => void
  readonly onClose: () => void
}

export const formatBranchLabel = (
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

const collectCounts = (nodes: readonly BranchTreeNode[]): Map<string, number> => {
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
  const client = useClient()
  const dimensions = useTerminalDimensions()
  const { cast } = useRuntime()

  const [messageCounts, setMessageCounts] = createSignal(new Map<string, number>())
  const [error, setError] = createSignal(Option.none<string>())

  createEffect(() => {
    if (!props.open) return
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

  const { rowWidth } = usePickerGeometry()

  // One line per branch: no heading opens a group and no detail line follows
  // the list, so the pane draws exactly the items it holds.
  const paneHeight = () => pickerHeight(props.branches.length, dimensions().height)

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
              {truncate(line(), rowWidth())}
            </text>
          </box>
        )
      }),
    )

  return (
    <Show when={props.open}>
      <PickerFrame
        height={paneHeight()}
        title={`Resume: ${props.sessionName}`}
        footer={"↑↓ move   ↵ resume branch   esc close"}
      >
        <SelectList
          id="branch-picker"
          open={props.open}
          rows={rows}
          onSelect={(branch) => props.onSelect(branch.id)}
          onDismiss={props.onClose}
        />

        <ChromePanel.Error error={Option.getOrUndefined(error())} />
      </PickerFrame>
    </Show>
  )
}
