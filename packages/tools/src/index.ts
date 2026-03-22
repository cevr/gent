// Read Tool
export { ReadTool, ReadParams, ReadResult, ReadError, isSecretFile } from "./read"

// Write Tool
export { WriteTool, WriteParams, WriteResult, WriteError } from "./write"

// Edit Tool
export {
  EditTool,
  EditParams,
  EditResult,
  EditError,
  detectRedaction,
  unescapeStr,
  normalizeWhitespace,
  findMatch,
  type MatchResult,
  type MatchStrategy,
} from "./edit"

// Bash Tool
export {
  BashTool,
  BashParams,
  BashResult,
  BashError,
  splitCdCommand,
  injectGitTrailers,
  stripBackground,
} from "./bash"

// Glob Tool
export { GlobTool, GlobParams, GlobResult, GlobError } from "./glob"

// Grep Tool
export { GrepTool, GrepParams, GrepResult, GrepMatch, GrepError } from "./grep"

// AskUser + Question Tools
export {
  AskUserTool,
  AskUserParams,
  AskUserResult,
  AskUserHandler,
  QuestionTool,
  QuestionParams,
  QuestionResult,
  QuestionHandler,
} from "./ask-user"

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

// WebFetch Tool
export { WebFetchTool, WebFetchParams, WebFetchResult, WebFetchError } from "./webfetch"

// Plan Tool
export { PlanTool, PlanParams, PlanResult } from "./plan"

// Task Tool
export { TaskTool, TaskParams } from "./task"

// Undo Edit Tool
export { UndoEditTool, UndoEditParams, UndoEditError } from "./undo-edit"

// Librarian Tool
export { LibrarianTool, LibrarianParams, LibrarianError } from "./librarian"

// Handoff Tool
export { HandoffTool, HandoffParams, HandoffError } from "./handoff"

// Finder Tool
export { FinderTool, FinderParams, FinderError } from "./finder"

// Code Review Tool
export { CodeReviewTool, CodeReviewParams, CodeReviewError, ReviewComment } from "./code-review"

// Search Sessions Tool
export {
  SearchSessionsTool,
  SearchSessionsParams,
  SearchSessionsError,
  parseRelativeDate,
} from "./search-sessions"

// Read Session Tool
export {
  ReadSessionTool,
  ReadSessionParams,
  ReadSessionError,
  truncate,
  renderMessageParts,
  renderSessionTree,
} from "./read-session"

// Look At Tool
export { LookAtTool, LookAtParams, LookAtError } from "./look-at"

// Counsel Tool
export { CounselTool, CounselParams, CounselError } from "./counsel"

// Task Management Tools
export { TaskCreateTool, TaskCreateParams } from "./task-create"
export { TaskListTool, TaskListParams } from "./task-list"
export { TaskGetTool, TaskGetParams } from "./task-get"
export { TaskUpdateTool, TaskUpdateParams } from "./task-update"
export { TaskRunTool, TaskRunParams } from "./task-run"

// All Tools
import type { AnyToolDefinition } from "@gent/core/domain/tool.js"
import { ReadTool } from "./read"
import { WriteTool } from "./write"
import { EditTool } from "./edit"
import { BashTool } from "./bash"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { AskUserTool, QuestionTool } from "./ask-user"
import { RepoExplorerTool } from "./repo-explorer"
import { TodoReadTool, TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { PlanTool } from "./plan"
import { TaskTool } from "./task"
import { UndoEditTool } from "./undo-edit"
import { LibrarianTool } from "./librarian"
import { HandoffTool } from "./handoff"
import { FinderTool } from "./finder"
import { CodeReviewTool } from "./code-review"
import { SearchSessionsTool } from "./search-sessions"
import { ReadSessionTool } from "./read-session"
import { LookAtTool } from "./look-at"
import { CounselTool } from "./counsel"
import { TaskCreateTool } from "./task-create"
import { TaskListTool } from "./task-list"
import { TaskGetTool } from "./task-get"
import { TaskUpdateTool } from "./task-update"
import { TaskRunTool } from "./task-run"

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
  PlanTool,
  TaskTool,
  UndoEditTool,
  LibrarianTool,
  HandoffTool,
  FinderTool,
  CodeReviewTool,
  SearchSessionsTool,
  ReadSessionTool,
  LookAtTool,
  CounselTool,
  TaskCreateTool,
  TaskListTool,
  TaskGetTool,
  TaskUpdateTool,
  TaskRunTool,
]
