// Read Tool
export { ReadTool, ReadParams, ReadResult, ReadError } from "./read"

// Write Tool
export { WriteTool, WriteParams, WriteResult, WriteError } from "./write"

// Edit Tool
export { EditTool, EditParams, EditResult, EditError } from "./edit"

// Bash Tool
export { BashTool, BashParams, BashResult, BashError } from "./bash"

// Glob Tool
export { GlobTool, GlobParams, GlobResult, GlobError } from "./glob"

// Grep Tool
export { GrepTool, GrepParams, GrepResult, GrepMatch, GrepError } from "./grep"

// AskUser Tool
export { AskUserTool, AskUserParams, AskUserResult, AskUserHandler } from "./ask-user"

// RepoExplorer Tool
export {
  RepoExplorerTool,
  RepoExplorerParams,
  RepoExplorerResult,
  RepoExplorerError,
} from "./repo-explorer.js"

// Todo Tools
export {
  TodoReadTool,
  TodoReadParams,
  TodoReadResult,
  TodoWriteTool,
  TodoWriteParams,
  TodoWriteResult,
  TodoHandler,
} from "./todo.js"

// Question Tool
export { QuestionTool, QuestionParams, QuestionResult, QuestionHandler } from "./question"

// WebFetch Tool
export { WebFetchTool, WebFetchParams, WebFetchResult, WebFetchError } from "./webfetch"

// Plan Mode Tools
export {
  PlanEnterTool,
  PlanEnterParams,
  PlanEnterResult,
  PlanExitTool,
  PlanExitParams,
  PlanExitResult,
  PlanModeHandler,
} from "./plan-mode.js"

// Re-export from core for backwards compat
export { PLAN_MODE_TOOLS, isToolAllowedInPlanMode } from "@gent/core"

// Re-export isToolAllowedInMode for backwards compat with tests
export { isToolAllowedInMode } from "./plan-mode"

// All Tools
import type { AnyToolDefinition } from "@gent/core"
import { ReadTool } from "./read"
import { WriteTool } from "./write"
import { EditTool } from "./edit"
import { BashTool } from "./bash"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { AskUserTool } from "./ask-user"
import { RepoExplorerTool } from "./repo-explorer"
import { TodoReadTool, TodoWriteTool } from "./todo"
import { QuestionTool } from "./question"
import { WebFetchTool } from "./webfetch"
import { PlanEnterTool, PlanExitTool } from "./plan-mode"

export const AllTools: AnyToolDefinition[] = [
  ReadTool,
  WriteTool,
  EditTool,
  BashTool,
  GlobTool,
  GrepTool,
  AskUserTool,
  RepoExplorerTool,
  TodoReadTool,
  TodoWriteTool,
  QuestionTool,
  WebFetchTool,
  PlanEnterTool,
  PlanExitTool,
]
