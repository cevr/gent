import type { JSX } from "@opentui/solid"
import { type ChildSessionEntry, useClient } from "./client"
import { createPatch } from "diff"
import { Match, Option, Schema } from "effect"
import { createMemo, createResource, For, type JSX as SolidJSX, Show } from "solid-js"
import { buildSyntaxStyle, useTheme } from "./theme"
import { formatUsageStats, toolArgSummary } from "./utils.js"
import { GutterText, ToolFrame, useSpinnerClock } from "./ui"
import { BranchId } from "@gent/core/protocol"
import {
  decodeToolOutput,
  decodeToolOutputOption,
  describeCellCode,
  fileUrl,
  formatGenericToolDetail,
  formatGenericToolInput,
  formatGenericToolText,
  formatToolInput,
  getString,
  isAbsPath,
  type ToolInput,
  truncatePath,
} from "./utils"
import { formatHeadTail, headTail } from "@gent/core-internal/domain/message.js"
import {
  BashHeadlessToolRenderer,
  CellHeadlessToolRenderer,
  type HeadlessToolRenderer,
} from "./headless"

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
  /** Inner calls a cell admitted. Live feed only; saved results carry receipts. */
  operations?: ToolCall[]
  /** Envelope time of the started receipt. Live feed only. */
  startedAt?: number
  /** Wall time from the started receipt to the terminal receipt. */
  durationMs?: number
}

export interface ToolRendererProps {
  toolCall: ToolCall
  expanded: boolean
  childSessions?: ChildSessionEntry[]
}

export type ToolRenderer = (props: ToolRendererProps) => JSX.Element

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
  let oldLines = 0
  if (oldStr.length > 0) oldLines = oldStr.split("\n").length
  let newLines = 0
  if (newStr.length > 0) newLines = newStr.split("\n").length
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

// ── tool call tree ──────────────────────────────────────────────────────────

interface ToolCallInfo {
  toolName: string
  args: Schema.JsonObject
  isError: boolean
  status?: "running" | "completed" | "error"
}

const SPINNER_FRAMES = ["·", "•", "*"]

function ToolCallTree(props: { toolCalls: ReadonlyArray<ToolCallInfo>; collapsed?: boolean }) {
  const { theme } = useTheme()
  const tick = useSpinnerClock()

  const hiddenCount = () => {
    if (!props.collapsed) return 0
    return Math.max(0, props.toolCalls.length - 10)
  }

  const visible = () => {
    const calls = props.toolCalls
    if (hiddenCount() > 0) return calls.slice(calls.length - 10)
    return calls
  }

  return (
    <box flexDirection="column" paddingLeft={2}>
      <Show when={hiddenCount() > 0}>
        <text style={{ fg: theme.textMuted }}>├── … {hiddenCount()} earlier calls</text>
      </Show>
      <For each={[...visible()]}>
        {(call, index) => {
          const isLast = () => index() === visible().length - 1
          const connector = () => {
            if (isLast()) return "╰──"
            return "├──"
          }
          const icon = () => {
            if (call.status === "running") {
              return Option.getOrElse(
                Option.fromNullishOr(SPINNER_FRAMES[tick() % SPINNER_FRAMES.length]),
                () => "·",
              )
            }
            if (call.isError || call.status === "error") return "✕"
            return "✓"
          }
          const iconColor = () => {
            if (call.status === "running") return theme.warning
            if (call.isError || call.status === "error") return theme.error
            return theme.textMuted
          }
          const summary = () => toolArgSummary(call.toolName, call.args)
          const summaryText = () => {
            if (summary().length > 0) return ` ${summary()}`
            return ""
          }

          return (
            <text style={{ fg: theme.textMuted }}>
              {connector()} <span style={{ fg: iconColor() }}>{icon()}</span> {call.toolName}
              {summaryText()}
            </text>
          )
        }}
      </For>
    </box>
  )
}

// ── live child tree ─────────────────────────────────────────────────────────

function LiveChildTree(props: { childSessions: ChildSessionEntry[] }) {
  const { theme } = useTheme()

  const statusColor = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return theme.warning
    if (status === "error") return theme.error
    return theme.success
  }

  const statusIcon = (status: ChildSessionEntry["status"]) => {
    if (status === "running") return "⋯"
    if (status === "error") return "✕"
    return "✓"
  }

  return (
    <For each={props.childSessions}>
      {(entry) => {
        const decodeInput = Schema.decodeUnknownOption(Schema.JsonObject)
        const items = () =>
          entry.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            args: Option.getOrElse(decodeInput(tc.input), () => ({})),
            isError: tc.status === "error",
            status: tc.status,
          }))

        return (
          <box flexDirection="column">
            <text style={{ fg: theme.textMuted }}>
              <span
                style={{
                  fg: statusColor(entry.status),
                }}
              >
                {statusIcon(entry.status)}
              </span>{" "}
              {entry.agentName}
            </text>
            <ToolCallTree toolCalls={items()} />
          </box>
        )
      }}
    </For>
  )
}

// ── subagent renderer ───────────────────────────────────────────────────────

/**
 * The `delegate.start` renderer.
 *
 * Collapsed: tool call tree (last 10) + usage stats
 * Expanded:
 *   - Running: live tool calls + streaming text
 *   - Completed: full tool call tree + usage + thinking + message text
 *   - Fallback: toolCall.output/preview when message fetch unavailable
 */

const decodeDelegateInput = Schema.decodeUnknownOption(
  Schema.Struct({
    todo: Schema.optional(Schema.String),
  }),
)

/** The delegated task, cut to 60 columns, as the header subtitle. */
const delegateSubtitle = (input: ToolInput): Option.Option<string> => {
  const todo = decodeDelegateInput(input).pipe(
    Option.flatMap((inp) => Option.fromNullishOr(inp.todo)),
  )
  if (Option.isNone(todo)) return Option.none()
  if (todo.value.length > 60) return Option.some(todo.value.slice(0, 60) + "…")
  return todo
}

interface ChildContent {
  readonly reasoning: string[]
  readonly text: string[]
}

/** Extract reasoning + text parts from child session messages */
function extractChildContent(
  messages: ReadonlyArray<{
    role: string
    parts: ReadonlyArray<{ type: string; text?: string }>
  }>,
): ChildContent {
  const reasoning: string[] = []
  const text: string[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.parts) {
      const partText = Option.fromNullishOr(part.text)
      if (part.type === "reasoning" && Option.isSome(partText)) reasoning.push(partText.value)
      else if (part.type === "text" && Option.isSome(partText)) text.push(partText.value)
    }
  }
  return { reasoning, text }
}

function SubagentToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()
  const clientCtx = useClient()

  const children = () => props.childSessions ?? []
  const hasChildren = () => children().length > 0
  const completedChild = (): Option.Option<ChildSessionEntry> => {
    const c = children()
    if (c.length !== 1) return Option.none()
    return Option.fromNullishOr(c[0])
  }

  // Aggregate tool calls from all child sessions for the tree view
  const allToolCalls = createMemo(() =>
    children().flatMap((child) =>
      child.toolCalls.map((tc) => ({
        toolName: tc.toolName,
        args: Option.getOrElse(Schema.decodeUnknownOption(Schema.JsonObject)(tc.input), () => ({})),
        isError: tc.status === "error",
        status: tc.status,
      })),
    ),
  )

  // Aggregate usage across all children
  const totalUsage = createMemo(() => {
    const c = children()
    if (c.length === 0)
      return Option.none<{
        input: number
        output: number
        // eslint-disable-next-line effect/noNullish -- usage formatting accepts an absent cost.
        cost: number | undefined
      }>()
    let input = 0
    let output = 0
    let cost = 0
    let hasUsage = false
    for (const child of c) {
      const usage = Option.fromNullishOr(child.usage)
      if (Option.isSome(usage)) {
        hasUsage = true
        input += usage.value.input
        output += usage.value.output
        const childCost = Option.getOrElse(Option.fromNullishOr(usage.value.cost), () => 0)
        cost += childCost
      }
    }
    if (!hasUsage) return Option.none()
    let costValue = Option.none<number>()
    if (cost > 0) costValue = Option.some(cost)
    return Option.some({ input, output, cost: Option.getOrUndefined(costValue) })
  })

  // Live stream text — bounded tail from all children
  const liveText = createMemo(() => {
    const c = children()
    const parts: string[] = []
    for (const child of c) {
      if (child.streamText.length > 0) parts.push(child.streamText)
    }
    return parts.join("\n")
  })

  // Fetch structured messages (reasoning + text) on completion
  const childBranchId = () =>
    Option.flatMap(completedChild(), (child) =>
      Option.map(Option.fromNullishOr(child.childBranchId), (id) => BranchId.make(id)),
    )
  const fetchKey = () => {
    if (props.toolCall.status === "running") return Option.getOrUndefined(Option.none<BranchId>())
    return Option.getOrUndefined(childBranchId())
  }

  const [childMessages] = createResource(fetchKey, (branchId) =>
    clientCtx.runtime
      .run(clientCtx.client.message.list({ branchId }))
      .then((messages) => extractChildContent(messages))
      .catch(() => Option.getOrUndefined(Option.none<ChildContent>())),
  )

  // Fallback text from toolCall.output or child preview
  const fallbackText = () => {
    const cm = Option.fromNullishOr(childMessages())
    if (Option.isSome(cm) && (cm.value.reasoning.length > 0 || cm.value.text.length > 0)) {
      return Option.none<string>()
    }
    // Try preview from completed child
    const preview = Option.flatMap(completedChild(), (child) => Option.fromNullishOr(child.preview))
    if (Option.isSome(preview)) return preview
    // Try toolCall.output or summary
    return Option.orElse(Option.fromNullishOr(props.toolCall.output), () =>
      Option.fromNullishOr(props.toolCall.summary),
    )
  }

  const usageLine = () => {
    const u = totalUsage()
    if (Option.isNone(u)) return Option.none<string>()
    return Option.some(formatUsageStats(u.value))
  }

  return (
    <ToolFrame
      title="delegate"
      subtitle={Option.getOrUndefined(delegateSubtitle(props.toolCall.input))}
      status={props.toolCall.status}
      expanded={props.expanded}
      collapsedContent={
        <box flexDirection="column">
          <Show when={hasChildren()}>
            <ToolCallTree toolCalls={allToolCalls()} collapsed />
          </Show>
          <Show when={Option.getOrUndefined(usageLine())}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      }
    >
      {/* Running: live tool calls + streaming text */}
      <Show when={props.toolCall.status === "running" && hasChildren()}>
        <box flexDirection="column">
          <LiveChildTree childSessions={children()} />
          <Show when={liveText().length > 0}>
            <text style={{ fg: theme.textMuted }}>
              <i>{liveText()}</i>
            </text>
          </Show>
        </box>
      </Show>

      <Show when={props.toolCall.status === "running" && !hasChildren()}>
        <text style={{ fg: theme.textMuted }}>
          <span style={{ fg: theme.warning }}>⋯</span> Running…
        </text>
      </Show>

      {/* Completed: tool tree + usage + messages */}
      <Show when={props.toolCall.status !== "running" && hasChildren()}>
        <box flexDirection="column">
          <ToolCallTree toolCalls={allToolCalls()} />
          <Show when={Option.getOrUndefined(usageLine())}>
            {(line) => <text style={{ fg: theme.textMuted }}>{line()}</text>}
          </Show>
        </box>
      </Show>

      {/* Structured messages from child session (fetched on completion) */}
      <Show when={childMessages()}>
        {(content) => (
          <Show when={content().reasoning.length > 0 || content().text.length > 0}>
            <box flexDirection="column" marginTop={1}>
              <For each={content().reasoning}>
                {(r) => (
                  <text>
                    <span style={{ fg: theme.textMuted }}>
                      <i>{r}</i>
                    </span>
                  </text>
                )}
              </For>
              <For each={content().text}>{(t) => <text style={{ fg: theme.text }}>{t}</text>}</For>
            </box>
          </Show>
        )}
      </Show>

      {/* Fallback: preview/output when message fetch unavailable */}
      <Show when={props.toolCall.status !== "running" && Option.getOrUndefined(fallbackText())}>
        {(text) => (
          <text style={{ fg: theme.textMuted }} marginTop={1}>
            {text()}
          </text>
        )}
      </Show>
    </ToolFrame>
  )
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
    return Math.max(0, output.split("\n").length - summary.split("\n").length)
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

interface BashOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const BashOutputSchema = Schema.Struct({
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.Finite,
})

function parseBashOutput(
  output: ToolRendererProps["toolCall"]["output"],
): Option.Option<BashOutput> {
  return Option.map(decodeToolOutputOption(BashOutputSchema, output), (decoded) => ({
    stdout: decoded["stdout"] ?? "",
    stderr: decoded["stderr"] ?? "",
    exitCode: decoded["exitCode"],
  }))
}

function getCommand(input: ToolInput): string {
  return getString(input, "command")
}

function BashToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => parseBashOutput(props.toolCall.output))
  const command = createMemo(() => getCommand(props.toolCall.input))

  const lines = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return []
    let combined = d.value.stdout
    if (d.value.stderr.length > 0) combined += `\n${d.value.stderr}`
    return combined.split("\n").filter((l) => l.length > 0)
  })

  const collapsedText = createMemo(() => formatHeadTail(lines(), 6))
  const expandedText = createMemo(() => formatHeadTail(lines(), 100))

  const exitCodeColor = () => {
    const d = data()
    if (Option.isNone(d)) return theme.textMuted
    if (d.value.exitCode === 0) return theme.success
    return theme.error
  }

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
              <span style={{ fg: exitCodeColor() }}>
                exit {Option.getOrUndefined(data())?.exitCode}
              </span>
              <span style={{ fg: theme.textMuted }}> · {lines().length} lines</span>
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
            <span style={{ fg: exitCodeColor() }}>
              exit {Option.getOrUndefined(data())?.exitCode}
            </span>
            <span style={{ fg: theme.textMuted }}> · {lines().length} lines</span>
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

function CellToolRenderer(props: ToolRendererProps) {
  const { theme } = useTheme()

  const data = createMemo(() => decodeToolOutputOption(CellOutputSchema, props.toolCall.output))
  const code = createMemo(() => getString(props.toolCall.input, "code"))
  const codeLines = createMemo(() => code().split("\n"))
  // The verbs the source spells out; the first code line only when it spells none.
  const subtitle = createMemo(() => {
    const verbs = describeCellCode(code())
    let first = codeLines()[0] ?? ""
    if (verbs.length > 0) first = verbs.join(" · ")
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

// ── read renderer ───────────────────────────────────────────────────────────

/**
 * Read tool renderer.
 *
 * Collapsed: path + line count + truncation indicator
 * Expanded: line-numbered content with GutterText
 */

type WindowedLine =
  | { _tag: "line"; text: string; lineNum: number }
  | { _tag: "elision"; count: number }

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

  const contentLines = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return []
    return parseContentLines(d.value.content)
  })

  const startLine = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return 1
    return getStartLine(d.value.content)
  })

  const collapsedLines = createMemo((): WindowedLine[] => {
    const lines = contentLines()
    if (lines.length === 0) return []
    const start = startLine()
    const indexed: WindowedLine[] = lines.map((text, i) => ({
      _tag: "line",
      text,
      lineNum: start + i,
    }))
    const { head, tail, truncatedCount } = headTail(indexed, 6)
    if (truncatedCount === 0) return head
    return [...head, { _tag: "elision", count: truncatedCount }, ...tail]
  })

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
                <span style={{ fg: theme.textMuted }}> lines</span>
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
                            <span style={{ fg: theme.textMuted }}>{item.count} more lines</span>
                          </text>
                        ),
                        line: (item) => (
                          <text>
                            <span style={{ fg: theme.border }}>
                              {String(item.lineNum).padStart(4)} │{" "}
                            </span>
                            <span style={{ fg: theme.textMuted }}>{item.text}</span>
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
      <Show when={contentLines().length > 0}>
        <GutterText lines={contentLines()} startLine={startLine()} />
      </Show>
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
        />
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
}

const GrepMatchSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Finite,
  content: Schema.String,
})

const GrepOutputSchema = Schema.Struct({
  matches: Schema.Array(GrepMatchSchema),
  truncated: Schema.optional(Schema.Boolean),
})

function parseGrepOutput(
  output: ToolRendererProps["toolCall"]["output"],
): Option.Option<GrepOutput> {
  return Option.map(decodeToolOutputOption(GrepOutputSchema, output), (d) => ({
    matches: d.matches,
    truncated: d.truncated ?? false,
  }))
}

function getPattern(input: ToolInput): string {
  return getString(input, "pattern")
}

/** Group matches by file */
function groupByFile(matches: readonly GrepMatch[]): Map<string, GrepMatch[]> {
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

  const data = createMemo(() => parseGrepOutput(props.toolCall.output))
  const pattern = createMemo(() => getPattern(props.toolCall.input))
  const grouped = createMemo(() => {
    const d = data()
    if (Option.isNone(d)) return new Map<string, GrepMatch[]>()
    return groupByFile(d.value.matches)
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
        <Show when={Option.getOrUndefined(data())}>
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
      <Show when={Option.getOrUndefined(data())}>
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

// ── read session renderer ───────────────────────────────────────────────────

const ReadSessionOutputSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  extracted: Schema.optional(Schema.Boolean),
  goal: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Finite),
  branchCount: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
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
    const goal = getInputField(props.toolCall.input, "goal")
    if (Option.isSome(goal)) return `${sid.value.slice(0, 8)}… — ${goal.value.slice(0, 40)}`
    return sid.value.slice(0, 8) + "…"
  }

  const summary = (): Option.Option<string> => {
    const o = output()
    if (Option.isNone(o)) return Option.none()
    if (o.value.extracted) {
      const goal = Option.getOrElse(
        Option.map(Option.fromNullishOr(o.value.goal), (value) => value.slice(0, 50)),
        () => "?",
      )
      return Option.some(`Extracted for: ${goal}`)
    }
    const messageCount = Option.fromNullishOr(o.value.messageCount)
    if (Option.isSome(messageCount)) {
      return Option.some(`${messageCount.value} messages, ${o.value.branchCount} branches`)
    }
    return Option.none()
  }

  const content = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.content))
  const error = () => Option.flatMap(output(), (value) => Option.fromNullishOr(value.error))
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

      <Show when={Option.getOrUndefined(error())}>
        <text style={{ fg: theme.error }}>
          <span>✕</span> {Option.getOrElse(error(), () => "")}
        </text>
      </Show>
    </ToolFrame>
  )
}

// ── builtin renderer registry ───────────────────────────────────────────────

interface BuiltinToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
  readonly headless?: HeadlessToolRenderer
}

/** Builtin tool renderers consumed by the `@gent/tools` client extension. */
export const BUILTIN_TOOL_RENDERERS: ReadonlyArray<BuiltinToolRendererEntry> = [
  { toolNames: ["read"], component: ReadToolRenderer },
  { toolNames: ["edit"], component: EditToolRenderer },
  { toolNames: ["bash"], component: BashToolRenderer, headless: BashHeadlessToolRenderer },
  { toolNames: ["cell"], component: CellToolRenderer, headless: CellHeadlessToolRenderer },
  { toolNames: ["write"], component: WriteToolRenderer },
  { toolNames: ["grep"], component: GrepToolRenderer },
  { toolNames: ["delegate.start"], component: SubagentToolRenderer },
  {
    toolNames: ["read_session"],
    component: ReadSessionToolRenderer,
  },
]
