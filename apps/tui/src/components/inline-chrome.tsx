import { Show, type JSX } from "solid-js"
import type { RGBA } from "@opentui/core"

export interface InlineChromeRootProps {
  children: JSX.Element
  paddingLeft?: number
  marginTop?: number
  marginBottom?: number
  onMouseDown?: (event: unknown) => void
}

function Root(props: InlineChromeRootProps) {
  return (
    <box
      flexDirection="column"
      paddingLeft={props.paddingLeft ?? 2}
      marginTop={props.marginTop}
      marginBottom={props.marginBottom}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  )
}

export interface InlineChromeHeaderProps {
  accentColor: RGBA
  leading?: JSX.Element
  title: JSX.Element | string
  subtitle?: string
  subtitleHref?: string
  trailing?: JSX.Element
  titleColor?: RGBA
  subtitleColor?: RGBA
}

function Header(props: InlineChromeHeaderProps) {
  return (
    <text>
      <span style={{ fg: props.accentColor }}>{"╭─["}</span>
      <Show when={props.leading}>
        {props.leading}
        <span style={{ fg: props.accentColor }}> </span>
      </Show>
      {typeof props.title === "string" ? (
        <span
          style={
            props.titleColor !== undefined ? { fg: props.titleColor, bold: true } : { bold: true }
          }
        >
          {props.title}
        </span>
      ) : (
        props.title
      )}
      <Show when={props.subtitle}>
        {props.subtitleHref !== undefined ? (
          <a href={props.subtitleHref}>
            <span
              style={props.subtitleColor !== undefined ? { fg: props.subtitleColor } : undefined}
            >
              {" "}
              {props.subtitle}
            </span>
          </a>
        ) : (
          <span style={props.subtitleColor !== undefined ? { fg: props.subtitleColor } : undefined}>
            {" "}
            {props.subtitle}
          </span>
        )}
      </Show>
      <span style={{ fg: props.accentColor }}>{"]"}</span>
      <Show when={props.trailing}>
        <span> </span>
        {props.trailing}
      </Show>
    </text>
  )
}

export interface InlineChromeBodyProps {
  accentColor: RGBA
  children: JSX.Element
}

function Body(props: InlineChromeBodyProps) {
  return (
    <box paddingLeft={2} flexDirection="column">
      <text>
        <span style={{ fg: props.accentColor }}>{"│"}</span>
      </text>
      {props.children}
    </box>
  )
}

export interface InlineChromeFooterProps {
  accentColor: RGBA
  trailing?: JSX.Element
}

function Footer(props: InlineChromeFooterProps) {
  return (
    <text>
      <span style={{ fg: props.accentColor }}>{"╰────"}</span>
      <Show when={props.trailing}>
        <span> </span>
        {props.trailing}
      </Show>
    </text>
  )
}

export const InlineChrome = {
  Root,
  Header,
  Body,
  Footer,
}
