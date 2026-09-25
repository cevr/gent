import type { JSX } from "@opentui/solid"
import { createPatch } from "diff"
import { Match, Option, Schema } from "effect"
import { createContext, createMemo, For, type JSX as SolidJSX, Show, useContext } from "solid-js"
import { buildSyntaxStyle, useTheme } from "./theme"
import { GutterText, ToolCallIdentityProvider, ToolFrame } from "./ui"
import {
  formatHeadTail,
  headTail,
  lineCount,
  type OutputCut,
  splitLines,
} from "@gent/core/protocol"
import {
  type ActivityOperation,
  CellOperationReceipts,
  decodeToolOutput,
  countNoun,
  decodeToolOutputOption,
  describeCellCode,
  fileUrl,
  formatGenericToolDetail,
  formatGenericToolInput,
  formatGenericToolText,
  formatOperationLabels,
  formatToolInput,
  getString,
  isAbsPath,
  parseBashOutput,
  plural,
  shortId,
  toolArgSummary,
  type ToolInput,
  truncatePath,
} from "./utils"

// ── renderer types ──────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  toolName: string
  status: "running" | "completed" | "error"
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  input: unknown | undefined
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  summary: string | undefined
  // eslint-disable-next-line effect/noNullish -- Renderer payloads preserve omitted tool fields from the event stream.
  output: string | undefined
  /**
   * Inner calls a cell admitted, from the live feed or, after a reload, from
   * the branch's stored tool receipts. Absent on a fork, whose saved result's
   * receipts are the fallback.
   */
  operations?: ToolCall[]
  /** Envelope time of the started receipt. Live feed only. */
  startedAt?: number
  /** Wall time from the started receipt to the terminal receipt. */
  durationMs?: number
  /** Where a reloaded op's output strings were cut to fit the snapshot. */
  cuts?: ReadonlyArray<OutputCut>
}

export interface ToolRendererProps {
  toolCall: ToolCall
  expanded: boolean
}

export type ToolRenderer = (props: ToolRendererProps) => JSX.Element

// ── registered renderer lookup ──────────────────────────────────────────────

/** The registered tool renderers by tool name. The extension host provides them. */
const ToolRenderersContext = createContext<() => ReadonlyMap<string, ToolRenderer>>(() => new Map())
export const ToolRenderersProvider = ToolRenderersContext.Provider
export const useToolRenderers = () => useContext(ToolRenderersContext)

/**
 * The one renderer lookup, for a transcript call and for an op a cell admitted:
 * the renderer registered for the call's tool name, else `fallback`.
 */
export function RegisteredToolCall(props: {
  toolCall: ToolCall
  expanded: boolean
  fallback: JSX.Element
}) {
  const renderers = useToolRenderers()
  const renderer = () => renderers().get(props.toolCall.toolName.toLowerCase())
  return (
    <Show when={renderer()} fallback={props.fallback}>
      {(Renderer) => {
        const Component = Renderer()
        return (
          <ToolCallIdentityProvider id={props.toolCall.id}>
            <Component toolCall={props.toolCall} expanded={props.expanded} />
          </ToolCallIdentityProvider>
        )
      }}
    </Show>
  )
}

// ── diff helpers ────────────────────────────────────────────────────────────

/**
 * Detect filetype from path extension
 */
// eslint-disable-next-line effect/noNullish -- unknown extensions have no syntax highlighter.
export function getFiletype(path: string): string | undefined {
  const ext = Option.fromNullishOr(path.split(".").pop()).pipe(
    Option.map((value) => value.toLowerCase()),
  )
  const map = new Map([
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["js", "javascript"],
    ["jsx", "jsx"],
    ["py", "python"],
    ["rs", "rust"],
    ["go", "go"],
    ["md", "markdown"],
    ["json", "json"],
    ["yaml", "yaml"],
    ["yml", "yaml"],
    ["toml", "toml"],
  ])
  return Option.getOrUndefined(
    ext.pipe(Option.flatMap((key) => Option.fromNullishOr(map.get(key)))),
  )
}

/**
 * Count lines added/removed from old and new strings
 */
interface DiffLineCount {
  readonly added: number
  readonly removed: number
}

export function countDiffLines(oldStr: string, newStr: string): DiffLineCount {
  const oldLines = lineCount(oldStr)
  const newLines = lineCount(newStr)
  if (newLines > oldLines) {
    return { added: newLines - oldLines, removed: 0 }
  } else if (oldLines > newLines) {
    return { added: 0, removed: oldLines - newLines }
  }
  // Same line count - count actual changed lines
  const oldArr = oldStr.split("\n")
  const newArr = newStr.split("\n")
  let changed = 0
  for (let i = 0; i < oldArr.length; i++) {
    if (oldArr[i] !== newArr[i]) changed++
  }
  return { added: changed, removed: changed }
}

interface EditDiffResult {
  diff: string
  // eslint-disable-next-line effect/noNullish -- syntax highlighting has no filetype for unknown extensions.
  filetype: string | undefined
  added: number
  removed: number
}

/**
 * Generate unified diff from edit input for <diff> component
 */
const decodeEditInput = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
type EditInput = Parameters<typeof decodeEditInput>[0]

export function getEditUnifiedDiff(input: EditInput) {
  const result = Option.gen(function* () {
    const record = yield* decodeEditInput(input)
    const path = yield* decodeString(record["path"])
    const oldStr = yield* decodeString(record["oldString"]).pipe(
      Option.orElse(() => decodeString(record["old_string"])),
    )
    const newStr = yield* decodeString(record["newString"]).pipe(
      Option.orElse(() => decodeString(record["new_string"])),
    )
    const diff = createPatch(path, oldStr, newStr)
    const filetype = getFiletype(path)
    const { added, removed } = countDiffLines(oldStr, newStr)
    return { diff, filetype, added, removed } satisfies EditDiffResult
  })
  return Option.getOrNull(result)
}

// ── generic renderer ────────────────────────────────────────────────────────

export function GenericToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()
  const summaryText = () => formatGenericToolText(props.toolCall.summary)
  const outputText = () => formatGenericToolText(props.toolCall.output)

  const isTruncated = () => {
    const output = outputText()
    const summary = summaryText()
    return output && summary && output.length > summary.length
  }

  const remainingLines = () => {
    const output = outputText() ?? ""
    const summary = summaryText() ?? ""
    return Math.max(0, lineCount(output) - lineCount(summary))
  }

  const hasOutput = () => summaryText() || outputText()
  const subtitle = () => formatToolInput(props.toolCall.toolName, props.toolCall.input)

  return (
    <ToolFrame
      title={props.toolCall.toolName}
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={hasOutput()}>
          <box flexDirection="column">
            <Show when={summaryText()}>
              <text style={{ fg: theme.textMuted }}>{summaryText()}</text>
            </Show>
            <Show when={isTruncated()}>
              <text style={{ fg: theme.textMuted }}>
                ... ({remainingLines()} more lines, <span style={{ fg: theme.info }}>ctrl+o</span>{" "}
                to expand)
              </text>
            </Show>
          </box>
        </Show>
      }
    >
      <text style={{ fg: theme.textMuted }}>Input</text>
      <text style={{ fg: theme.text }}>{formatGenericToolInput(props.toolCall.input)}</text>
      <text style={{ fg: theme.textMuted }}>Output</text>
      <text style={{ fg: theme.text }}>
        {formatGenericToolDetail(props.toolCall.output ?? props.toolCall.summary ?? "(none)")}
      </text>
    </ToolFrame>
  )
}

// ── bash renderer ───────────────────────────────────────────────────────────

/**
 * Bash tool renderer.
 *
 * Collapsed: exit code + head-3/tail-3 of stdout
 * Expanded: head-100/tail-100 of the stored output
 */

// ── output rows ─────────────────────────────────────────────────────────────

/**
 * A line of a tool output, numbered as in the whole output, or a run left
 * out: whole lines, or the characters of a cut inside a line. A line a cut
 * left only part of names the side it lost: `end` for a head line that stops
 * early, `start` for a tail line that starts late.
 */
type WindowedLine =
  | { _tag: "line"; text: string; lineNum: number; part?: "end" | "start" }
  | { _tag: "elision"; count: number; unit: "lines" | "chars" }

/** A line's text as drawn: a part of a line is marked on the side it lost. */
const drawnText = (row: Extract<WindowedLine, { _tag: "line" }>): string => {
  if (row.part === "end") return `${row.text} …`
  if (row.part === "start") return `… ${row.text}`
  return row.text
}

interface OutputRows {
  readonly rows: ReadonlyArray<WindowedLine>
  /** Lines in the whole output, a final newline not counted. */
  readonly total: number
}

type TextCut = Extract<OutputCut, { readonly _tag: "Text" }>
type ItemsCut = Extract<OutputCut, { readonly _tag: "Items" }>

/** The text cut recorded for an output field; `None` names a plain-text output. */
const textCutFor = (call: ToolCall, field: Option.Option<string>): Option.Option<TextCut> =>
  Option.fromNullishOr(
    (call.cuts ?? []).find(
      (cut): cut is TextCut => cut._tag === "Text" && Option.getOrUndefined(field) === cut.field,
    ),
  )

/** The items cut recorded for an array output field. */
const itemsCutFor = (call: ToolCall, field: string): Option.Option<ItemsCut> =>
  Option.fromNullishOr(
    (call.cuts ?? []).find((cut): cut is ItemsCut => cut._tag === "Items" && cut.field === field),
  )

/** The one truncation marker, `formatHeadTail`'s spelling: `... [12 lines truncated] ...`. */
const truncationMarker = (counted: string): string => `... [${counted} truncated] ...`

/**
 * An output string as numbered rows. A cut string's excerpt is its head lines,
 * one marker line, then its tail lines from `cut.tailLine`; the marker becomes
 * one elision of the lines left out, so counts and numbers match the whole
 * output, before or after a reload. A cut inside one line draws that line
 * once, its two ends joined by a marker of the characters left out.
 */
const numberedLine = (text: string, lineNum: number): WindowedLine => ({
  _tag: "line",
  text,
  lineNum,
})

const outputRows = (text: string, cut: Option.Option<TextCut>): OutputRows =>
  Option.match(cut, {
    onNone: () => {
      const rows = splitLines(text).map((part, index) => numberedLine(part, index + 1))
      return { rows, total: rows.length }
    },
    onSome: (textCut) => cutRows(text, textCut),
  })

/**
 * A cut string's rows. The excerpt is split as any text is, so its lines are
 * the head's, the marker's, then the `lines - tailLine + 1` tail lines; a head
 * or tail that kept nothing is absent from it.
 */
const cutRows = (text: string, cut: TextCut): OutputRows => {
  const { lines, tailLine, chars } = cut
  const parts = splitLines(text)
  const tailCount = lines - tailLine + 1
  const marker = parts.length - tailCount - 1
  const head = parts.slice(0, Math.max(0, marker))
  const tail = parts.slice(marker + 1)
  const headRows = head.map((part, index) => numberedLine(part, index + 1))
  const tailRows = tail.map((part, index) => numberedLine(part, tailLine + index))
  if (tailLine === head.length) {
    const joined = numberedLine(
      `${head.at(-1) ?? ""} ${truncationMarker(plural(chars, "char"))} ${tail[0] ?? ""}`,
      tailLine,
    )
    return { rows: [...headRows.slice(0, -1), joined, ...tailRows.slice(1)], total: lines }
  }
  // Whole lines left out, else only the characters of a line cut in two.
  const skipped = tailLine - head.length - 1
  if (skipped === 0) {
    const gap: WindowedLine = { _tag: "elision", count: chars, unit: "chars" }
    return { rows: [...headRows, gap, ...tailRows], total: lines }
  }
  // The gap counts whole lines, so a head or tail line cut short is marked
  // on its own row: the gap does not count the characters it lost.
  const marked = (
    rows: ReadonlyArray<WindowedLine>,
    index: number,
    part: "end" | "start",
  ): Array<WindowedLine> =>
    rows.map((row, at) => {
      if (at !== index || row._tag !== "line") return row
      return { ...row, part }
    })
  let headDrawn: ReadonlyArray<WindowedLine> = headRows
  if (cut.headCut === true) headDrawn = marked(headRows, headRows.length - 1, "end")
  let tailDrawn: ReadonlyArray<WindowedLine> = tailRows
  if (cut.tailCut === true) tailDrawn = marked(tailRows, 0, "start")
  const gap: WindowedLine = { _tag: "elision", count: skipped, unit: "lines" }
  return { rows: [...headDrawn, gap, ...tailDrawn], total: lines }
}

/** The lines of the whole output one row stands for. */
const rowLines = (row: WindowedLine): number =>
  Match.value(row).pipe(
    Match.tagsExhaustive({
      line: () => 1,
      elision: (item) => {
        if (item.unit === "chars") return 0
        return item.count
      },
    }),
  )

/** At most `max` line rows: the first and last halves, and one elision counting all between. */
const windowRows = (
  rows: ReadonlyArray<WindowedLine>,
  max: number,
): ReadonlyArray<WindowedLine> => {
  const lineIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => entry.row._tag === "line")
    .map((entry) => entry.index)
  if (lineIndexes.length <= max) return rows
  const half = Math.floor(max / 2)
  const headEnd = (lineIndexes[half - 1] ?? -1) + 1
  const tailStart = lineIndexes[lineIndexes.length - half] ?? rows.length
  const hidden = rows.slice(headEnd, tailStart).reduce((sum, row) => sum + rowLines(row), 0)
  return [
    ...rows.slice(0, headEnd),
    { _tag: "elision", count: hidden, unit: "lines" },
    ...rows.slice(tailStart),
  ]
}

type GutterPart =
  | { readonly _tag: "run"; readonly startLine: number; readonly lines: ReadonlyArray<string> }
  | { readonly _tag: "elision"; readonly count: number; readonly unit: "lines" | "chars" }

/** Rows as runs of consecutive lines, each drawn by a gutter from its first number, split at elisions. */
const gutterParts = (rows: ReadonlyArray<WindowedLine>): ReadonlyArray<GutterPart> => {
  const parts: Array<GutterPart> = []
  let run: Array<string> = []
  let runStart = 0
  const flush = () => {
    if (run.length > 0) parts.push({ _tag: "run", startLine: runStart, lines: run })
    run = []
  }
  for (const row of rows) {
    if (row._tag === "elision") {
      flush()
      parts.push(row)
      continue
    }
    if (run.length === 0) runStart = row.lineNum
    run.push(drawnText(row))
  }
  flush()
  return parts
}

const unitNoun = (unit: "lines" | "chars"): string => {
  if (unit === "chars") return "char"
  return "line"
}

/** Rows as plain text, an elision as the truncation marker `formatHeadTail` draws. */
const rowsText = (rows: ReadonlyArray<WindowedLine>): string =>
  rows
    .flatMap((row) =>
      Match.value(row).pipe(
        Match.tagsExhaustive({
          line: (item) => [drawnText(item)],
          elision: (item) => ["", truncationMarker(plural(item.count, unitNoun(item.unit))), ""],
        }),
      ),
    )
    .join("\n")

/**
 * The one-line summary the tool wrote, for a row whose body did not come
 * through: a reloaded op too large for the snapshot draws this instead.
 */
function SummaryLine(props: { toolCall: ToolCall }) {
  const { theme } = useTheme()
  return (
    <Show when={props.toolCall.status !== "running" && props.toolCall.summary}>
      {(summary) => <text style={{ fg: theme.textMuted }}>{summary()}</text>}
    </Show>
  )
}

/**
 * A bash result as numbered rows: stdout then stderr, each numbered and
 * counted as in the whole output, a cut stream by its cut record. The row
 * header counts `total` too, so a row and its body name one number, live and
 * after a reload.
 */
export const bashOutputRows = (call: ToolCall): OutputRows =>
  Option.match(parseBashOutput(call.output), {
    onNone: () => ({ rows: [], total: 0 }),
    onSome: (value) => {
      const streams = [
        outputRows(value.stdout, textCutFor(call, Option.some("stdout"))),
        outputRows(value.stderr, textCutFor(call, Option.some("stderr"))),
      ]
      return {
        rows: streams.flatMap((stream) => stream.rows),
        total: streams.reduce((sum, stream) => sum + stream.total, 0),
      }
    },
  })

function getCommand(input: ToolInput): string {
  return getString(input, "command")
}

function BashToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseBashOutput(props.toolCall.output))
  const command = createMemo(() => getCommand(props.toolCall.input))

  const output = createMemo(() => bashOutputRows(props.toolCall))

  const collapsedText = createMemo(() => rowsText(windowRows(output().rows, 6)))
  const expandedText = createMemo(() => rowsText(windowRows(output().rows, 100)))

  const exitCodeColor = () => {
    const d = data()
    if (Option.isNone(d)) return theme.textMuted
    if (Option.contains(d.value.status, "blocked")) return theme.warning
    if (Option.contains(d.value.status, "background")) return theme.info
    if (d.value.exitCode === 0) return theme.success
    return theme.error
  }

  // A blocked command (stored by an earlier version) never ran and a
  // background one has not ended: neither has an exit code or a line count to
  // draw.
  const status = () => Option.flatMap(data(), (d) => d.status)
  const Outcome = () => (
    <Show
      when={Option.isNone(status())}
      fallback={
        <span style={{ fg: exitCodeColor() }}>
          {Option.match(
            Option.filter(status(), (value) => value === "blocked"),
            {
              onNone: () => "in background",
              onSome: () => "declined",
            },
          )}
        </span>
      }
    >
      <span style={{ fg: exitCodeColor() }}>exit {Option.getOrUndefined(data())?.exitCode}</span>
      <span style={{ fg: theme.textMuted }}> · {plural(output().total, "line")}</span>
    </Show>
  )

  return (
    <ToolFrame
      title="bash"
      subtitle={command()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={Option.getOrUndefined(data())}>
          <box flexDirection="column">
            <text>
              <Outcome />
            </text>
            <Show when={collapsedText().length > 0}>
              <text style={{ fg: theme.textMuted }}>{collapsedText()}</text>
            </Show>
          </box>
        </Show>
      }
    >
      <Show when={Option.getOrUndefined(data())}>
        <box flexDirection="column">
          <text>
            <Outcome />
          </text>
          <Show when={expandedText().length > 0}>
            <text style={{ fg: theme.text }}>{expandedText()}</text>
          </Show>
        </box>
      </Show>
    </ToolFrame>
  )
}

// ── cell renderer ───────────────────────────────────────────────────────────

/**
 * Cell tool renderer.
 *
 * Collapsed: inner operation receipts + head/tail of the display value
 * Expanded: code, receipts, full display, bindings, and failure detail
 */

/** Success and failure results share one lenient shape; every field is optional. */
const CellOutputSchema = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  display: Schema.optional(Schema.String),
  bindings: Schema.optional(Schema.Array(Schema.String)),
  bindingCount: Schema.optional(Schema.Finite),
  truncated: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  diagnostics: Schema.optional(Schema.String),
  stateLost: Schema.optional(Schema.Boolean),
})

/**
 * The bindings line of a cell result. A result with `bindingCount` names the
 * bindings its cell added or rebound, then counts the whole namespace. A
 * result stored before the count existed lists the whole namespace, so it
 * reads as such. None when there is nothing to show.
 */
const cellBindingsLine = (value: typeof CellOutputSchema.Type) => {
  const names = value.bindings ?? []
  return Option.match(Option.fromUndefinedOr(value.bindingCount), {
    onNone: () =>
      Option.map(
        Option.liftPredicate(names, (list) => list.length > 0),
        (list) => ({
          label: "bindings",
          names: list.join(", "),
          count: "",
        }),
      ),
    onSome: (count) =>
      Option.map(
        Option.liftPredicate(count, (total) => total > 0),
        (total) => ({
          label: "bound",
          names: Option.getOrElse(
            Option.liftPredicate(names.join(", "), (text) => text.length > 0),
            () => "none",
          ),
          count: ` · ${plural(total, "binding")} in all`,
        }),
      ),
  })
}

interface OperationLine {
  readonly tool: string
  readonly outcome: "succeeded" | "failed" | "incomplete" | "running"
  readonly summary: string
}

const liveOutcome = (status: ToolCall["status"]): ActivityOperation["outcome"] => {
  if (status === "running") return "running"
  if (status === "error") return "failed"
  return "succeeded"
}

/** Calls a cell admitted: live nested calls carry arguments; saved receipts carry tool and outcome. */
export const cellOperations = (call: ToolCall): ReadonlyArray<ActivityOperation> => {
  const live = Option.fromNullishOr(call.operations)
  if (Option.isSome(live) && live.value.length > 0) {
    return live.value.map((operation) => ({
      tool: operation.toolName,
      outcome: liveOutcome(operation.status),
      detail: toolArgSummary(operation.toolName, operation.input),
    }))
  }
  return Option.match(decodeToolOutputOption(CellOperationReceipts, call.output), {
    onNone: () => [],
    onSome: (value) =>
      (value.operations ?? []).map((operation) => ({
        tool: operation.tool,
        outcome: operation.outcome,
        detail: "",
      })),
  })
}

function CellToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => decodeToolOutputOption(CellOutputSchema, props.toolCall.output))
  const code = createMemo(() => getString(props.toolCall.input, "code"))
  const codeLines = createMemo(() => code().split("\n"))
  // The ops that ran, once there are any, as the header counts them; before
  // that the verbs the source spells out, else its first line.
  const subtitle = createMemo(() => {
    const operations = cellOperations(props.toolCall)
    const verbs = describeCellCode(code())
    let first = codeLines()[0] ?? ""
    if (verbs.length > 0) first = verbs.join(" · ")
    if (operations.length > 0) first = formatOperationLabels(operations)
    if (first.length > 60) return `${first.slice(0, 60)}…`
    return first
  })

  // Operations are the calls the cell admitted, with their input and output,
  // from the live feed or the snapshot. The saved result's receipts are the
  // fallback where the branch has no events for them (a fork).
  const liveOperations = createMemo((): ReadonlyArray<ToolCall> =>
    Option.getOrElse(Option.fromNullishOr(props.toolCall.operations), () => []),
  )
  const receipts = createMemo((): ReadonlyArray<OperationLine> =>
    Option.match(decodeToolOutputOption(CellOperationReceipts, props.toolCall.output), {
      onNone: () => [],
      onSome: (value) => value.operations ?? [],
    }),
  )

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
    Option.match(data(), { onNone: () => Option.none(), onSome: cellBindingsLine }),
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

  const OperationRow = (line: OperationLine) => (
    <text>
      <span style={{ fg: outcomeColor(line.outcome) }}>{outcomeGlyph(line.outcome)} </span>
      <span style={{ fg: theme.text, bold: true }}>{line.tool}</span>
      <Show when={line.summary.length > 0}>
        <span style={{ fg: theme.textMuted }}> {line.summary}</span>
      </Show>
    </text>
  )

  // Each live op draws through the renderer registered for its tool, as a
  // collapsed sub-row: its header and its summary, never its full body. An op
  // with no renderer keeps its one-line receipt. A blank line separates each op
  // and the cell's own text after them, as it separates transcript blocks;
  // one-line receipts stay a tight list.
  const Operations = () => (
    <Show
      when={liveOperations().length > 0}
      fallback={
        <Show when={receipts().length > 0}>
          <box flexDirection="column">
            <For each={receipts()}>{(line) => OperationRow(line)}</For>
          </box>
        </Show>
      }
    >
      <box flexDirection="column" gap={1}>
        <For each={liveOperations()}>
          {(call) => (
            <RegisteredToolCall
              toolCall={call}
              expanded={false}
              fallback={OperationRow({
                tool: call.toolName,
                outcome: liveOutcome(call.status),
                summary: call.summary ?? "",
              })}
            />
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
        <box flexDirection="column" gap={1}>
          <Operations />
          <Failure />
          <Show when={displayLines().length > 0}>
            <text style={{ fg: theme.textMuted }}>{formatHeadTail(displayLines(), 6)}</text>
          </Show>
        </box>
      }
    >
      <box flexDirection="column" gap={1}>
        <Show when={code().length > 0}>
          <GutterText lines={codeLines()} startLine={1} />
        </Show>
        <Operations />
        <Failure />
        <Show when={displayLines().length > 0}>
          <text style={{ fg: theme.text }}>{formatHeadTail(displayLines(), 100)}</text>
        </Show>
      </box>
      <Show when={truncated()}>
        <text style={{ fg: theme.warning }}>display truncated</text>
      </Show>
      <Show when={Option.getOrUndefined(bindings())}>
        {(line) => (
          <text>
            <span style={{ fg: theme.textMuted }}>{line().label}: </span>
            <span style={{ fg: theme.text }}>{line().names}</span>
            <span style={{ fg: theme.textMuted }}>{line().count}</span>
          </text>
        )}
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

// ── read renderer ───────────────────────────────────────────────────────────

/**
 * Read tool renderer.
 *
 * Collapsed: path + line count + truncation indicator
 * Expanded: line-numbered content with GutterText
 */

interface ReadOutput {
  readonly content: string
  readonly path: string
  readonly lineCount: number
  readonly truncated: boolean
}

const ReadOutputSchema = Schema.Struct({
  content: Schema.String,
  path: Schema.optional(Schema.String),
  lineCount: Schema.optional(Schema.Finite),
  truncated: Schema.optional(Schema.Boolean),
})

function parseReadOutput(
  output: ToolRendererProps["toolCall"]["output"],
): Option.Option<ReadOutput> {
  return Option.map(decodeToolOutputOption(ReadOutputSchema, output), (d) => ({
    content: d["content"],
    path: d["path"] ?? "",
    lineCount: d["lineCount"] ?? 0,
    truncated: d["truncated"] ?? false,
  }))
}

function getPath(input: ToolInput): string {
  return getString(input, "path")
}

/** Parse line-numbered content (tab-separated: "  1\tcontent") into lines */
function parseContentLines(content: string): string[] {
  return content.split("\n").map((line) => {
    // strip "  N\t" prefix if present
    const tabIdx = line.indexOf("\t")
    if (tabIdx >= 0) return line.slice(tabIdx + 1)
    return line
  })
}

/** Extract start line number from tab-prefixed content */
function getStartLine(content: string): number {
  const firstLine = content.split("\n")[0] ?? ""
  const tabIdx = firstLine.indexOf("\t")
  if (tabIdx < 0) return 1
  const num = parseInt(firstLine.slice(0, tabIdx).trim(), 10)
  if (isNaN(num)) return 1
  return num
}

export function ReadToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseReadOutput(props.toolCall.output))
  const path = createMemo(() => getPath(props.toolCall.input))

  // Each content line numbered as in the file: the first line's own number,
  // then its position in the whole content, which a cut does not change.
  const contentRows = createMemo((): ReadonlyArray<WindowedLine> => {
    const d = data()
    if (Option.isNone(d)) return []
    const start = getStartLine(d.value.content)
    return outputRows(d.value.content, textCutFor(props.toolCall, Option.some("content"))).rows.map(
      (row) =>
        Match.value(row).pipe(
          Match.tagsExhaustive({
            // A tail line that starts late has lost its `N\t` prefix: its text is content.
            line: (item): WindowedLine => {
              let text = parseContentLines(item.text)[0] ?? ""
              if (item.part === "start") text = item.text
              return { ...item, text, lineNum: start + item.lineNum - 1 }
            },
            elision: (item): WindowedLine => item,
          }),
        ),
    )
  })

  const collapsedLines = createMemo(() => windowRows(contentRows(), 6))

  const expandedParts = createMemo(() => gutterParts(contentRows()))

  return (
    <ToolFrame
      title="read"
      subtitle={truncatePath(path())}
      subtitleHref={Option.getOrUndefined(
        Option.some(path()).pipe(Option.filter(isAbsPath), Option.map(fileUrl)),
      )}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={Option.getOrUndefined(data())}>
          {(d) => (
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.success, bold: true }}>{d().lineCount}</span>
                <span style={{ fg: theme.textMuted }}> {countNoun(d().lineCount, "line")}</span>
                <Show when={d().truncated}>
                  <span style={{ fg: theme.warning }}> (truncated)</span>
                </Show>
              </text>
              <Show when={collapsedLines().length > 0}>
                <For each={collapsedLines()}>
                  {(item) =>
                    Match.value(item).pipe(
                      Match.tagsExhaustive({
                        elision: (item) => (
                          <text>
                            <span style={{ fg: theme.border }}>{"· ··· "}</span>
                            <span style={{ fg: theme.textMuted }}>
                              {plural(item.count, `more ${unitNoun(item.unit)}`)}
                            </span>
                          </text>
                        ),
                        line: (item) => (
                          <text>
                            <span style={{ fg: theme.border }}>
                              {String(item.lineNum).padStart(4)} │{" "}
                            </span>
                            <span style={{ fg: theme.textMuted }}>{drawnText(item)}</span>
                          </text>
                        ),
                      }),
                    )
                  }
                </For>
              </Show>
            </box>
          )}
        </Show>
      }
    >
      <For each={expandedParts()}>
        {(part) =>
          Match.value(part).pipe(
            Match.tagsExhaustive({
              run: (item) => <GutterText lines={[...item.lines]} startLine={item.startLine} />,
              elision: (item) => (
                <text>
                  <span style={{ fg: theme.border }}>{"· ··· "}</span>
                  <span style={{ fg: theme.textMuted }}>
                    {plural(item.count, `more ${unitNoun(item.unit)}`)}
                  </span>
                </text>
              ),
            }),
          )
        }
      </For>
    </ToolFrame>
  )
}

// ── edit renderer ───────────────────────────────────────────────────────────

/**
 * Edit tool renderer.
 *
 * Collapsed: +N -N stats
 * Expanded: unified diff view with syntax highlighting
 */

type DiffLine =
  | { _tag: "line"; text: string; kind: "add" | "remove" | "context" }
  | { _tag: "elision"; count: number }

type DiffLineKind = Extract<DiffLine, { _tag: "line" }>["kind"]

function diffLineKind(text: string): DiffLineKind {
  if (text.startsWith("+")) return "add"
  if (text.startsWith("-")) return "remove"
  return "context"
}

function diffLineColor(kind: DiffLineKind, theme: ReturnType<typeof useTheme>["theme"]) {
  if (kind === "add") return theme.diffAdded
  if (kind === "remove") return theme.diffRemoved
  return theme.textMuted
}

const renderDiffLine = (
  item: DiffLine,
  theme: ReturnType<typeof useTheme>["theme"],
): SolidJSX.Element => {
  if (item._tag === "elision") {
    return (
      <text>
        <span style={{ fg: theme.border }}>{"· ··· "}</span>
        <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
      </text>
    )
  }
  return (
    <text>
      <span style={{ fg: diffLineColor(item.kind, theme) }}>{item.text.slice(0, 1)}</span>
      <span style={{ fg: theme.text }}>{item.text.slice(1)}</span>
    </text>
  )
}

export function EditToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()
  const syntaxStyle = createMemo(() => buildSyntaxStyle(theme))

  const editData = () => getEditUnifiedDiff(props.toolCall.input)
  const path = () => getPath(props.toolCall.input)
  const subtitleHref = () => {
    if (isAbsPath(path())) return fileUrl(path())
    return Option.getOrUndefined(Option.none<string>())
  }

  const collapsedDiffLines = createMemo((): DiffLine[] => {
    const data = editData()
    // `getEditUnifiedDiff` returns null for invalid tool input at this adapter boundary.
    // eslint-disable-next-line effect/noNullish -- invalid edit payloads are rendered as an empty diff.
    if (data === null) return []
    const lines: DiffLine[] = data.diff
      .split("\n")
      .map((text) => ({ _tag: "line", text, kind: diffLineKind(text) }))
    const { head, tail, truncatedCount } = headTail(lines, 6)
    if (truncatedCount === 0) return head
    return [...head, { _tag: "elision", count: truncatedCount }, ...tail]
  })

  return (
    <Show
      when={editData()}
      fallback={
        <ToolFrame
          title="edit"
          subtitle={truncatePath(path())}
          subtitleHref={subtitleHref()}
          status={props.toolCall.status}
          expanded={props.expanded}
          collapsedContent={<SummaryLine toolCall={props.toolCall} />}
        >
          <SummaryLine toolCall={props.toolCall} />
        </ToolFrame>
      }
    >
      {(data) => (
        <ToolFrame
          title="edit"
          subtitle={truncatePath(path())}
          subtitleHref={subtitleHref()}
          status={props.toolCall.status}
          expanded={props.expanded}
          collapsedContent={
            <box flexDirection="column">
              <text>
                <span style={{ fg: theme.diffAdded, bold: true }}>+{data().added}</span>
                <span style={{ fg: theme.textMuted }}> </span>
                <span style={{ fg: theme.diffRemoved, bold: true }}>-{data().removed}</span>
              </text>
              <Show when={collapsedDiffLines().length > 0}>
                <For each={collapsedDiffLines()}>{(item) => renderDiffLine(item, theme)}</For>
              </Show>
            </box>
          }
        >
          <diff
            diff={data().diff}
            view="unified"
            filetype={data().filetype}
            syntaxStyle={syntaxStyle()}
            fg={theme.text}
            showLineNumbers={true}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedContentBg={theme.diffAddedBg}
            removedContentBg={theme.diffRemovedBg}
            contextContentBg={theme.diffContextBg}
            addedSignColor={theme.diffAdded}
            removedSignColor={theme.diffRemoved}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
            lineNumberBg={theme.background}
            lineNumberFg={theme.textMuted}
            width="100%"
          />
        </ToolFrame>
      )}
    </Show>
  )
}

// ── write renderer ──────────────────────────────────────────────────────────

/**
 * Write tool renderer.
 *
 * Collapsed: path + bytes written
 * Expanded: same (write has no content preview in output)
 */

const WriteOutputSchema = Schema.Struct({
  path: Schema.String,
  bytesWritten: Schema.Finite,
})

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function WriteToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => decodeToolOutput(WriteOutputSchema, props.toolCall.output))
  const path = createMemo(() => data()?.path ?? "")
  const subtitleHref = () => {
    if (isAbsPath(path())) return fileUrl(path())
    return Option.getOrUndefined(Option.none<string>())
  }

  return (
    <ToolFrame
      title="write"
      subtitle={truncatePath(path())}
      subtitleHref={subtitleHref()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show when={data()}>
          {(d) => (
            <text>
              <span style={{ fg: theme.success }}>{formatBytes(d().bytesWritten)}</span>
              <span style={{ fg: theme.textMuted }}> written</span>
            </text>
          )}
        </Show>
      }
    >
      <Show when={data()}>
        {(d) => (
          <text>
            <span style={{ fg: theme.text }}>{d().path}</span>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: theme.success }}>{formatBytes(d().bytesWritten)}</span>
            <span style={{ fg: theme.textMuted }}> written</span>
          </text>
        )}
      </Show>
    </ToolFrame>
  )
}

// ── grep renderer ───────────────────────────────────────────────────────────

/**
 * Grep tool renderer.
 *
 * Collapsed: pattern + match count + first 3 files
 * Expanded: all matches with line numbers per file
 */

interface GrepMatch {
  readonly file: string
  readonly line: number
  readonly content: string
}

interface GrepOutput {
  readonly matches: readonly GrepMatch[]
  readonly truncated: boolean
  /** Matches in the whole result; more than `matches` holds when a reload cut them to fit. */
  readonly total: number
  /** Files in the whole result, the ones between a cut's head and tail too. */
  readonly files: number
  /** How many kept matches come before a cut's gap; `None` when nothing was cut. */
  readonly headMatches: Option.Option<number>
}

/** The expanded body's parts: each file's run of matches, and the gap a cut left. */
type GrepPart =
  | { readonly _tag: "file"; readonly file: string; readonly matches: ReadonlyArray<GrepMatch> }
  | { readonly _tag: "gap"; readonly count: number }

const GrepMatchSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Finite,
  content: Schema.String,
})

const GrepOutputSchema = Schema.Struct({
  matches: Schema.Array(GrepMatchSchema),
  truncated: Schema.optional(Schema.Boolean),
})

function parseGrepOutput(call: ToolCall): Option.Option<GrepOutput> {
  const cut = itemsCutFor(call, "matches")
  return Option.map(decodeToolOutputOption(GrepOutputSchema, call.output), (d) => ({
    matches: d.matches,
    truncated: d.truncated ?? false,
    total: Option.match(cut, { onNone: () => d.matches.length, onSome: (value) => value.items }),
    files: Option.getOrElse(
      Option.flatMap(cut, (value) => Option.fromUndefinedOr(value.files)),
      () => new Set(d.matches.map((match) => match.file)).size,
    ),
    // The tail holds the whole array's items from `tailItem` on; the head is the rest kept.
    headMatches: Option.map(cut, (value) => d.matches.length - (value.items - value.tailItem + 1)),
  }))
}

/**
 * Head matches by file, the gap, then tail matches by file. A file with
 * matches on both sides of the gap draws twice, so no run joins across it.
 */
function grepParts(output: GrepOutput): ReadonlyArray<GrepPart> {
  const byFile = (matches: ReadonlyArray<GrepMatch>): ReadonlyArray<GrepPart> =>
    Array.from(groupByFile(matches), ([file, fileMatches]): GrepPart => ({
      _tag: "file",
      file,
      matches: fileMatches,
    }))
  return Option.match(output.headMatches, {
    onNone: () => byFile(output.matches),
    onSome: (headCount) => [
      ...byFile(output.matches.slice(0, headCount)),
      { _tag: "gap", count: output.total - output.matches.length },
      ...byFile(output.matches.slice(headCount)),
    ],
  })
}

function getPattern(input: ToolInput): string {
  return getString(input, "pattern")
}

/** Group matches by file */
function groupByFile(matches: ReadonlyArray<GrepMatch>): Map<string, GrepMatch[]> {
  const groups = new Map<string, GrepMatch[]>()
  for (const m of matches) {
    const existing = Option.fromNullishOr(groups.get(m.file))
    if (Option.isSome(existing)) {
      existing.value.push(m)
    } else {
      groups.set(m.file, [m])
    }
  }
  return groups
}

function GrepToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseGrepOutput(props.toolCall))
  const pattern = createMemo(() => getPattern(props.toolCall.input))
  const parts = createMemo(() => Option.match(data(), { onNone: () => [], onSome: grepParts }))
  const collapsedFiles = createMemo(() =>
    [
      ...new Set(
        Option.match(data(), { onNone: () => [], onSome: (d) => d.matches }).map((m) => m.file),
      ),
    ].slice(0, 3),
  )

  // The whole result's counts, the matches a cut left out included.
  const Totals = (totals: { output: GrepOutput }) => (
    <text>
      <span style={{ fg: theme.success, bold: true }}>{totals.output.total}</span>
      <span style={{ fg: theme.textMuted }}>
        {" "}
        {countNoun(totals.output.total, "match", "matches")} in{" "}
        {plural(totals.output.files, "file")}
      </span>
      <Show when={totals.output.truncated}>
        <span style={{ fg: theme.warning }}> (truncated)</span>
      </Show>
    </text>
  )

  return (
    <ToolFrame
      title="grep"
      subtitle={pattern()}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <Show
          when={Option.getOrUndefined(data())}
          fallback={<SummaryLine toolCall={props.toolCall} />}
        >
          {(d) => (
            <box flexDirection="column">
              <Totals output={d()} />
              <For each={collapsedFiles()}>
                {(file) => <text style={{ fg: theme.textMuted }}> {truncatePath(file)}</text>}
              </For>
              <Show when={d().files > collapsedFiles().length}>
                <text style={{ fg: theme.textMuted }}>
                  {" "}
                  ... +{plural(d().files - collapsedFiles().length, "more file")}
                </text>
              </Show>
            </box>
          )}
        </Show>
      }
    >
      <Show
        when={Option.getOrUndefined(data())}
        fallback={<SummaryLine toolCall={props.toolCall} />}
      >
        {(d) => (
          <box flexDirection="column">
            <box marginBottom={1}>
              <Totals output={d()} />
            </box>
            <For each={parts()}>
              {(part) =>
                Match.value(part).pipe(
                  Match.tagsExhaustive({
                    gap: (gap) => (
                      <box marginBottom={1}>
                        <text>
                          <span style={{ fg: theme.border }}>{"· ··· "}</span>
                          <span style={{ fg: theme.textMuted }}>
                            {plural(gap.count, "more match", "more matches")}
                          </span>
                        </text>
                      </box>
                    ),
                    file: (run) => (
                      <box flexDirection="column" marginBottom={1}>
                        <text>
                          <span style={{ fg: theme.info, bold: true }}>
                            {truncatePath(run.file, 60)}
                          </span>
                        </text>
                        <For each={run.matches}>
                          {(m) => (
                            <text>
                              <span style={{ fg: theme.textMuted }}>
                                {String(m.line).padStart(4)} │{" "}
                              </span>
                              <span style={{ fg: theme.text }}>{m.content}</span>
                            </text>
                          )}
                        </For>
                      </box>
                    ),
                  }),
                )
              }
            </For>
          </box>
        )}
      </Show>
    </ToolFrame>
  )
}

// ── read session renderer ───────────────────────────────────────────────────

const ReadSessionOutputSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Finite),
  branchCount: Schema.optional(Schema.Finite),
})

function getInputField(input: ToolInput, key: string): Option.Option<string> {
  const val = getString(input, key)
  if (val.length === 0) return Option.none()
  return Option.some(val)
}

function ReadSessionToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const output = () => decodeToolOutputOption(ReadSessionOutputSchema, props.toolCall.output)

  const subtitle = () => {
    const sid = getInputField(props.toolCall.input, "sessionId")
    if (Option.isNone(sid)) return Option.getOrUndefined(Option.none<string>())
    return shortId(sid.value)
  }

  const summary = (): Option.Option<string> => {
    const o = output()
    if (Option.isNone(o)) return Option.none()
    const branches = Option.fromNullishOr(o.value.branchCount).pipe(
      Option.map((count) => `, ${count} branches`),
      Option.getOrElse(() => ""),
    )
    return Option.fromNullishOr(o.value.messageCount).pipe(
      Option.map((count) => `${count} messages${branches}`),
    )
  }

  const content = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.content))
  const renderContent = (value: string): string => {
    if (value.length > 500) return value.slice(0, 500) + "…"
    return value
  }

  return (
    <ToolFrame
      title="read_session"
      subtitle={subtitle()}
      status={props.toolCall.status}
      expanded={props.expanded}
    >
      <Show when={props.toolCall.status === "running"}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Loading session…
        </text>
      </Show>

      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(summary())}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.success }}>✓</span> {Option.getOrElse(summary(), () => "")}
        </text>
      </Show>

      <Show when={props.expanded && Option.getOrUndefined(content())}>
        <box paddingLeft={2}>
          <text style={{ fg: theme.textMuted }}>
            {Option.match(content(), { onNone: () => "", onSome: renderContent })}
          </text>
        </box>
      </Show>
    </ToolFrame>
  )
}

// ── builtin renderer registry ───────────────────────────────────────────────

interface BuiltinToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
}

/** Builtin tool renderers consumed by the `@gent/tools` client extension. */
export const BUILTIN_TOOL_RENDERERS: ReadonlyArray<BuiltinToolRendererEntry> = [
  { toolNames: ["read"], component: ReadToolRenderer },
  { toolNames: ["edit"], component: EditToolRenderer },
  { toolNames: ["bash"], component: BashToolRenderer },
  { toolNames: ["cell"], component: CellToolRenderer },
  { toolNames: ["write"], component: WriteToolRenderer },
  { toolNames: ["grep"], component: GrepToolRenderer },
  {
    toolNames: ["read_session"],
    component: ReadSessionToolRenderer,
  },
]
