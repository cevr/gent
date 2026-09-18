/**
 * ChromePanel — compound component for overlay panels with rounded chrome borders.
 *
 * `Root` floats at a position and size the caller gives it. The rows inside —
 * `Body`, `Section`, `Error`, `Footer` — are shared with the ruled
 * `PickerFrame` the docked panes draw.
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

import { Show, type JSX } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal"
import { useTheme } from "../theme"

// ── Root ──────────────────────────────────────────────────────────

interface ChromePanelRootProps {
  title?: string
  width: number
  height: number
  left: number
  top?: number
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

// ── Body ──────────────────────────────────────────────────────────

interface ChromePanelBodyProps {
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

interface ChromePanelFooterProps {
  children: JSX.Element
}

function ChromePanelFooter(props: ChromePanelFooterProps) {
  const { theme } = useTheme()

  return (
    <box flexShrink={0} paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>{props.children}</text>
    </box>
  )
}

// ── Section ───────────────────────────────────────────────────────

interface ChromePanelSectionProps {
  children: JSX.Element
}

function ChromePanelSection(props: ChromePanelSectionProps) {
  return (
    <box paddingLeft={1} paddingRight={1} flexShrink={0}>
      {props.children}
    </box>
  )
}

// ── Error ─────────────────────────────────────────────────────────

interface ChromePanelErrorProps {
  error?: string
}

function ChromePanelError(props: ChromePanelErrorProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.error}>
      {(error) => (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.error }}>{error()}</text>
        </box>
      )}
    </Show>
  )
}

// ── Success ───────────────────────────────────────────────────────

interface ChromePanelSuccessProps {
  message?: string
}

function ChromePanelSuccess(props: ChromePanelSuccessProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.message}>
      {(message) => (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.primary }}>✓ {message()}</text>
        </box>
      )}
    </Show>
  )
}

// ── Compound export ───────────────────────────────────────────────

export const ChromePanel = {
  Root: ChromePanelRoot,
  Body: ChromePanelBody,
  Section: ChromePanelSection,
  Footer: ChromePanelFooter,
  Error: ChromePanelError,
  Success: ChromePanelSuccess,
}
