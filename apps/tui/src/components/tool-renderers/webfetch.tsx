/**
 * Webfetch tool renderer.
 *
 * Collapsed: URL + title
 * Expanded: full markdown content
 */

import { Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import type { ToolRendererProps } from "./types"

interface WebfetchOutput {
  url: string
  content: string
  title?: string
}

function parseWebfetchOutput(output: string | undefined): WebfetchOutput | null {
  if (output === undefined) return null
  try {
    const parsed = JSON.parse(output) as {
      url?: unknown
      content?: unknown
      title?: unknown
    } | null
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.url === "string" &&
      typeof parsed.content === "string"
    ) {
      return {
        url: parsed.url,
        content: parsed.content,
        title: typeof parsed.title === "string" ? parsed.title : undefined,
      }
    }
  } catch {
    // ignore
  }
  return null
}

function getUrl(input: unknown): string {
  if (input !== null && typeof input === "object" && "url" in input) {
    return typeof (input as { url: unknown }).url === "string" ? (input as { url: string }).url : ""
  }
  return ""
}

export function WebfetchToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseWebfetchOutput(props.toolCall.output))
  const url = createMemo(() => getUrl(props.toolCall.input))

  const contentLines = createMemo(() => {
    const d = data()
    if (d === null) return 0
    return d.content.split("\n").length
  })

  return (
    <ToolFrame
      title="webfetch"
      subtitle={url()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column">
              <Show when={d().title}>
                <text style={{ fg: theme.info }}>{d().title}</text>
              </Show>
              <text style={{ fg: theme.textMuted }}>{contentLines()} lines of content</text>
            </box>
          )}
        </Show>
      }
    >
      <Show when={data()}>
        {(d) => (
          <box flexDirection="column">
            <Show when={d().title}>
              <text>
                <span style={{ fg: theme.info, bold: true }}>{d().title}</span>
              </text>
            </Show>
            <text style={{ fg: theme.textMuted }}>{d().url}</text>
            <box marginTop={1}>
              <text style={{ fg: theme.text }}>{d().content}</text>
            </box>
          </box>
        )}
      </Show>
    </ToolFrame>
  )
}
