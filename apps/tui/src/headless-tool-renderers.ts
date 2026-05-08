import { Option, Schema } from "effect"
import { formatHeadTail } from "@gent/core-internal/domain/output-buffer.js"
import { toolArgSummary } from "./utils/format-tool.js"
import { formatGenericToolText } from "./components/tool-renderers/generic-format.js"

export interface HeadlessToolCall {
  readonly toolName: string
  readonly input: unknown | undefined
  readonly status: "running" | "completed" | "error"
  readonly summary: string | undefined
  readonly output: string | undefined
}

export type HeadlessToolRenderer = (toolCall: HeadlessToolCall) => string | undefined

export interface HeadlessToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly render: HeadlessToolRenderer
}

export type HeadlessToolRendererRegistry = ReadonlyMap<string, HeadlessToolRenderer>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const inputSummary = (toolName: string, input: unknown | undefined): string => {
  if (!isRecord(input)) return ""
  return toolArgSummary(toolName, input)
}

const outputText = (toolCall: HeadlessToolCall): string | undefined =>
  formatGenericToolText(toolCall.output ?? toolCall.summary)

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const parseJsonRecord = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(JsonRecord)(text))
}

const getString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

const getNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

const renderGeneric: HeadlessToolRenderer = (toolCall) => {
  const summary = inputSummary(toolCall.toolName, toolCall.input)
  if (toolCall.status === "running") {
    return summary.length > 0
      ? `[tool: ${toolCall.toolName}] ${summary}`
      : `[tool: ${toolCall.toolName}]`
  }

  const text = outputText(toolCall)
  const suffix = toolCall.status === "error" ? " (error)" : ""
  if (text === undefined || text.trim().length === 0) {
    return `[tool done: ${toolCall.toolName}${suffix}]`
  }
  return `[tool done: ${toolCall.toolName}${suffix}]\n${formatHeadTail(text.split("\n"), 12)}`
}

const renderBash: HeadlessToolRenderer = (toolCall) => {
  const command = inputSummary("bash", toolCall.input)
  if (toolCall.status === "running") {
    return command.length > 0 ? `[tool: bash] ${command}` : "[tool: bash]"
  }

  const parsed = parseJsonRecord(toolCall.output)
  if (parsed === undefined) return renderGeneric(toolCall)

  const stdout = getString(parsed, "stdout")
  const stderr = getString(parsed, "stderr")
  const exitCode = getNumber(parsed, "exitCode")
  const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout
  const lines = combined.split("\n").filter((line) => line.length > 0)
  const status = toolCall.status === "error" ? "error" : "done"
  const exit = exitCode === undefined ? "" : ` exit ${exitCode}`
  const renderedOutput = formatHeadTail(lines, 12)

  if (renderedOutput.length === 0) return `[tool ${status}: bash${exit}]`
  return `[tool ${status}: bash${exit}]\n${renderedOutput}`
}

export const BUILTIN_HEADLESS_TOOL_RENDERERS: ReadonlyArray<HeadlessToolRendererEntry> = [
  { toolNames: ["bash"], render: renderBash },
  {
    toolNames: [
      "read",
      "edit",
      "write",
      "grep",
      "glob",
      "webfetch",
      "delegate",
      "review",
      "counsel",
      "research",
      "search_sessions",
      "read_session",
      "skills",
      "repo",
      "handoff",
    ],
    render: renderGeneric,
  },
]

export const resolveHeadlessToolRenderers = (
  entries: ReadonlyArray<HeadlessToolRendererEntry>,
): HeadlessToolRendererRegistry => {
  const renderers = new Map<string, HeadlessToolRenderer>()
  for (const entry of entries) {
    for (const toolName of entry.toolNames) {
      renderers.set(toolName.toLowerCase(), entry.render)
    }
  }
  return renderers
}

export const DEFAULT_HEADLESS_TOOL_RENDERERS = resolveHeadlessToolRenderers(
  BUILTIN_HEADLESS_TOOL_RENDERERS,
)

export const renderHeadlessToolCall = (
  toolCall: HeadlessToolCall,
  renderers: HeadlessToolRendererRegistry = DEFAULT_HEADLESS_TOOL_RENDERERS,
): string => {
  const renderer = renderers.get(toolCall.toolName.toLowerCase()) ?? renderGeneric
  return renderer(toolCall) ?? renderGeneric(toolCall) ?? `[tool: ${toolCall.toolName}]`
}
