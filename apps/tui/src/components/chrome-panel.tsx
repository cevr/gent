/**
 * ChromePanel — compound component for overlay panels with rounded chrome borders.
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
import { useTerminalDimensions } from "@opentui/solid"
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
        backgroundColor={theme.background}
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
  return (
    <box paddingLeft={1} paddingRight={1} flexShrink={0}>
      {props.children}
    </box>
  )
}

// ── Error ─────────────────────────────────────────────────────────

export interface ChromePanelErrorProps {
  error?: string | null
}

function ChromePanelError(props: ChromePanelErrorProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.error}>
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text style={{ fg: theme.error }}>{props.error}</text>
      </box>
    </Show>
  )
}

// ── Success ───────────────────────────────────────────────────────

export interface ChromePanelSuccessProps {
  message?: string | null
}

function ChromePanelSuccess(props: ChromePanelSuccessProps) {
  const { theme } = useTheme()

  return (
    <Show when={props.message}>
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text style={{ fg: theme.primary }}>✓ {props.message}</text>
      </box>
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
