import { type AsciiRenderOptions, renderMermaidASCII } from "beautiful-mermaid"
import { Effect, Match, Option, Schema } from "effect"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useScopedKeyboard, useTerminalDimensions } from "./terminal"
import { useTheme } from "./theme"

// ── mermaid rendering ───────────────────────────────────────────────────────

/**
 * Mermaid diagram extraction and ASCII rendering.
 *
 * Detects ```mermaid fenced blocks in markdown, renders them
 * to ASCII art via beautiful-mermaid, and caches results.
 */

interface MermaidBlock {
  /** Original mermaid source code */
  source: string
  /** Start index in the original text */
  startIndex: number
  /** End index in the original text */
  endIndex: number
}

/**
 * Extract mermaid fenced code blocks from markdown text.
 * Looks for ```mermaid ... ``` patterns.
 */
export function extractMermaidBlocks(text: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = []
  const regex = /```mermaid\s*\n([\s\S]*?)```/g
  let match = Option.fromNullishOr(regex.exec(text))

  while (Option.isSome(match)) {
    const result = match.value
    const source = Option.map(Option.fromNullishOr(result[1]), (value) => value.trim())
    if (Option.isSome(source) && source.value.length > 0) {
      blocks.push({
        source: source.value,
        startIndex: result.index,
        endIndex: result.index + result[0].length,
      })
    }
    match = Option.fromNullishOr(regex.exec(text))
  }

  return blocks
}

// Adaptive density presets — from roomy to tightest

interface Preset {
  name: string
  paddingX: number
  paddingY: number
  boxBorderPadding: number
}

const PRESETS: readonly Preset[] = [
  { name: "roomy", paddingX: 8, paddingY: 5, boxBorderPadding: 2 },
  { name: "normal", paddingX: 5, paddingY: 3, boxBorderPadding: 1 },
  { name: "compact", paddingX: 3, paddingY: 2, boxBorderPadding: 1 },
  { name: "tight", paddingX: 2, paddingY: 1, boxBorderPadding: 1 },
  { name: "tightest", paddingX: 1, paddingY: 1, boxBorderPadding: 0 },
]
const TIGHTEST_PRESET: Preset = { name: "tightest", paddingX: 1, paddingY: 1, boxBorderPadding: 0 }

function getMaxLineWidth(text: string): number {
  let max = 0
  for (const line of text.split("\n")) {
    // Strip ANSI escape codes for accurate width
    // eslint-disable-next-line no-control-regex -- ANSI escape stripping needs literal control-byte patterns
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "")
    if (stripped.length > max) max = stripped.length
  }
  return max
}

/**
 * Try each preset from roomy → tightest. Pick the first whose
 * rendered output fits within maxWidth. Falls back to tightest.
 */
function pickBestPreset(source: string, maxWidth: number): AsciiRenderOptions {
  for (const preset of PRESETS) {
    const rendered = Effect.runSync(
      Effect.option(
        Effect.try(() =>
          renderMermaidASCII(source, {
            paddingX: preset.paddingX,
            paddingY: preset.paddingY,
            boxBorderPadding: preset.boxBorderPadding,
          }),
        ),
      ),
    )
    if (Option.isSome(rendered)) {
      const ascii = Option.fromNullishOr(rendered.value)
      if (Option.isSome(ascii) && ascii.value.length > 0) {
        const width = getMaxLineWidth(ascii.value)
        if (width <= maxWidth) {
          return {
            paddingX: preset.paddingX,
            paddingY: preset.paddingY,
            boxBorderPadding: preset.boxBorderPadding,
          }
        }
      }
    }
  }
  // Return tightest as fallback
  return {
    paddingX: TIGHTEST_PRESET.paddingX,
    paddingY: TIGHTEST_PRESET.paddingY,
    boxBorderPadding: TIGHTEST_PRESET.boxBorderPadding,
  }
}

// LRU cache for rendered diagrams — keyed by source + width. The cache is
// bounded by `CACHE_MAX` so memory stays bounded; the key is structured
// JSON so a source string that happens to contain a `:<width>` suffix
// cannot collide with a separate `(source, width)` call.
const CACHE_MAX = 20
const renderCache = new Map<string, string>()

const encodeCacheKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ source: Schema.String, maxWidth: Schema.optional(Schema.Finite) }),
  ),
)

const cacheKey = (source: string, maxWidth: number): string => encodeCacheKey({ source, maxWidth })

/**
 * Render a mermaid diagram to ASCII art.
 * When maxWidth is provided, uses adaptive preset selection.
 * Results are cached (LRU).
 */
function renderMermaidToAscii(source: string, maxWidth: number): Option.Option<string> {
  const key = cacheKey(source, maxWidth)
  const cached = Option.fromNullishOr(renderCache.get(key))
  if (Option.isSome(cached)) {
    // Move to end for LRU
    renderCache.delete(key)
    renderCache.set(key, cached.value)
    return cached
  }

  const options = pickBestPreset(source, maxWidth)
  const rendered = Effect.runSync(
    Effect.option(Effect.try(() => renderMermaidASCII(source, options))),
  )
  if (Option.isNone(rendered)) return Option.none()
  const ascii = Option.fromNullishOr(rendered.value)
  if (Option.isNone(ascii) || ascii.value.length === 0) return Option.none()

  // Evict oldest if at capacity
  if (renderCache.size >= CACHE_MAX) {
    const oldest = renderCache.keys().next()
    if (!oldest.done) {
      renderCache.delete(oldest.value)
    }
  }
  renderCache.set(key, ascii.value)
  return ascii
}

/**
 * Replace mermaid blocks in text with rendered ASCII art.
 * Falls back to the original code block if rendering fails.
 */
export function replaceMermaidBlocks(text: string, maxWidth: number): string {
  const blocks = extractMermaidBlocks(text)
  if (blocks.length === 0) return text

  let result = ""
  let lastEnd = 0

  for (const block of blocks) {
    result += text.slice(lastEnd, block.startIndex)

    const ascii = renderMermaidToAscii(block.source, maxWidth)
    if (Option.isSome(ascii)) {
      result += ascii.value
    } else {
      // Fallback: show original code block
      result += text.slice(block.startIndex, block.endIndex)
    }

    lastEnd = block.endIndex
  }

  result += text.slice(lastEnd)
  return result
}

// ── viewer state ────────────────────────────────────────────────────────────

export interface MermaidViewerState {
  readonly diagramIndex: number
  readonly panX: number
  readonly panY: number
}

export const MermaidViewerState = {
  initial: (): MermaidViewerState => ({
    diagramIndex: 0,
    panX: 0,
    panY: 0,
  }),
}

const MermaidViewerEvent = Schema.TaggedUnion({
  Open: {},
  PanLeft: { step: Schema.Finite },
  PanRight: { step: Schema.Finite },
  PanUp: { step: Schema.Finite },
  PanDown: { step: Schema.Finite },
  PrevDiagram: {},
  NextDiagram: { diagramCount: Schema.Finite },
  ResetPan: {},
})
type MermaidViewerEvent = Schema.Schema.Type<typeof MermaidViewerEvent>

const resetPan = (state: MermaidViewerState): MermaidViewerState => ({
  ...state,
  panX: 0,
  panY: 0,
})

export function transitionMermaidViewer(
  state: MermaidViewerState,
  event: MermaidViewerEvent,
): MermaidViewerState {
  const transitionEvent: (event: MermaidViewerEvent) => MermaidViewerState =
    Match.type<MermaidViewerEvent>().pipe(
      Match.tagsExhaustive({
        Open: () => MermaidViewerState.initial(),
        PanLeft: (event) => ({
          ...state,
          panX: Math.max(0, state.panX - event.step),
        }),
        PanRight: (event) => ({
          ...state,
          panX: state.panX + event.step,
        }),
        PanUp: (event) => ({
          ...state,
          panY: Math.max(0, state.panY - event.step),
        }),
        PanDown: (event) => ({
          ...state,
          panY: state.panY + event.step,
        }),
        PrevDiagram: () =>
          resetPan({
            ...state,
            diagramIndex: Math.max(0, state.diagramIndex - 1),
          }),
        NextDiagram: (event) =>
          resetPan({
            ...state,
            diagramIndex: Math.min(event.diagramCount - 1, state.diagramIndex + 1),
          }),
        ResetPan: () => resetPan(state),
      }),
    )
  return transitionEvent(event)
}

// ── viewer ──────────────────────────────────────────────────────────────────

/**
 * Full-screen pannable mermaid diagram viewer overlay.
 * Supports arrow key panning and [/] for diagram cycling.
 */

interface MermaidDiagram {
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
    setState(transitionMermaidViewer(state(), MermaidViewerEvent.cases.Open.make({})))
  })

  const currentDiagram = createMemo(() => {
    const idx = state().diagramIndex
    return Option.fromNullishOr(props.diagrams[idx])
  })

  const visibleContent = createMemo(() => {
    const diagram = currentDiagram()
    if (Option.isNone(diagram)) return ""

    const lines = diagram.value.rendered.split("\n")
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
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.cases.PanLeft.make({ step: PAN_STEP_X }),
          ),
        )
        return true
      }
      if (e.name === "right") {
        setState((current) =>
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.cases.PanRight.make({ step: PAN_STEP_X }),
          ),
        )
        return true
      }
      if (e.name === "up") {
        setState((current) =>
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.cases.PanUp.make({ step: PAN_STEP_Y }),
          ),
        )
        return true
      }
      if (e.name === "down") {
        setState((current) =>
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.cases.PanDown.make({ step: PAN_STEP_Y }),
          ),
        )
        return true
      }

      // Diagram cycling
      if (e.sequence === "[") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.cases.PrevDiagram.make({})),
        )
        return true
      }
      if (e.sequence === "]") {
        setState((current) =>
          transitionMermaidViewer(
            current,
            MermaidViewerEvent.cases.NextDiagram.make({
              diagramCount: props.diagrams.length,
            }),
          ),
        )
        return true
      }

      // Home/End for quick navigation
      if (e.name === "home") {
        setState((current) =>
          transitionMermaidViewer(current, MermaidViewerEvent.cases.ResetPan.make({})),
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
  let renderWidth = 120
  if (width > 0) renderWidth = width

  for (const msg of messages) {
    const blocks = extractMermaidBlocks(msg.content)
    for (const block of blocks) {
      const rendered = renderMermaidToAscii(block.source, renderWidth)
      if (Option.isSome(rendered)) {
        diagrams.push({ source: block.source, rendered: rendered.value })
      }
    }
  }

  return diagrams
}
