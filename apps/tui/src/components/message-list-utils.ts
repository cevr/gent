/**
 * Pure utility functions for message list rendering
 */

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
 * Format tool input for display in parenthesis
 */
export function formatToolInput(
  toolName: string,
  input: unknown,
  cwd: string = process.cwd(),
): string {
  if (!isRecord(input)) return ""
  const obj = input

  switch (toolName.toLowerCase()) {
    case "bash":
      return typeof obj["command"] === "string" ? obj["command"] : ""
    case "read":
    case "write":
      return typeof obj["path"] === "string" ? truncatePath(obj["path"]) : ""
    case "edit":
      return typeof obj["path"] === "string" ? truncatePath(obj["path"]) : ""
    case "glob": {
      const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : ""
      const searchPath =
        typeof obj["path"] === "string" ? truncatePath(obj["path"], 30) : truncatePath(cwd, 30)
      return pattern.length > 0 ? `${pattern} in ${searchPath}` : ""
    }
    case "grep": {
      const pattern = typeof obj["pattern"] === "string" ? obj["pattern"] : ""
      const searchPath =
        typeof obj["path"] === "string" ? truncatePath(obj["path"], 30) : truncatePath(cwd, 30)
      return pattern.length > 0 ? `${pattern} in ${searchPath}` : ""
    }
    default:
      return ""
  }
}
