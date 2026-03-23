/**
 * Full-screen pannable mermaid diagram viewer overlay.
 * Supports arrow key panning and [/] for diagram cycling.
 */

import { createSignal, Show, createMemo } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { renderMermaidToAscii, extractMermaidBlocks } from "../utils/mermaid"
import { useScopedKeyboard } from "../keyboard/context"

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

  const [diagramIndex, setDiagramIndex] = createSignal(0)
  const [panX, setPanX] = createSignal(0)
  const [panY, setPanY] = createSignal(0)

  const currentDiagram = createMemo(() => {
    const idx = diagramIndex()
    return props.diagrams[idx]
  })

  const visibleContent = createMemo(() => {
    const diagram = currentDiagram()
    if (diagram === undefined) return ""

    const lines = diagram.rendered.split("\n")
    const startLine = panY()
    const startCol = panX()
    const viewHeight = dimensions().height - 3 // Leave room for header/footer
    const viewWidth = dimensions().width

    return lines
      .slice(startLine, startLine + viewHeight)
      .map((line) => {
        // Strip ANSI for slicing, but we need to keep ANSI codes
        // Simple approach: slice by visible characters
        if (startCol === 0) return line
        // Remove ANSI, slice, but this loses colors. Acceptable for panning.
        // eslint-disable-next-line no-control-regex
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
        setPanX((x) => Math.max(0, x - PAN_STEP_X))
        return true
      }
      if (e.name === "right") {
        setPanX((x) => x + PAN_STEP_X)
        return true
      }
      if (e.name === "up") {
        setPanY((y) => Math.max(0, y - PAN_STEP_Y))
        return true
      }
      if (e.name === "down") {
        setPanY((y) => y + PAN_STEP_Y)
        return true
      }

      // Diagram cycling
      if (e.sequence === "[") {
        setDiagramIndex((i) => Math.max(0, i - 1))
        setPanX(0)
        setPanY(0)
        return true
      }
      if (e.sequence === "]") {
        setDiagramIndex((i) => Math.min(props.diagrams.length - 1, i + 1))
        setPanX(0)
        setPanY(0)
        return true
      }

      // Home/End for quick navigation
      if (e.name === "home") {
        setPanX(0)
        setPanY(0)
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
            Mermaid Viewer ({diagramIndex() + 1}/{props.diagrams.length})
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
            pan: ({panX()}, {panY()})
          </text>
        </box>
      </box>
    </Show>
  )
}

/**
 * Collect all renderable mermaid diagrams from message content.
 */
export function collectDiagrams(messages: Array<{ content: string }>): MermaidDiagram[] {
  const diagrams: MermaidDiagram[] = []
  const width = process.stdout.columns ?? 120

  for (const msg of messages) {
    const blocks = extractMermaidBlocks(msg.content)
    for (const block of blocks) {
      const rendered = renderMermaidToAscii(block.source, width)
      if (rendered !== undefined) {
        diagrams.push({ source: block.source, rendered })
      }
    }
  }

  return diagrams
}
