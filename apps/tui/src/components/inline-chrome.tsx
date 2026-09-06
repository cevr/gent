import { Show, type JSX } from "solid-js"
import { Option, Schema } from "effect"
import type { MouseEvent, RGBA } from "@opentui/core"

export interface InlineChromeRootProps {
  children: JSX.Element
  paddingLeft?: number
  marginTop?: number
  marginBottom?: number
  onMouseDown?: (event: MouseEvent) => void
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
  const titleStyle = () => {
    const color = Option.fromNullishOr(props.titleColor)
    if (Option.isSome(color)) return { fg: color.value, bold: true }
    return { bold: true }
  }
  const subtitleStyle = () =>
    Option.fromNullishOr(props.subtitleColor).pipe(
      Option.map((color) => ({ fg: color })),
      Option.getOrUndefined,
    )
  const title = () => {
    const text = Schema.decodeUnknownOption(Schema.String)(props.title)
    if (Option.isSome(text)) return <span style={titleStyle()}>{text.value}</span>
    return props.title
  }
  const subtitle = () => {
    const href = Option.fromNullishOr(props.subtitleHref)
    if (Option.isSome(href)) {
      return (
        <a href={href.value}>
          <span style={subtitleStyle()}> {props.subtitle}</span>
        </a>
      )
    }
    return <span style={subtitleStyle()}> {props.subtitle}</span>
  }

  return (
    <text>
      <span style={{ fg: props.accentColor }}>{"╭─["}</span>
      <Show when={props.leading}>
        {props.leading}
        <span style={{ fg: props.accentColor }}> </span>
      </Show>
      {title()}
      <Show when={props.subtitle}>{subtitle()}</Show>
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
