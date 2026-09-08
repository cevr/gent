import { Option, Schema } from "effect"
import type { ToolInput } from "./parse-tool-output"

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 999500) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

export function formatUsageStats(
  usage: {
    input?: number
    output?: number
    cost?: number
    turns?: number
  },
  model?: string,
): string {
  const parts: string[] = []
  const turns = Option.fromNullishOr(usage.turns)
  if (Option.isSome(turns) && turns.value > 0) {
    let label = "turn"
    if (turns.value > 1) label = "turns"
    parts.push(`${turns.value} ${label}`)
  }
  const input = Option.fromNullishOr(usage.input)
  if (Option.isSome(input) && input.value > 0) parts.push(`↑${formatTokens(input.value)}`)
  const output = Option.fromNullishOr(usage.output)
  if (Option.isSome(output) && output.value > 0) parts.push(`↓${formatTokens(output.value)}`)
  const cost = Option.fromNullishOr(usage.cost)
  if (Option.isSome(cost) && cost.value > 0) parts.push(`$${cost.value.toFixed(4)}`)
  const modelName = Option.fromNullishOr(model)
  if (Option.isSome(modelName)) parts.push(modelName.value)
  return parts.join(" ")
}

export const truncate = (value: string, max: number): string => {
  if (value.length > max) return `${value.slice(0, Math.max(0, max - 3))}...`
  return value
}

export function shortenPath(p: string, home?: string): string {
  const homePath = Option.fromNullishOr(home)
  if (Option.isSome(homePath) && homePath.value.length > 0 && p.startsWith(homePath.value)) {
    return `~${p.slice(homePath.value.length)}`
  }
  return p
}

const decodeToolArgs = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeNumber = Schema.decodeUnknownOption(Schema.Finite)

function getStringArg(args: Schema.JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const value = decodeString(args[key])
    if (Option.isSome(value)) return value.value
  }
  return ""
}

function getNumberArg(args: Schema.JsonObject, key: string) {
  return decodeNumber(args[key])
}

const optionsHome = (options?: ToolArgSummaryOptions) =>
  Option.fromNullishOr(options).pipe(Option.flatMap((value) => Option.fromNullishOr(value.home)))

function getPathArg(args: Schema.JsonObject): string {
  return getStringArg(args, "file_path", "path")
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

interface ToolArgSummaryOptions {
  readonly home?: string
}

function summarizeRead(args: Schema.JsonObject, options?: ToolArgSummaryOptions): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  let text = shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
  const offset = getNumberArg(args, "offset")
  const limit = getNumberArg(args, "limit")
  if (Option.isNone(offset) && Option.isNone(limit)) return text

  const startLine = Option.getOrElse(offset, () => 1)
  let endLine = Option.none<number>()
  if (Option.isSome(limit)) endLine = Option.some(startLine + limit.value - 1)
  text += `:${startLine}`
  if (Option.isSome(endLine)) text += `-${endLine.value}`
  return text
}

function summarizeWrite(args: Schema.JsonObject, options?: ToolArgSummaryOptions): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  const content = getStringArg(args, "content")
  let lines = 0
  if (content.length > 0) lines = content.split("\n").length
  let text = shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
  if (lines > 1) text += ` (${lines} lines)`
  return text
}

function summarizeScopedPattern(
  args: Schema.JsonObject,
  options?: ToolArgSummaryOptions,
  patternPrefix = "",
  patternSuffix = "",
): string {
  const pattern = getStringArg(args, "pattern")
  if (pattern.length === 0) return ""
  const rawPath = getStringArg(args, "path") || "."
  return `${patternPrefix}${pattern}${patternSuffix} in ${shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))}`
}

function summarizeDelegate(args: Schema.JsonObject): string {
  return truncateText(getStringArg(args, "todo"), 40)
}

type ToolArgFormatter = (args: Schema.JsonObject, options?: ToolArgSummaryOptions) => string

const toolArgFormatters = {
  bash: (args) => {
    const command = getStringArg(args, "command", "cmd")
    if (command.length === 0) return ""
    return command.split("\n")[0] ?? command
  },
  cell: (args) => {
    const code = getStringArg(args, "code")
    return truncateText(code.split("\n")[0] ?? "", 60)
  },
  read: summarizeRead,
  write: summarizeWrite,
  edit: (args, options) => {
    const rawPath = getPathArg(args)
    if (rawPath.length > 0) {
      return shortenPath(rawPath, Option.getOrUndefined(optionsHome(options)))
    }
    return ""
  },
  grep: (args, options) => summarizeScopedPattern(args, options, "/", "/"),
  glob: (args, options) => summarizeScopedPattern(args, options),
  webfetch: (args) => getStringArg(args, "url"),
  repo: (args) => {
    const spec = getStringArg(args, "spec")
    const action = getStringArg(args, "action")
    if (spec.length === 0) return action
    return `${action} ${spec}`.trim()
  },
  delegate: summarizeDelegate,
  skills: (args) => {
    const names = args["names"]
    if (names === "all") return "all"
    if (Array.isArray(names)) return names.join(", ")
    return ""
  },
  search_sessions: (args) => truncateText(getStringArg(args, "query"), 50),
  read_session: (args) => truncateText(getStringArg(args, "goal"), 50),
  handoff: (args) => truncateText(getStringArg(args, "reason"), 50),
} satisfies Record<string, ToolArgFormatter>
const toolArgFormattersByName = new Map<string, ToolArgFormatter>(Object.entries(toolArgFormatters))

export function toolArgSummary(
  toolName: string,
  input: ToolInput,
  options?: ToolArgSummaryOptions,
): string {
  const args = decodeToolArgs(input)
  if (Option.isNone(args)) return ""
  const formatter = toolArgFormattersByName.get(toolName.toLowerCase())
  const selected = Option.fromNullishOr(formatter)
  if (Option.isNone(selected)) return ""
  return selected.value(args.value, options)
}
