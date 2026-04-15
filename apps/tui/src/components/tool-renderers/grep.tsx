/**
 * Grep tool renderer.
 *
 * Collapsed: pattern + match count + first 3 files
 * Expanded: all matches with line numbers per file
 */

import { Schema } from "effect"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { truncatePath } from "../message-list-utils"
import { decodeToolOutput, getString } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

interface GrepMatch {
  readonly file: string
  readonly line: number
  readonly content: string
}

interface GrepOutput {
  readonly matches: GrepMatch[]
  readonly truncated: boolean
}

const GrepMatchSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  content: Schema.String,
})

const GrepOutputSchema = Schema.Struct({
  matches: Schema.Array(GrepMatchSchema),
  truncated: Schema.optional(Schema.Boolean),
})

function parseGrepOutput(output: string | undefined): GrepOutput | undefined {
  const d = decodeToolOutput(GrepOutputSchema, output)
  if (d === undefined) return undefined
  return { matches: d["matches"] as GrepMatch[], truncated: d["truncated"] ?? false }
}

function getPattern(input: unknown): string {
  return getString(input, "pattern")
}

/** Group matches by file */
function groupByFile(matches: GrepMatch[]): Map<string, GrepMatch[]> {
  const groups = new Map<string, GrepMatch[]>()
  for (const m of matches) {
    const existing = groups.get(m.file)
    if (existing !== undefined) {
      existing.push(m)
    } else {
      groups.set(m.file, [m])
    }
  }
  return groups
}

export function GrepToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseGrepOutput(props.toolCall.output))
  const pattern = createMemo(() => getPattern(props.toolCall.input))
  const grouped = createMemo(() => {
    const d = data()
    if (d === undefined) return new Map<string, GrepMatch[]>()
    return groupByFile(d.matches)
  })

  const fileNames = createMemo(() => [...grouped().keys()])
  const collapsedFiles = createMemo(() => fileNames().slice(0, 3))

  return (
    <ToolFrame
      title="grep"
      subtitle={pattern()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.success, bold: true }}>{d().matches.length}</span>
                <span style={{ fg: theme.textMuted }}> matches in {fileNames().length} files</span>
                <Show when={d().truncated}>
                  <span style={{ fg: theme.warning }}> (truncated)</span>
                </Show>
              </text>
              <For each={collapsedFiles()}>
                {(file) => <text style={{ fg: theme.textMuted }}> {truncatePath(file)}</text>}
              </For>
              <Show when={fileNames().length > 3}>
                <text style={{ fg: theme.textMuted }}>
                  {" "}
                  ... +{fileNames().length - 3} more files
                </text>
              </Show>
            </box>
          )}
        </Show>
      }
    >
      <Show when={data()}>
        <box flexDirection="column">
          <For each={fileNames()}>
            {(file) => {
              const matches = () => grouped().get(file) ?? []
              return (
                <box flexDirection="column" marginBottom={1}>
                  <text>
                    <span style={{ fg: theme.info, bold: true }}>{truncatePath(file, 60)}</span>
                  </text>
                  <For each={matches()}>
                    {(m) => (
                      <text>
                        <span style={{ fg: theme.textMuted }}>{String(m.line).padStart(4)} │ </span>
                        <span style={{ fg: theme.text }}>{m.content}</span>
                      </text>
                    )}
                  </For>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </ToolFrame>
  )
}
