import { describe, expect, test } from "bun:test"
import {
  DEBUG_CHILD_SESSIONS,
  DEBUG_ITEMS,
  DEBUG_TASKS,
  DEBUG_TOOL_CALLS,
} from "../src/routes/debug-fixtures"

const EXPECTED_RENDERER_SAMPLE_TOOLS = [
  "read",
  "edit",
  "bash",
  "write",
  "grep",
  "glob",
  "webfetch",
  "delegate",
  "finder",
  "counsel",
  "code_review",
  "search_sessions",
  "read_session",
] as const

describe("debug fixtures", () => {
  test("cover every dedicated renderer with a sample", () => {
    const covered = new Set(DEBUG_TOOL_CALLS.map((call) => call.toolName))

    for (const toolName of EXPECTED_RENDERER_SAMPLE_TOOLS) {
      expect(covered.has(toolName)).toBe(true)
    }
  })

  test("include fallback generic sample and widget fixtures", () => {
    expect(DEBUG_TOOL_CALLS.some((call) => call.toolName === "task_create")).toBe(true)
    expect(DEBUG_ITEMS.length).toBeGreaterThan(0)
    expect(DEBUG_TASKS.length).toBeGreaterThan(0)
    expect(Object.keys(DEBUG_CHILD_SESSIONS).length).toBeGreaterThan(0)
  })
})
