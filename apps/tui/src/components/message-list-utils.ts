/**
 * Pure utility functions for message list rendering
 */

import { toolArgSummary } from "../utils/format-tool.js"
import { getString } from "../utils/parse-tool-output.js"
import type { ToolInput } from "../utils/parse-tool-output.js"

/**
 * Format seconds into human readable time string
 */
export function formatThinkTime(secs: number): string {
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainingSecs = secs % 60
  return `${mins}m ${remainingSecs}s`
}

/**
 * Truncate path from start, keeping filename visible
 * e.g., "/Users/cvr/Developer/personal/gent/apps/tui/src/app.tsx" -> "…/tui/src/app.tsx"
 */
export function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path
  const parts = path.split("/")
  let result = parts[parts.length - 1] ?? ""
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + "/" + result
    if (next.length + 1 > maxLen) break
    result = next
  }
  return "…/" + result
}

// Tool-specific spinner animations (fixed width: 3 chars)
export const TOOL_SPINNERS = {
  // File operations - scanning dots
  read: [".  ", ".. ", "..."],
  glob: [".  ", ".. ", "..."],
  grep: [".  ", ".. ", "..."],
  // Write/edit - typing cursor
  write: ["_  ", "   "],
  edit: ["_  ", "   "],
  // Bash - command prompt
  bash: [">  ", ">> ", ">>>"],
  // Network - signal waves
  webfetch: ["~  ", "~~ ", "~~~"],
  fetch: ["~  ", "~~ ", "~~~"],
  // Default - classic spinner
  default: [" | ", " / ", " - ", " \\ "],
} satisfies Record<string, readonly string[]>
const toolSpinnersByName = new Map<string, readonly string[]>(Object.entries(TOOL_SPINNERS))

/**
 * Get spinner frames for a tool by name
 */
export function getSpinnerFrames(toolName: string): readonly string[] {
  const name = toolName.toLowerCase()
  return toolSpinnersByName.get(name) ?? TOOL_SPINNERS.default
}

/**
 * Format tool input for display in tool header.
 * Delegates to toolArgSummary for smart formatting, then applies
 * truncatePath for width safety on path-heavy tools. Preserves
 * cwd fallback for glob/grep when no path is specified.
 */
export function formatToolInput(
  toolName: string,
  input: ToolInput,
  cwd = ".",
  home?: string,
): string {
  const name = toolName.toLowerCase()

  // glob/grep: cwd fallback needs to happen before toolArgSummary
  if (name === "glob" || name === "grep") {
    const pattern = getString(input, "pattern")
    if (pattern.length === 0) return ""
    const path = getString(input, "path")
    let searchPath = truncatePath(cwd, 30)
    if (path.length > 0) searchPath = truncatePath(path, 30)
    let prefix = pattern
    if (name === "grep") prefix = `/${pattern}/`
    return `${prefix} in ${searchPath}`
  }

  const summary = toolArgSummary(name, input, { home })
  if (summary.length === 0) return ""

  // Apply truncatePath for path-heavy tools
  if (name === "read" || name === "write" || name === "edit") {
    return truncatePath(summary)
  }

  return summary
}

// ── RLM activity summary ──
// The collapsed transcript group describes what the cell did, not that a tool ran.

export type ActivityOutcome = "succeeded" | "failed" | "incomplete" | "running"

export interface ActivityOperation {
  readonly tool: string
  readonly outcome: ActivityOutcome
  /** Argument summary for live calls; empty for saved receipts. */
  readonly detail: string
}

export interface ActivityCall {
  readonly toolName: string
  readonly status: "running" | "completed" | "error"
  readonly operations: ReadonlyArray<ActivityOperation>
  /** The cell source; empty for other tools. */
  readonly code: string
}

// ── Cell intent ──
// A cell with no inner calls still did something; its source says what.

const CELL_VERB_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/tools\.call\(\s*["'`]([\w-]+)["'`]/g, (m) => m[1] ?? ""],
  [/Bun\.\$`([^`]*)`/g, (m) => `$ ${shellHead(m[1] ?? "")}`],
  [
    /Bun\.spawn\(\s*(?:\{\s*cmd:\s*)?\[\s*((?:["'`][^"'`]*["'`]\s*,?\s*)+)\]/g,
    (m) => `$ ${shellHead(argv(m[1] ?? ""))}`,
  ],
  [/Bun\.file\(\s*["'`]([^"'`]+)["'`]/g, (m) => `read ${m[1]}`],
  [/Bun\.write\(\s*["'`]([^"'`]+)["'`]/g, (m) => `write ${m[1]}`],
  [/new Bun\.Glob\(\s*["'`]([^"'`]+)["'`]/g, (m) => `glob ${m[1]}`],
  [/\bfetch\(\s*["'`]([^"'`]+)["'`]/g, (m) => `fetch ${urlHost(m[1] ?? "")}`],
]

const argv = (list: string) =>
  Array.from(list.matchAll(/["'`]([^"'`]*)["'`]/g), (m) => m[1] ?? "").join(" ")

const shellHead = (command: string) => {
  const first = command.split(/\n|\||&&|;/)[0] ?? ""
  return first.trim().split(/\s+/).slice(0, 3).join(" ")
}

const urlHost = (url: string) => URL.parse(url)?.host ?? url

/** Repeats next to each other fold into one label with a count. */
const collapseRepeats = (labels: ReadonlyArray<string>): string[] => {
  const out: string[] = []
  let previous = ""
  let repeats = 0
  const flush = () => {
    if (previous.length === 0) return
    if (repeats > 1) out.push(`${previous} ×${repeats}`)
    else out.push(previous)
  }
  for (const label of labels) {
    if (label === previous) {
      repeats += 1
      continue
    }
    flush()
    previous = label
    repeats = 1
  }
  flush()
  return out
}

/** The verbs a cell's source spells out, in source order: host tools, shell, files, globs, fetches. */
export function describeCellCode(code: string): ReadonlyArray<string> {
  const found: Array<{ readonly index: number; readonly label: string }> = []
  for (const [pattern, label] of CELL_VERB_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const text = label(match)
      if (text.trim().length > 0) found.push({ index: match.index, label: text })
    }
  }
  found.sort((left, right) => left.index - right.index)
  return collapseRepeats(found.map((entry) => entry.label))
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => {
  if (count === 1) return `${count} ${singular}`
  return `${count} ${pluralForm}`
}

const isChildOperation = (operation: ActivityOperation) => operation.tool === "delegate"

/** Header for a group of calls. Cell-only turns count cells, ops, children, and failures. */
export function formatActivityHeader(calls: ReadonlyArray<ActivityCall>): string {
  if (calls.length === 0) return ""
  if (calls.some((call) => call.toolName !== "cell")) {
    const names = new Map<string, number>()
    for (const call of calls) names.set(call.toolName, (names.get(call.toolName) ?? 0) + 1)
    const counts = Array.from(names, ([name, count]) => `${count} ${name}`).join(" · ")
    return `${plural(calls.length, "tool call")} · ${counts}`
  }
  const operations = calls.flatMap((call) => call.operations)
  const children = operations.filter(isChildOperation).length
  const failed =
    operations.filter((operation) => operation.outcome === "failed").length +
    calls.filter((call) => call.status === "error").length
  const parts = [plural(calls.length, "cell")]
  if (operations.length > 0) parts.push(plural(operations.length, "op"))
  else {
    const verbs = calls.flatMap((call) => describeCellCode(call.code)).slice(0, 4)
    if (verbs.length > 0) parts.push(verbs.join(" · "))
  }
  if (children > 0) parts.push(plural(children, "child", "children"))
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(" · ")
}

const truncateLabel = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

/** One-line label for a cell row: its error, else its operations, else its verbs, else its result, else its code. */
export function formatCellRowLabel(
  call: ActivityCall,
  fallback: { readonly code: string; readonly display: string; readonly error: string },
  maxLength = 72,
): string {
  if (call.status === "error" && fallback.error.length > 0) {
    return truncateLabel(fallback.error.split("\n")[0] ?? "", maxLength)
  }
  if (call.operations.length > 0) {
    const labels = collapseRepeats(
      call.operations.map((operation) => {
        let label = operation.tool
        if (operation.detail.length > 0) label = `${operation.tool} ${operation.detail}`
        if (operation.outcome === "failed") label = `✕ ${label}`
        return label
      }),
    )
    return truncateLabel(labels.join(" · "), maxLength)
  }
  const verbs = describeCellCode(fallback.code)
  if (verbs.length > 0) return truncateLabel(verbs.join(" · "), maxLength)
  const display = fallback.display.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (display.length > 0) return truncateLabel(`→ ${display.trim()}`, maxLength)
  return truncateLabel(fallback.code.split("\n")[0] ?? "", maxLength)
}

// ── Progressive disclosure ──
// Row labels stay the same at every level; levels only add output beneath them.

const lineCount = (text: string) => {
  if (text.length === 0) return 0
  return text.split("\n").length
}

/** Line counts for a row: cells show code in and display out, bash shows output only. */
export function formatRowCounts(
  toolName: string,
  counts: { readonly input: string; readonly output: string },
): string {
  const out = lineCount(counts.output)
  if (toolName === "cell") return `↑${lineCount(counts.input)} ↓${out}`
  if (toolName === "bash") return `↓${out}`
  return ""
}

export interface OutputPreview {
  readonly lines: readonly string[]
  readonly hidden: number
}

/** The head of an output; the footer names the rest and the key that reveals it. */
export function previewOutput(text: string, maxLines = 20): OutputPreview {
  const trimmed = text.replace(/\s+$/, "")
  if (trimmed.length === 0) return { lines: [], hidden: 0 }
  const lines = trimmed.split("\n")
  return { lines: lines.slice(0, maxLines), hidden: Math.max(0, lines.length - maxLines) }
}

export const formatPreviewFooter = (hidden: number) => `… +${plural(hidden, "line")} (ctrl+o)`

/** One line for a compaction record: what it replaced and roughly what it costs now. */
export function formatCompactionLabel(sourceMessages: number, summaryChars: number): string {
  const tokens = Math.ceil(summaryChars / 4)
  return `⇣ Compacted ${plural(sourceMessages, "message")} into ~${tokens} tokens`
}
