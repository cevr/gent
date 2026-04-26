/**
 * Full-screen pannable mermaid diagram viewer overlay.
 * Supports arrow key panning and [/] for diagram cycling.
 */

import { createSignal, Show, createMemo, createEffect } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { renderMermaidToAscii, extractMermaidBlocks } from "../utils/mermaid"
import { useScopedKeyboard } from "../keyboard/context"
import {
  MermaidViewerEvent,
  MermaidViewerState,
  transitionMermaidViewer,
} from "./mermaid-viewer-state"

export interface MermaidDiagram {
  source: string
  rendered: string
}

interface MermaidViewerProps {
  open: boolean
  diagrams: MermaidDiagram[]
  onClose: () => void
}

const PAN_STEP_X = 10
const PAN_STEP_Y = 3

export function MermaidViewer(props: MermaidViewerProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const [state, setState] = createSignal(MermaidViewerState.initial())

  createEffect(() => {
    if (!props.open) return
    setState(transitionMermaidViewer(state(), MermaidViewerEvent.Open.make({})))
  })

  const currentDiagram = createMemo(() => {
    const idx = state().diagramIndex
    return props.diagrams[idx]
  })

  const visibleContent = createMemo(() => {
    const diagram = currentDiagram()
    if (diagram === undefined) return ""

    const lines = diagram.rendered.split("\n")
    const startLine = state().panY
    const startCol = state().panX
    const viewHeight = dimensions().height - 3 // Leave room for header/footer
    const viewWidth = dimensions().width

    return lines
      .slice(startLine, startLine + viewHeight)
      .map((line) => {
        // Strip ANSI for slicing, but we need to keep ANSI codes
        // Simple approach: slice by visible characters
        if (startCol === 0) return line
        // Remove ANSI, slice, but this loses colors. Acceptable for panning.
        // eslint-disable-next-line no-control-regex -- ANSI escape stripping needs literal control-byte patterns
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "")
        return stripped.slice(startCol, startCol + viewWidth)
      })
      .join("\n")
  })

  useScopedKeyboard(
    (e) => {
      if (e.name === "escape" || (e.ctrl === true && e.name === "m" && e.shift === true)) {
        props.onClose()
        return true
      }

      // Panning
      if (e.name === "left") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.PanLeft.make({ step: PAN_STEP_X })),
        )
        return true
      }
      if (e.name === "right") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.PanRight.make({ step: PAN_STEP_X })),
        )
        return true
      }
      if (e.name === "up") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.PanUp.make({ step: PAN_STEP_Y })),
        )
        return true
      }
      if (e.name === "down") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.PanDown.make({ step: PAN_STEP_Y })),
        )
        return true
      }

      // Diagram cycling
      if (e.sequence === "[") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.PrevDiagram.make({})),
        )
        return true
      }
      if (e.sequence === "]") {
        setState((current) =>
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.NextDiagram.make({
              diagramCount: props.diagrams.length,
            }),
          ),
        )
        return true
      }

      // Home/End for quick navigation
      if (e.name === "home") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.ResetPan.make({})),
        )
        return true
      }
      return false
    },
    { when: () => props.open },
  )

  return (
    <Show when={props.open && props.diagrams.length > 0}>
      <box
        position="absolute"
        top={0}
        left={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={theme.background}
        flexDirection="column"
      >
        {/* Header */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.info }}>
            Mermaid Viewer ({state().diagramIndex + 1}/{props.diagrams.length})
            <span style={{ fg: theme.textMuted }}> — arrows: pan, [/]: cycle, esc: close</span>
          </text>
        </box>

        {/* Diagram */}
        <box flexGrow={1} paddingLeft={1}>
          <text style={{ fg: theme.text }}>{visibleContent()}</text>
        </box>

        {/* Footer */}
        <box paddingLeft={1} flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>
            pan: ({state().panX}, {state().panY})
          </text>
        </box>
      </box>
    </Show>
  )
}

/**
 * Collect all renderable mermaid diagrams from message content.
 */
export function collectDiagrams(
  messages: Array<{ content: string }>,
  width: number,
): MermaidDiagram[] {
  const diagrams: MermaidDiagram[] = []
  const renderWidth = width > 0 ? width : 120

  for (const msg of messages) {
    const blocks = extractMermaidBlocks(msg.content)
    for (const block of blocks) {
      const rendered = renderMermaidToAscii(block.source, renderWidth)
      if (rendered !== undefined) {
        diagrams.push({ source: block.source, rendered })
      }
    }
  }

  return diagrams
}
