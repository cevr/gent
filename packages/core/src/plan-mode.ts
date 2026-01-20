// Plan Mode Tools - Single source of truth
// Tools allowed in plan mode (read-only operations)

export const PLAN_MODE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "question",
  "ask_user",
  "todo_read",
  "todo_write",
  "plan_exit",
])

export const isToolAllowedInPlanMode = (toolName: string): boolean =>
  PLAN_MODE_TOOLS.has(toolName.toLowerCase())
