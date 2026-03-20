/**
 * BorderedInput — wraps Input in flat horizontal rules with embedded labels.
 *
 * Layout:
 *   ── $0.14 ──────────── claude-opus-4-5 ──
 *      [autocomplete / input content]
 *   ── · turn 2 · thinking · 5s ── gent ────
 *
 * Top/bottom borders are flat rule lines with embedded label segments.
 * No side borders — content is indented with padding.
 */

import { Show, For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { useTheme } from "../theme/index"
import { buildBorderSegments, type BorderLabelItem, type Segment } from "../utils/border-segments"

export type { BorderLabelItem, Segment } from "../utils/border-segments"

// ── BorderLine ──────────────────────────────────────────────────

interface BorderLineProps {
  left?: BorderLabelItem[]
  right?: BorderLabelItem[]
  borderColor: RGBA
}

function BorderLine(props: BorderLineProps) {
  const dimensions = useTerminalDimensions()

  const segments = (): Segment[] =>
    buildBorderSegments(dimensions().width, props.left ?? [], props.right ?? [], props.borderColor)

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
      <BorderLine left={props.topLeft} right={props.topRight} borderColor={bc()} />
      <box paddingLeft={2}>{props.children}</box>
      <BorderLine left={props.bottomLeft} right={props.bottomRight} borderColor={bc()} />
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
