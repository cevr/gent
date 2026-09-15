/**
 * ChromePanel — compound component for overlay panels with rounded chrome borders.
 *
 * Two roots: `Root` floats at a position and size the caller gives it;
 * `Dock` stretches under the composer and derives its height from the chrome
 * rows mounted inside it. `useDockGeometry` gives a docked pane the column
 * budgets its rows and sections may use.
 *
 * Usage:
 *   <ChromePanel.Root title="Commands" width={50} height={14} left={10} top={5}>
 *     <ChromePanel.Body>
 *       {scrollable content}
 *     </ChromePanel.Body>
 *     <ChromePanel.Footer>
 *       ↑↓ navigate · enter select · esc close
 *     </ChromePanel.Footer>
 *   </ChromePanel.Root>
 *
 * Root renders the positioned box with rounded borders, backdrop, and title.
 * Body is a flexGrow scrollbox for the main content.
 * Footer is a flexShrink text row at the bottom.
 */

import { Option } from "effect"
import { createContext, createSignal, onCleanup, Show, useContext, type JSX } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"

// ── Root ──────────────────────────────────────────────────────────

export interface ChromePanelRootProps {
  title?: string
  width: number
  height: number
  left: number
  top?: number
  bottom?: number
  children: JSX.Element
}

function ChromePanelRoot(props: ChromePanelRootProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <>
      {/* Transparent backdrop */}
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
        left={props.left}
        top={props.top}
        bottom={props.bottom}
        width={props.width}
        height={props.height}
        backgroundColor={theme.backgroundMenu}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={props.title}
      >
        {props.children}
      </box>
    </>
  )
}

// ── Dock ──────────────────────────────────────────────────────────

interface DockRegistry {
  readonly claimRow: () => void
}

const DockContext = createContext<Option.Option<DockRegistry>>(Option.none())

/**
 * A chrome row inside a Dock counts itself toward the pane height for as long
 * as it is mounted. Inside a floating `Root` there is no Dock and nothing to
 * count.
 */
const claimDockRow = (): void => {
  Option.match(useContext(DockContext), {
    onNone: () => {},
    onSome: (dock) => dock.claimRow(),
  })
}

/** Rows of list body a Dock keeps above its chrome. */
export const DOCK_BODY_ROWS = 10

/** The Dock's top and bottom border. */
const DOCK_BORDER_ROWS = 2

export interface DockGeometry {
  /** Terminal width minus the margin column each side. */
  readonly panelWidth: () => number
  /**
   * Columns a row may actually use: the pane border takes 2, the list body
   * pads 1 each side, and the row itself pads 1 more on the left. Budgeting
   * less than that wraps the line and breaks the one-row-per-item alignment.
   */
  readonly rowWidth: () => number
  /**
   * A `Section` pads 1 each side inside the 2 border columns and, unlike a
   * row, carries no extra left pad — one more column than {@link rowWidth}.
   */
  readonly sectionWidth: () => number
}

/**
 * The columns a docked pane can budget. The pane stretches to the width of
 * the container it is docked in and never sets one; truncation still needs a
 * number, and the terminal width minus the surrounding margin is what that
 * container actually gets.
 */
function useDockGeometry(): DockGeometry {
  const dimensions = useTerminalDimensions()
  const panelWidth = () => Math.max(0, dimensions().width - 2)
  return {
    panelWidth,
    rowWidth: () => Math.max(0, panelWidth() - 5),
    sectionWidth: () => Math.max(0, panelWidth() - 4),
  }
}

export interface ChromePanelDockProps {
  title: string
  /** Rows of list body above the chrome. Defaults to {@link DOCK_BODY_ROWS}. */
  bodyRows?: number
  children: JSX.Element
}

/**
 * A pane docked under the composer rather than floating. It stretches to the
 * docked container's width instead of shrinking to the longest row: a pane
 * that hugs its content reads as a floating box again.
 *
 * Its height is a fixed body plus the chrome rows actually mounted inside it
 * (`Section`, `Footer`, `Error`, `Success`, and the `SelectList` query row),
 * so a pane cannot budget one count while rendering another. The body is
 * fixed rather than a fraction of the terminal: the pane shares the screen
 * with the transcript, and a fraction of a short terminal collapses the list
 * to a line or two. The body scrolls within this, which is what gives the
 * pane its own scroll buffer.
 */
function ChromePanelDock(props: ChromePanelDockProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [chromeRows, setChromeRows] = createSignal(0)
  const registry: DockRegistry = {
    claimRow: () => {
      setChromeRows((rows) => rows + 1)
      onCleanup(() => setChromeRows((rows) => rows - 1))
    },
  }
  const bodyRows = () =>
    Option.getOrElse(Option.fromNullishOr(props.bodyRows), () => DOCK_BODY_ROWS)
  const height = () => {
    const chrome = DOCK_BORDER_ROWS + chromeRows()
    return Math.max(chrome + 1, Math.min(bodyRows() + chrome, dimensions().height - 4))
  }

  return (
    <DockContext.Provider value={Option.some(registry)}>
      <box
        height={height()}
        alignSelf="stretch"
        marginLeft={1}
        marginRight={1}
        backgroundColor={theme.backgroundMenu}
        border
        borderStyle="rounded"
        borderColor={theme.borderSubtle}
        flexDirection="column"
        title={props.title}
      >
        {props.children}
      </box>
    </DockContext.Provider>
  )
}

// ── Body ──────────────────────────────────────────────────────────

export interface ChromePanelBodyProps {
  ref?: (el: ScrollBoxRenderable) => void
  paddingLeft?: number
  paddingRight?: number
  children: JSX.Element
}

function ChromePanelBody(props: ChromePanelBodyProps) {
  return (
    <scrollbox
      ref={props.ref}
      flexGrow={1}
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
      paddingLeft={props.paddingLeft ?? 1}
      paddingRight={props.paddingRight ?? 1}
    >
      {props.children}
    </scrollbox>
  )
}

// ── Footer ────────────────────────────────────────────────────────

export interface ChromePanelFooterProps {
  children: JSX.Element
}

function ChromePanelFooter(props: ChromePanelFooterProps) {
  const { theme } = useTheme()
  claimDockRow()

  return (
    <box flexShrink={0} paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>{props.children}</text>
    </box>
  )
}

// ── Section ───────────────────────────────────────────────────────

export interface ChromePanelSectionProps {
  children: JSX.Element
}

function ChromePanelSection(props: ChromePanelSectionProps) {
  claimDockRow()
  return (
    <box paddingLeft={1} paddingRight={1} flexShrink={0}>
      {props.children}
    </box>
  )
}

// ── Error ─────────────────────────────────────────────────────────

export interface ChromePanelErrorProps {
  error?: string
}

function ChromePanelError(props: ChromePanelErrorProps) {
  const { theme } = useTheme()

  // The row only exists while an error shows, so it claims its Dock row from
  // inside the branch and gives it back when the error clears.
  return (
    <Show when={props.error}>
      {(error) => {
        claimDockRow()
        return (
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.error }}>{error()}</text>
          </box>
        )
      }}
    </Show>
  )
}

// ── Success ───────────────────────────────────────────────────────

export interface ChromePanelSuccessProps {
  message?: string
}

function ChromePanelSuccess(props: ChromePanelSuccessProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.message}>
      {(message) => {
        claimDockRow()
        return (
          <box paddingLeft={1} paddingRight={1} flexShrink={0}>
            <text style={{ fg: theme.primary }}>✓ {message()}</text>
          </box>
        )
      }}
    </Show>
  )
}

// ── Compound export ───────────────────────────────────────────────

export const ChromePanel = {
  Root: ChromePanelRoot,
  Dock: ChromePanelDock,
  useDockGeometry,
  Body: ChromePanelBody,
  Section: ChromePanelSection,
  Footer: ChromePanelFooter,
  Error: ChromePanelError,
  Success: ChromePanelSuccess,
}
