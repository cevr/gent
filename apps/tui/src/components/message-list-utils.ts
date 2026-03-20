/**
 * Pure utility functions for message list rendering
 */

import { toolArgSummary } from "../utils/format-tool.js"

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
export const TOOL_SPINNERS: Record<string, readonly string[]> = {
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
}

/**
 * Get spinner frames for a tool by name
 */
export function getSpinnerFrames(toolName: string): readonly string[] {
  const name = toolName.toLowerCase()
  return TOOL_SPINNERS[name] ?? TOOL_SPINNERS["default"] ?? [" | "]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object"
}

/**
 * Format tool input for display in tool header.
 * Delegates to toolArgSummary for smart formatting, then applies
 * truncatePath for width safety on path-heavy tools. Preserves
 * cwd fallback for glob/grep when no path is specified.
 */
export function formatToolInput(
  toolName: string,
  input: unknown,
  cwd: string = process.cwd(),
): string {
  if (!isRecord(input)) return ""
  const name = toolName.toLowerCase()

  // glob/grep: cwd fallback needs to happen before toolArgSummary
  if (name === "glob" || name === "grep") {
    const pattern = typeof input["pattern"] === "string" ? input["pattern"] : ""
    if (pattern.length === 0) return ""
    const searchPath =
      typeof input["path"] === "string" ? truncatePath(input["path"], 30) : truncatePath(cwd, 30)
    const prefix = name === "grep" ? `/${pattern}/` : pattern
    return `${prefix} in ${searchPath}`
  }

  const summary = toolArgSummary(name, input)
  if (summary.length === 0) return ""

  // Apply truncatePath for path-heavy tools
  if (name === "read" || name === "write" || name === "edit" || name === "look_at") {
    return truncatePath(summary)
  }

  return summary
}
