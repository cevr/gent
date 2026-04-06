import os from "node:os"

const HOME = os.homedir()

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
  if (usage.turns !== undefined && usage.turns > 0)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`)
  if (usage.input !== undefined && usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output !== undefined && usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cost !== undefined && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`)
  if (model !== undefined) parts.push(model)
  return parts.join(" ")
}

export function shortenPath(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p
}

function getStringArg(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string") return value
  }
  return ""
}

function getNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === "number" ? value : undefined
}

function getPathArg(args: Record<string, unknown>): string {
  return getStringArg(args, "file_path", "path")
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

function summarizeRead(args: Record<string, unknown>): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  let text = shortenPath(rawPath)
  const offset = getNumberArg(args, "offset")
  const limit = getNumberArg(args, "limit")
  if (offset === undefined && limit === undefined) return text

  const startLine = offset ?? 1
  const endLine = limit !== undefined ? startLine + limit - 1 : undefined
  text += `:${startLine}`
  if (endLine !== undefined) text += `-${endLine}`
  return text
}

function summarizeWrite(args: Record<string, unknown>): string {
  const rawPath = getPathArg(args)
  if (rawPath.length === 0) return ""

  const content = getStringArg(args, "content")
  const lines = content.length > 0 ? content.split("\n").length : 0
  let text = shortenPath(rawPath)
  if (lines > 1) text += ` (${lines} lines)`
  return text
}

function summarizeScopedPattern(
  args: Record<string, unknown>,
  patternPrefix = "",
  patternSuffix = "",
): string {
  const pattern = getStringArg(args, "pattern")
  if (pattern.length === 0) return ""
  const rawPath = getStringArg(args, "path") || "."
  return `${patternPrefix}${pattern}${patternSuffix} in ${shortenPath(rawPath)}`
}

function summarizeDelegate(args: Record<string, unknown>): string {
  const agent = getStringArg(args, "agent")
  const task = getStringArg(args, "task")
  const tasks = Array.isArray(args["tasks"]) ? args["tasks"] : undefined
  const chain = Array.isArray(args["chain"]) ? args["chain"] : undefined

  if (tasks !== undefined) return `${tasks.length} parallel`
  if (chain !== undefined) return `${chain.length} chain`
  if (agent.length === 0) return ""
  if (task.length === 0) return agent
  return `${agent}:${truncateText(task, 40)}`
}

type ToolArgFormatter = (args: Record<string, unknown>) => string

const toolArgFormatters: Record<string, ToolArgFormatter> = {
  bash: (args) => {
    const command = getStringArg(args, "command", "cmd")
    if (command.length === 0) return ""
    return command.split("\n")[0] ?? command
  },
  read: summarizeRead,
  write: summarizeWrite,
  edit: (args) => {
    const rawPath = getPathArg(args)
    return rawPath.length > 0 ? shortenPath(rawPath) : ""
  },
  grep: (args) => summarizeScopedPattern(args, "/", "/"),
  glob: (args) => summarizeScopedPattern(args),
  webfetch: (args) => getStringArg(args, "url"),
  repo: (args) => {
    const spec = getStringArg(args, "spec")
    const action = getStringArg(args, "action")
    if (spec.length === 0) return action
    return `${action} ${spec}`.trim()
  },
  delegate: summarizeDelegate,
  code_review: (args) => truncateText(getStringArg(args, "description"), 50),
  search_sessions: (args) => truncateText(getStringArg(args, "query"), 50),
  read_session: (args) => truncateText(getStringArg(args, "goal"), 50),
  handoff: (args) => truncateText(getStringArg(args, "reason"), 50),
}

export function toolArgSummary(toolName: string, args: Record<string, unknown>): string {
  const formatter = toolArgFormatters[toolName.toLowerCase()]
  if (formatter === undefined) return ""
  return formatter(args)
}
