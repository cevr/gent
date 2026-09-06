import { Option, Schema } from "effect"
import { formatHeadTail } from "@gent/core-internal/domain/output-buffer.js"
import { toolArgSummary } from "./utils/format-tool.js"
import { formatGenericToolText } from "./components/tool-renderers/generic-format.js"
import type { ToolInput } from "./utils/parse-tool-output.js"

export interface HeadlessToolCall {
  readonly toolName: string
  readonly input: Option.Option<ToolInput>
  readonly status: "running" | "completed" | "error"
  readonly summary: Option.Option<string>
  readonly output: Option.Option<string>
}

export type HeadlessToolRenderer = (toolCall: HeadlessToolCall) => Option.Option<string>

export interface HeadlessToolRendererEntry {
  readonly toolNames: ReadonlyArray<string>
  readonly render: HeadlessToolRenderer
}

export type HeadlessToolRendererRegistry = ReadonlyMap<string, HeadlessToolRenderer>

const inputSummary = (toolName: string, input: Option.Option<ToolInput>): string =>
  Option.match(input, {
    onNone: () => "",
    onSome: (value) => toolArgSummary(toolName, value),
  })

const outputText = (toolCall: HeadlessToolCall): Option.Option<string> =>
  toolCall.output.pipe(
    Option.orElse(() => toolCall.summary),
    Option.flatMap((text) => Option.fromNullishOr(formatGenericToolText(text))),
  )

const JsonObject = Schema.fromJsonString(Schema.JsonObject)

const parseJsonObject = (text: Option.Option<string>) =>
  text.pipe(Option.flatMap(Schema.decodeUnknownOption(JsonObject)))

const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeNumber = Schema.decodeUnknownOption(Schema.Finite)

const getString = (record: Schema.JsonObject, key: string): string =>
  Option.getOrElse(decodeString(record[key]), () => "")

const getNumber = (record: Schema.JsonObject, key: string): Option.Option<number> =>
  decodeNumber(record[key])

const renderGeneric: HeadlessToolRenderer = (toolCall) => {
  const summary = inputSummary(toolCall.toolName, toolCall.input)
  if (toolCall.status === "running") {
    if (summary.length > 0) return Option.some(`[tool: ${toolCall.toolName}] ${summary}`)
    return Option.some(`[tool: ${toolCall.toolName}]`)
  }

  const text = outputText(toolCall)
  let suffix = ""
  if (toolCall.status === "error") suffix = " (error)"
  if (Option.isNone(text) || text.value.trim().length === 0) {
    return Option.some(`[tool done: ${toolCall.toolName}${suffix}]`)
  }
  return Option.some(
    `[tool done: ${toolCall.toolName}${suffix}]\n${formatHeadTail(text.value.split("\n"), 12)}`,
  )
}

export const BashHeadlessToolRenderer: HeadlessToolRenderer = (toolCall) => {
  const command = inputSummary("bash", toolCall.input)
  if (toolCall.status === "running") {
    if (command.length > 0) return Option.some(`[tool: bash] ${command}`)
    return Option.some("[tool: bash]")
  }

  const parsed = parseJsonObject(toolCall.output)
  if (Option.isNone(parsed)) return renderGeneric(toolCall)

  const stdout = getString(parsed.value, "stdout")
  const stderr = getString(parsed.value, "stderr")
  const exitCode = getNumber(parsed.value, "exitCode")
  let combined = stdout
  if (stderr.length > 0) combined = `${stdout}\n${stderr}`
  const lines = combined.split("\n").filter((line) => line.length > 0)
  let status = "done"
  if (toolCall.status === "error") status = "error"
  const exit = Option.match(exitCode, {
    onNone: () => "",
    onSome: (value) => ` exit ${value}`,
  })
  const renderedOutput = formatHeadTail(lines, 12)

  if (renderedOutput.length === 0) return Option.some(`[tool ${status}: bash${exit}]`)
  return Option.some(`[tool ${status}: bash${exit}]\n${renderedOutput}`)
}

export const BUILTIN_HEADLESS_TOOL_RENDERERS: ReadonlyArray<HeadlessToolRendererEntry> = [
  { toolNames: ["bash"], render: BashHeadlessToolRenderer },
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
  const renderer = Option.getOrElse(
    Option.fromNullishOr(renderers.get(toolCall.toolName.toLowerCase())),
    () => renderGeneric,
  )
  return renderer(toolCall).pipe(
    Option.orElse(() => renderGeneric(toolCall)),
    Option.getOrElse(() => `[tool: ${toolCall.toolName}]`),
  )
}
