/** @jsxImportSource @opentui/solid */
/**
 * Subagent tray — one line above the composer.
 *
 * It reports how many loops hang off the current session while the agents pane
 * is closed, so a reader sees delegated work without opening anything. The pane
 * in `agents-view.client.tsx` owns the controller and the projection; this file
 * only reads and renders.
 *
 * @module
 */

import { Option, Predicate } from "effect"
import { createEffect, For, on, Show } from "solid-js"
import type { AgentRowEntry } from "@gent/extensions/client"
import { useTerminalDimensions } from "../../terminal-dimensions"
import { useTheme } from "../../theme"
import { truncate } from "../../utils/truncate"
import { workingIconFrame } from "../../components/message-list-utils"
import { useSpinnerClock } from "../../hooks/use-spinner-clock"
import type { AgentsController } from "./agents-view.client"

interface SubtreeCounts {
  readonly total: number
  readonly running: number
  readonly idle: number
  readonly inactive: number
}

/** Descendants of `root` at any depth, in the server's parent-before-child order. */
const subtreeRows = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: Option.Option<{ readonly sessionId: string }>,
): ReadonlyArray<AgentRowEntry> => {
  if (Option.isNone(root)) return []
  const known = new Set<string>([root.value.sessionId])
  const descendants: Array<AgentRowEntry> = []
  let pending = rows.filter((row) => row.sessionId !== root.value.sessionId)
  for (;;) {
    const next = pending.filter(
      (row) => Predicate.isNotUndefined(row.parentSessionId) && known.has(row.parentSessionId),
    )
    if (next.length === 0) return descendants
    for (const row of next) {
      descendants.push(row)
      known.add(row.sessionId)
    }
    pending = pending.filter((row) => !known.has(row.sessionId))
  }
}

/** Section counts over every row descending from `root`; the root itself is not counted. */
export const subtreeCounts = (
  rows: ReadonlyArray<AgentRowEntry>,
  root: Option.Option<{ readonly sessionId: string }>,
): SubtreeCounts => {
  const counts = { total: 0, running: 0, idle: 0, inactive: 0 }
  for (const row of subtreeRows(rows, root)) {
    counts.total += 1
    counts[row.section] += 1
  }
  return counts
}

const TRAY_HINT = "^t agents"
const TRAY_MAX_ROWS = 3

/** The task a row is on: its name without the `agent: ` prefix the delegate title carries, else its cwd. */
const taskFor = (row: AgentRowEntry): string => {
  const agent = Option.getOrElse(Option.fromUndefinedOr(row.agent), () => "")
  const name = Option.fromUndefinedOr(row.name).pipe(
    Option.orElse(() => Option.fromUndefinedOr(row.cwd)),
    Option.getOrElse(() => row.sessionId),
  )
  if (agent.length > 0 && name.startsWith(`${agent}: `)) return name.slice(agent.length + 2)
  return name
}

/**
 * fx's subagent rows: `<agent> working · <task>`, one per running child and
 * nothing else. Past the cap the rest collapse into one count line.
 */
export const trayLines = (
  running: ReadonlyArray<AgentRowEntry>,
  width: number,
): ReadonlyArray<{ readonly pulse: boolean; readonly text: string }> => {
  const shown = running.slice(0, TRAY_MAX_ROWS)
  const lines = shown.map((row) => {
    const agent = Option.getOrElse(Option.fromUndefinedOr(row.agent), () => "agent")
    return { pulse: true, text: truncate(`${agent} working · ${taskFor(row)}`, width) }
  })
  const rest = running.length - shown.length
  if (rest > 0) lines.push({ pulse: false, text: `+${rest} more working` })
  return lines
}

export function SubagentTray(props: { controller: AgentsController }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useSpinnerClock()
  const running = () =>
    subtreeRows(props.controller.rows(), props.controller.current()).filter(
      (row) => row.section === "running",
    )
  // Switching sessions changes whose subtree the tray lists; refetch for it.
  createEffect(
    on(
      () => Option.getOrUndefined(Option.map(props.controller.current(), (row) => row.sessionId)),
      () => props.controller.refresh(""),
    ),
  )
  // Two columns of padding, the pulse and its space, and the hint on the first line.
  const textWidth = () => Math.max(8, dimensions().width - 4 - TRAY_HINT.length - 2)
  const lines = () => trayLines(running(), textWidth())
  const glyph = (pulse: boolean): string => {
    if (pulse) return workingIconFrame(tick())
    return " "
  }
  return (
    <Show when={!props.controller.open() && running().length > 0}>
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <For each={lines()}>
          {(line, index) => (
            <text wrapMode="none">
              <span style={{ fg: theme.success }}>{`${glyph(line.pulse)} `}</span>
              <span style={{ fg: theme.textMuted }}>{line.text}</span>
              <Show when={index() === 0}>
                <span style={{ fg: theme.textMuted }}>
                  {`${" ".repeat(Math.max(1, textWidth() - line.text.length + 2))}${TRAY_HINT}`}
                </span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
