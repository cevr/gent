/** Tool status header with expandable, indented output. */

import { createContext, Show, useContext, createEffect, createSignal, type JSX } from "solid-js"
import { Option } from "effect"
import { useTheme } from "../theme/index"

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

const ToolFrameBodyContext = createContext(false)

/** The transcript row owns the header; registered renderers supply its body. */
export function ToolFrameBody(props: { children: JSX.Element }) {
  return (
    <ToolFrameBodyContext.Provider value={true}>{props.children}</ToolFrameBodyContext.Provider>
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
  const bodyOnly = useContext(ToolFrameBodyContext)
  const [localExpanded, setLocalExpanded] = createSignal(props.expanded)

  createEffect(() => {
    setLocalExpanded(props.expanded)
  })

  const statusIcon = () => {
    if (props.status === "running") return "⋯"
    if (props.status === "error") return "✕"
    return "●"
  }

  const statusColor = () => {
    if (props.status === "error") return theme.error
    return theme.textMuted
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
    <box flexDirection="column" marginBottom={1}>
      <Show when={!bodyOnly}>
        <box flexDirection="row" onMouseDown={() => setLocalExpanded((prev) => !prev)}>
          <text flexGrow={1} flexShrink={1}>
            <span style={{ fg: statusColor() }}>{statusIcon()} </span>
            <Show when={props.status === "error"}>
              <span style={{ fg: theme.error }}>failed </span>
            </Show>
            <span style={{ fg: theme.text, bold: true }}>{props.title}</span>
            <Show when={props.subtitle}>
              <Show
                when={props.subtitleHref}
                fallback={<span style={{ fg: theme.textMuted }}> {props.subtitle}</span>}
              >
                {(href) => (
                  <a href={href()}>
                    <span style={{ fg: theme.textMuted }}> {props.subtitle}</span>
                  </a>
                )}
              </Show>
            </Show>
          </text>
          <text flexShrink={0} wrapMode="none">
            <Show when={callIdentityLabel()}>
              {(identity) => <span style={{ fg: theme.textMuted }}> {identity()}</span>}
            </Show>
            <Show when={footer()}>
              <span style={{ fg: theme.textMuted }}> {footer()}</span>
            </Show>
            <span style={{ fg: theme.textMuted }}> {expandIndicator()}</span>
          </text>
        </box>
      </Show>

      <Show
        when={localExpanded()}
        fallback={
          <Show when={props.collapsedContent}>
            <box paddingLeft={2} flexDirection="column">
              {props.collapsedContent}
            </box>
          </Show>
        }
      >
        <Show when={props.children}>
          <box paddingLeft={2} flexDirection="column">
            {props.children}
          </box>
        </Show>
      </Show>
    </box>
  )
}
