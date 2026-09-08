/**
 * Cell tool renderer.
 *
 * Collapsed: inner operation receipts + head/tail of the display value
 * Expanded: code, receipts, full display, bindings, and failure detail
 */

import { Option, Schema } from "effect"
import { For, Show, createMemo } from "solid-js"
import { formatHeadTail } from "@gent/core-internal/domain/output-buffer.js"
import { useTheme } from "../../theme/index"
import { ToolFrame } from "../tool-frame"
import { GutterText } from "../gutter-text"
import { decodeToolOutputOption, getString } from "../../utils/parse-tool-output"
import type { ToolRendererProps } from "./types"

const OperationReceipt = Schema.Struct({
  tool: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "incomplete"]),
  summary: Schema.String,
})

/** Success and failure results share one lenient shape; every field is optional. */
const CellOutputSchema = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  display: Schema.optional(Schema.String),
  bindings: Schema.optional(Schema.Array(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.String),
  stateLost: Schema.optional(Schema.Boolean),
})

interface OperationLine {
  readonly tool: string
  readonly outcome: "succeeded" | "failed" | "incomplete" | "running"
  readonly summary: string
}

const liveOutcome = (status: ToolRendererProps["toolCall"]["status"]): OperationLine["outcome"] => {
  if (status === "running") return "running"
  if (status === "error") return "failed"
  return "succeeded"
}

export function CellToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => decodeToolOutputOption(CellOutputSchema, props.toolCall.output))
  const code = createMemo(() => getString(props.toolCall.input, "code"))
  const codeLines = createMemo(() => code().split("\n"))
  const subtitle = createMemo(() => {
    const first = codeLines()[0] ?? ""
    if (first.length > 60) return `${first.slice(0, 60)}…`
    return first
  })

  // Live operations come from nested events; saved results carry receipts.
  const operations = createMemo((): ReadonlyArray<OperationLine> => {
    const live = Option.fromNullishOr(props.toolCall.operations)
    if (Option.isSome(live) && live.value.length > 0) {
      return live.value.map((call) => ({
        tool: call.toolName,
        outcome: liveOutcome(call.status),
        summary: call.summary ?? "",
      }))
    }
    return Option.match(
      decodeToolOutputOption(
        Schema.Struct({ operations: Schema.optional(Schema.Array(OperationReceipt)) }),
        props.toolCall.output,
      ),
      {
        onNone: () => [],
        onSome: (value) => value.operations ?? [],
      },
    )
  })

  const failure = createMemo(() =>
    data().pipe(
      Option.filter(
        (value) =>
          props.toolCall.status === "error" || Option.isSome(Option.fromNullishOr(value.message)),
      ),
      Option.flatMap((value) => Option.fromNullishOr(value.message ?? value.error)),
    ),
  )

  const displayLines = createMemo(() =>
    Option.match(data(), {
      onNone: () => [],
      onSome: (value) => (value.display ?? "").split("\n").filter((line) => line.length > 0),
    }),
  )
  const bindings = createMemo(() =>
    Option.match(data(), { onNone: () => [], onSome: (value) => value.bindings ?? [] }),
  )
  const truncated = createMemo(() =>
    Option.match(data(), { onNone: () => false, onSome: (value) => value.truncated ?? false }),
  )

  const outcomeGlyph = (outcome: OperationLine["outcome"]) => {
    if (outcome === "succeeded") return "✓"
    if (outcome === "failed") return "✕"
    if (outcome === "incomplete") return "?"
    return "⋯"
  }
  const outcomeColor = (outcome: OperationLine["outcome"]) => {
    if (outcome === "succeeded") return theme.success
    if (outcome === "running") return theme.textMuted
    return theme.error
  }

  const Operations = () => (
    <Show when={operations().length > 0}>
      <box flexDirection="column">
        <For each={operations()}>
          {(operation) => (
            <text>
              <span style={{ fg: outcomeColor(operation.outcome) }}>
                {outcomeGlyph(operation.outcome)}{" "}
              </span>
              <span style={{ fg: theme.text, bold: true }}>{operation.tool}</span>
              <Show when={operation.summary.length > 0}>
                <span style={{ fg: theme.textMuted }}> {operation.summary}</span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </Show>
  )

  const Failure = () => (
    <Show when={Option.getOrUndefined(failure())}>
      {(message) => (
        <text>
          <span style={{ fg: theme.error }}>{message()}</span>
        </text>
      )}
    </Show>
  )

  return (
    <ToolFrame
      title="cell"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <box flexDirection="column">
          <Operations />
          <Failure />
          <Show when={displayLines().length > 0}>
            <text style={{ fg: theme.textMuted }}>{formatHeadTail(displayLines(), 6)}</text>
          </Show>
        </box>
      }
    >
      <Show when={code().length > 0}>
        <GutterText lines={codeLines()} startLine={1} />
      </Show>
      <Operations />
      <Failure />
      <Show when={displayLines().length > 0}>
        <text style={{ fg: theme.text }}>{formatHeadTail(displayLines(), 100)}</text>
      </Show>
      <Show when={truncated()}>
        <text style={{ fg: theme.warning }}>display truncated</text>
      </Show>
      <Show when={bindings().length > 0}>
        <text>
          <span style={{ fg: theme.textMuted }}>bindings: </span>
          <span style={{ fg: theme.text }}>{bindings().join(", ")}</span>
        </text>
      </Show>
      <Show
        when={Option.getOrUndefined(
          data().pipe(Option.flatMap((value) => Option.fromNullishOr(value.diagnostics))),
        )}
      >
        {(diagnostics) => (
          <Show when={diagnostics().length > 0}>
            <text style={{ fg: theme.textMuted }}>
              {formatHeadTail(diagnostics().split("\n"), 20)}
            </text>
          </Show>
        )}
      </Show>
    </ToolFrame>
  )
}
