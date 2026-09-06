/**
 * ToolFrame — inline chrome wrapper for tool output.
 *
 * Provides visual framing with:
 * - Status icon (spinner/check/error)
 * - Tool name + input summary
 * - Optional duration
 * - Expandable content area
 *
 * Layout:
 *   ╭─[tool-name input-summary]
 *   │ content...
 *   ╰── 1.2s
 */

import { createContext, Show, useContext, createEffect, createSignal, type JSX } from "solid-js"
import { Option } from "effect"
import { useTheme } from "../theme/index"
import { InlineChrome } from "./inline-chrome"

const ToolCallIdentityContext = createContext<Option.Option<string>>(Option.none())

export interface ToolCallIdentityProviderProps {
  id: string
  children: JSX.Element
}

export function ToolCallIdentityProvider(props: ToolCallIdentityProviderProps) {
  return (
    <ToolCallIdentityContext.Provider value={Option.some(props.id)}>
      {props.children}
    </ToolCallIdentityContext.Provider>
  )
}

export interface ToolFrameProps {
  /** Tool display name */
  title: string
  /** Input summary shown after title */
  subtitle?: string
  /** OSC8 hyperlink href for the subtitle */
  subtitleHref?: string
  /** Status: drives icon */
  status: "running" | "completed" | "error"
  /** Duration in ms */
  durationMs?: number
  /** Whether box content is expanded */
  expanded: boolean
  /** Box content */
  children?: JSX.Element
  /** Collapsed summary (shown when not expanded) */
  collapsedContent?: JSX.Element
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = Math.round(secs % 60)
  return `${mins}m ${remainingSecs}s`
}

export function formatToolCallIdentity(identity: string): string {
  if (identity.length <= 14) return identity
  return `${identity.slice(0, 8)}…${identity.slice(-4)}`
}

export function ToolFrame(props: ToolFrameProps) {
  const { theme } = useTheme()
  const callIdentity = useContext(ToolCallIdentityContext)
  const [localExpanded, setLocalExpanded] = createSignal(props.expanded)

  createEffect(() => {
    setLocalExpanded(props.expanded)
  })

  const statusIcon = () => {
    if (props.status === "running") return "⋯"
    if (props.status === "error") return "✕"
    return "✓"
  }

  const statusColor = () => {
    if (props.status === "running") return theme.warning
    if (props.status === "error") return theme.error
    return theme.success
  }

  const footer = () =>
    Option.fromNullishOr(props.durationMs).pipe(Option.map(formatDuration), Option.getOrUndefined)

  const expandIndicator = () => {
    if (localExpanded()) return "▾"
    return "▸"
  }

  const callIdentityLabel = () =>
    Option.map(callIdentity, (identity) => `#${formatToolCallIdentity(identity)}`).pipe(
      Option.getOrUndefined,
    )

  return (
    <InlineChrome.Root paddingLeft={2} onMouseDown={() => setLocalExpanded((prev) => !prev)}>
      <InlineChrome.Header
        accentColor={statusColor()}
        leading={
          <>
            <span style={{ fg: statusColor() }}>{statusIcon()}</span>
            <Show when={props.status === "error"}>
              <span style={{ fg: theme.error }}> failed</span>
            </Show>
          </>
        }
        title={<span style={{ fg: theme.info, bold: true }}>{props.title}</span>}
        subtitle={props.subtitle}
        subtitleHref={props.subtitleHref}
        subtitleColor={theme.textMuted}
        trailing={
          <>
            <Show when={callIdentityLabel()}>
              {(identity) => <span style={{ fg: theme.textMuted }}>{identity()} </span>}
            </Show>
            <Show when={footer()}>
              <span style={{ fg: theme.textMuted }}>{footer()} </span>
            </Show>
            <span style={{ fg: theme.textMuted }}>{expandIndicator()}</span>
          </>
        }
      />

      <Show
        when={localExpanded()}
        fallback={
          <Show when={props.collapsedContent}>
            <InlineChrome.Body accentColor={statusColor()}>
              {props.collapsedContent}
            </InlineChrome.Body>
          </Show>
        }
      >
        <Show when={props.children}>
          <InlineChrome.Body accentColor={statusColor()}>{props.children}</InlineChrome.Body>
        </Show>
      </Show>

      <InlineChrome.Footer accentColor={statusColor()} />
    </InlineChrome.Root>
  )
}
