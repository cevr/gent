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

export function toolArgSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName.toLowerCase()) {
    case "bash": {
      const command = (args["command"] ?? args["cmd"] ?? "") as string
      if (typeof command !== "string" || command.length === 0) return ""
      return command.split("\n")[0] ?? command
    }
    case "read": {
      const rawPath = (args["file_path"] ?? args["path"] ?? "") as string
      if (typeof rawPath !== "string" || rawPath.length === 0) return ""
      let text = shortenPath(rawPath)
      const offset = typeof args["offset"] === "number" ? args["offset"] : undefined
      const limit = typeof args["limit"] === "number" ? args["limit"] : undefined
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1
        const endLine = limit !== undefined ? startLine + limit - 1 : ""
        text += `:${startLine}${endLine !== "" ? `-${endLine}` : ""}`
      }
      return text
    }
    case "write": {
      const rawPath = (args["file_path"] ?? args["path"] ?? "") as string
      if (typeof rawPath !== "string" || rawPath.length === 0) return ""
      const content = (args["content"] ?? "") as string
      const lines =
        typeof content === "string" && content.length > 0 ? content.split("\n").length : 0
      let text = shortenPath(rawPath)
      if (lines > 1) text += ` (${lines} lines)`
      return text
    }
    case "edit": {
      const rawPath = (args["file_path"] ?? args["path"] ?? "") as string
      if (typeof rawPath !== "string" || rawPath.length === 0) return ""
      return shortenPath(rawPath)
    }
    case "grep": {
      const pattern = (args["pattern"] ?? "") as string
      if (typeof pattern !== "string" || pattern.length === 0) return ""
      const rawPath = typeof args["path"] === "string" ? args["path"] : "."
      return `/${pattern}/ in ${shortenPath(rawPath)}`
    }
    case "glob": {
      const pattern = (args["pattern"] ?? "") as string
      if (typeof pattern !== "string" || pattern.length === 0) return ""
      const rawPath = typeof args["path"] === "string" ? args["path"] : "."
      return `${pattern} in ${shortenPath(rawPath)}`
    }
    case "webfetch": {
      const url = args["url"]
      return typeof url === "string" ? url : ""
    }
    case "repo_explorer": {
      const spec = typeof args["spec"] === "string" ? args["spec"] : ""
      const action = typeof args["action"] === "string" ? args["action"] : ""
      return spec.length > 0 ? `${action} ${spec}`.trim() : action
    }
    case "delegate": {
      const agent = typeof args["agent"] === "string" ? args["agent"] : undefined
      const task = typeof args["task"] === "string" ? args["task"] : undefined
      const tasks = Array.isArray(args["tasks"]) ? args["tasks"] : undefined
      const chain = Array.isArray(args["chain"]) ? args["chain"] : undefined
      if (tasks !== undefined) return `${tasks.length} parallel`
      if (chain !== undefined) return `${chain.length} chain`
      if (agent !== undefined && task !== undefined)
        return `${agent}:${task.length > 40 ? task.slice(0, 40) + "…" : task}`
      if (agent !== undefined) return agent
      return ""
    }
    case "finder": {
      const query = typeof args["query"] === "string" ? args["query"] : ""
      return query.length > 50 ? query.slice(0, 50) + "…" : query
    }
    case "counsel": {
      const prompt = typeof args["prompt"] === "string" ? args["prompt"] : ""
      return prompt.length > 50 ? prompt.slice(0, 50) + "…" : prompt
    }
    case "librarian": {
      const spec = typeof args["spec"] === "string" ? args["spec"] : ""
      const question = typeof args["question"] === "string" ? args["question"] : ""
      if (spec.length > 0 && question.length > 0) {
        const q = question.length > 40 ? question.slice(0, 40) + "…" : question
        return `${spec}: ${q}`
      }
      return spec || question
    }
    case "code_review": {
      const desc = typeof args["description"] === "string" ? args["description"] : ""
      return desc.length > 50 ? desc.slice(0, 50) + "…" : desc
    }
    case "search_sessions": {
      const query = typeof args["query"] === "string" ? args["query"] : ""
      return query.length > 50 ? query.slice(0, 50) + "…" : query
    }
    case "read_session": {
      const goal = typeof args["goal"] === "string" ? args["goal"] : ""
      return goal.length > 50 ? goal.slice(0, 50) + "…" : goal
    }
    case "handoff": {
      const reason = typeof args["reason"] === "string" ? args["reason"] : ""
      return reason.length > 50 ? reason.slice(0, 50) + "…" : reason
    }
    default:
      return ""
  }
}
