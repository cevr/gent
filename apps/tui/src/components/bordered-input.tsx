/**
 * BorderedInput — wraps Input in box-drawing borders with embedded labels.
 *
 * Layout:
 *   ╭─ $0.14 ──────────── claude-opus-4-5 ─╮
 *   │  [autocomplete / input content]        │
 *   ╰── · turn 2 · thinking · 5s ── gent ───╯
 *
 * Top/bottom borders are manual <text> lines with embedded label segments.
 * Left/right borders use <box border={["left", "right"]}> for auto-stretch.
 */

import { Show, For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../theme/index"

export interface BorderLabelItem {
  text: string
  color: RGBA
}

// ── BorderLine ──────────────────────────────────────────────────

interface BorderLineProps {
  corner: "top" | "bottom"
  left?: BorderLabelItem[]
  right?: BorderLabelItem[]
  borderColor: RGBA
}

/** Segment with text + color for rendering spans */
interface Segment {
  text: string
  color: RGBA
}

function BorderLine(props: BorderLineProps) {
  const dimensions = useTerminalDimensions()

  const segments = (): Segment[] => {
    const width = dimensions().width
    const [cornerL, cornerR] = props.corner === "top" ? ["╭", "╮"] : ["╰", "╯"]
    const bc = props.borderColor

    const leftItems = props.left ?? []
    const rightItems = props.right ?? []

    const result: Segment[] = []

    // Left corner
    result.push({ text: cornerL, color: bc })

    // Left labels: "─ label1 · label2 "
    let usedWidth = 2 // both corners
    if (leftItems.length > 0) {
      result.push({ text: "─ ", color: bc })
      usedWidth += 2
      for (let idx = 0; idx < leftItems.length; idx++) {
        const item = leftItems[idx]
        if (item === undefined) continue
        if (idx > 0) {
          result.push({ text: " · ", color: bc })
          usedWidth += 3
        }
        result.push({ text: item.text, color: item.color })
        usedWidth += item.text.length
      }
      result.push({ text: " ", color: bc })
      usedWidth += 1
    }

    // Right labels (build ahead to know width): " label1 · label2 ─"
    const rightSegments: Segment[] = []
    if (rightItems.length > 0) {
      rightSegments.push({ text: " ", color: bc })
      usedWidth += 1
      for (let idx = 0; idx < rightItems.length; idx++) {
        const item = rightItems[idx]
        if (item === undefined) continue
        if (idx > 0) {
          rightSegments.push({ text: " · ", color: bc })
          usedWidth += 3
        }
        rightSegments.push({ text: item.text, color: item.color })
        usedWidth += item.text.length
      }
      rightSegments.push({ text: " ─", color: bc })
      usedWidth += 2
    }

    // Fill
    const fill = Math.max(0, width - usedWidth)
    result.push({ text: "─".repeat(fill), color: bc })

    // Right labels
    result.push(...rightSegments)

    // Right corner
    result.push({ text: cornerR, color: bc })

    return result
  }

  return (
    <box flexShrink={0}>
      <text>
        <For each={segments()}>{(seg) => <span style={{ fg: seg.color }}>{seg.text}</span>}</For>
      </text>
    </box>
  )
}

// ── BorderedInput ───────────────────────────────────────────────

export interface BorderedInputProps {
  topLeft?: BorderLabelItem[]
  topRight?: BorderLabelItem[]
  bottomLeft?: BorderLabelItem[]
  bottomRight?: BorderLabelItem[]
  borderColor?: RGBA
  error?: string | null
  children: JSX.Element
}

export function BorderedInput(props: BorderedInputProps) {
  const { theme } = useTheme()

  const bc = () => props.borderColor ?? theme.border

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.error}>
        <box paddingLeft={1}>
          <text style={{ fg: theme.error }}>{props.error}</text>
        </box>
      </Show>
      <BorderLine corner="top" left={props.topLeft} right={props.topRight} borderColor={bc()} />
      <box border={["left", "right"]} borderColor={bc()} borderStyle="rounded">
        {props.children}
      </box>
      <BorderLine
        corner="bottom"
        left={props.bottomLeft}
        right={props.bottomRight}
        borderColor={bc()}
      />
    </box>
  )
}

// ── Helpers ─────────────────────────────────────────────────────

export function formatCwdGit(cwd: string, gitRoot: string | null, branch?: string): string {
  let label: string
  if (gitRoot !== null) {
    const repoParts = gitRoot.split("/")
    const repoName = repoParts[repoParts.length - 1] ?? ""
    if (cwd === gitRoot) {
      label = repoName
    } else if (cwd.startsWith(gitRoot + "/")) {
      label = repoName + "/" + cwd.slice(gitRoot.length + 1)
    } else {
      label = repoParts[repoParts.length - 1] ?? cwd
    }
  } else {
    const parts = cwd.split("/")
    label = parts[parts.length - 1] ?? cwd
  }

  if (branch !== undefined && branch.length > 0) {
    return `${label} (${branch})`
  }
  return label
}

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${mins}m ${remainingSecs}s`
}
