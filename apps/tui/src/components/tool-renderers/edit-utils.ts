import { createPatch } from "diff"
import { isRecord } from "@gent/core/domain/guards.js"

/**
 * Detect filetype from path extension
 */
export function getFiletype(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
  }
  return ext !== undefined ? map[ext] : undefined
}

/**
 * Count lines added/removed from old and new strings
 */
export function countDiffLines(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr.length > 0 ? oldStr.split("\n").length : 0
  const newLines = newStr.length > 0 ? newStr.split("\n").length : 0
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

export interface EditDiffResult {
  diff: string
  filetype: string | undefined
  added: number
  removed: number
}

/**
 * Generate unified diff from edit input for <diff> component
 */
export function getEditUnifiedDiff(input: unknown): EditDiffResult | null {
  if (!isRecord(input)) return null
  const path = input["path"]
  const oldStr = input["oldString"] ?? input["old_string"]
  const newStr = input["newString"] ?? input["new_string"]
  if (typeof path !== "string" || typeof oldStr !== "string" || typeof newStr !== "string")
    return null

  const diff = createPatch(path, oldStr, newStr)
  const filetype = getFiletype(path)
  const { added, removed } = countDiffLines(oldStr, newStr)
  return { diff, filetype, added, removed }
}
