import type { SessionItem } from "../components/message-list"
import type { ToolCall } from "../components/tool-renderers"
import type { ChildSessionEntry } from "../hooks/use-child-sessions"
import type { TaskPreview } from "../components/task-widget"

const now = Date.now()

function toolCall(
  id: string,
  toolName: string,
  input: unknown,
  output: string | undefined,
  summary: string | undefined,
  status: ToolCall["status"] = "completed",
): ToolCall {
  return { id, toolName, input, output, summary, status }
}

export const DEBUG_TOOL_CALLS: readonly ToolCall[] = [
  toolCall(
    "tc-read",
    "read",
    { path: "/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx" },
    JSON.stringify({
      path: "/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session.tsx",
      lineCount: 18,
      truncated: false,
      content:
        "  40\tconst [toolsExpanded, setToolsExpanded] = createSignal(false)\n  41\tconst [inputState, setInputState] = createSignal<InputState>(InputState.normal())\n  42\tconst [overlay, setOverlay] = createSignal<OverlayState>(null)",
    }),
    "18 lines from session.tsx",
  ),
  toolCall(
    "tc-edit",
    "edit",
    {
      path: "/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx",
      oldString: "<text>[ x ] tool_call</text>",
      newString: "<ToolBox />",
    },
    undefined,
    `--- a/apps/tui/src/components/message-list.tsx
+++ b/apps/tui/src/components/message-list.tsx
@@
-<text>[ x ] tool_call</text>
+<ToolBox />`,
  ),
  toolCall(
    "tc-bash",
    "bash",
    { command: "bun run typecheck" },
    JSON.stringify({
      stdout:
        "$ turbo run typecheck\n@gent/tui:typecheck: $ tsc --noEmit\nTasks: 4 successful, 4 total",
      stderr: "",
      exitCode: 0,
    }),
    "Tasks: 4 successful, 4 total",
  ),
  toolCall(
    "tc-write",
    "write",
    { path: "/Users/cvr/Developer/personal/gent/apps/tui/src/routes/debug.tsx" },
    JSON.stringify({
      path: "/Users/cvr/Developer/personal/gent/apps/tui/src/routes/debug.tsx",
      bytesWritten: 1842,
    }),
    "1842B written",
  ),
  toolCall(
    "tc-grep",
    "grep",
    { pattern: "ToolBox", path: "/Users/cvr/Developer/personal/gent/apps/tui/src" },
    JSON.stringify({
      matches: [
        {
          file: "/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/generic.tsx",
          line: 3,
          content: 'import { ToolBox } from "../tool-box"',
        },
        {
          file: "/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/edit.tsx",
          line: 10,
          content: 'import { ToolBox } from "../tool-box"',
        },
        {
          file: "/Users/cvr/Developer/personal/gent/apps/tui/src/components/tool-renderers/read.tsx",
          line: 10,
          content: 'import { ToolBox } from "../tool-box"',
        },
      ],
      truncated: false,
    }),
    "3 matches in 3 files",
  ),
  toolCall(
    "tc-glob",
    "glob",
    { pattern: "**/*.tsx", path: "/Users/cvr/Developer/personal/gent/apps/tui/src" },
    JSON.stringify({
      files: [
        "apps/tui/src/app.tsx",
        "apps/tui/src/routes/home.tsx",
        "apps/tui/src/routes/session.tsx",
        "apps/tui/src/routes/debug.tsx",
        "apps/tui/src/components/message-list.tsx",
        "apps/tui/src/components/task-widget.tsx",
        "apps/tui/src/components/input.tsx",
      ],
      truncated: false,
    }),
    "7 files",
  ),
  toolCall(
    "tc-webfetch",
    "webfetch",
    { url: "https://example.com/docs/tool-renderers" },
    JSON.stringify({
      url: "https://example.com/docs/tool-renderers",
      title: "Tool Renderer Guidelines",
      content:
        "# Tool Renderer Guidelines\n\nUse chrome-based boxes for consistency.\nKeep collapsed state informative.\nAvoid duplicate borders.",
    }),
    "Tool Renderer Guidelines",
  ),
  toolCall(
    "tc-delegate",
    "delegate",
    { tasks: [{ agent: "reviewer", task: "Inspect the TUI tool chrome" }] },
    undefined,
    "1 parallel task",
    "running",
  ),
  toolCall(
    "tc-finder",
    "finder",
    { query: "Where is the double-border coming from?" },
    JSON.stringify({
      found: true,
      response:
        "The old header lived in message-list.tsx while bash/edit already wrapped themselves in ToolBox.",
      metadata: {
        usage: { input: 451, output: 92, cost: 0.01 },
      },
    }),
    "Found source of duplicate border",
  ),
  toolCall(
    "tc-counsel",
    "counsel",
    { prompt: "Sanity-check the debug playground layout." },
    undefined,
    "Awaiting review",
    "running",
  ),
  toolCall(
    "tc-code-review",
    "code_review",
    { description: "Review the new debug route" },
    JSON.stringify({
      summary: { critical: 0, high: 1, medium: 1, low: 0 },
      comments: [
        {
          file: "apps/tui/src/routes/debug.tsx",
          line: 55,
          severity: "high",
          type: "bug",
          text: "Auth gate should not steal the debug route.",
          fix: "Skip auth redirect while route is debug.",
        },
        {
          file: "apps/tui/src/routes/debug-fixtures.ts",
          line: 12,
          severity: "medium",
          type: "suggestion",
          text: "Keep one sample per renderer so coverage stays obvious.",
        },
      ],
    }),
    "2 comments",
  ),
  toolCall(
    "tc-search-sessions",
    "search_sessions",
    { query: "tool renderer" },
    JSON.stringify({
      totalMatches: 3,
      sessions: [
        {
          sessionId: "019debug1",
          name: "tui renderer cleanup",
          lastActivity: "2026-03-22T18:30:00.000Z",
          excerpts: [
            "tool rendering in the TUI is a bit broken",
            "remove the non chrome border in the edit/bash",
          ],
        },
      ],
    }),
    "3 matches in 1 session",
  ),
  toolCall(
    "tc-read-session",
    "read_session",
    { sessionId: "019debug1-session", goal: "Understand the renderer cleanup thread" },
    JSON.stringify({
      sessionId: "019debug1-session",
      extracted: true,
      goal: "Understand the renderer cleanup thread",
      content:
        "User reported double borders, broken task widget placement, and option-backspace deleting the whole line.",
      messageCount: 24,
      branchCount: 1,
    }),
    "Extracted session summary",
  ),
  toolCall(
    "tc-task-create",
    "task_create",
    { title: "Investigate broken task widget", agent: null },
    undefined,
    `{"error":"Tool 'task_create' input failed:\n - agent:\nExpected string | undefined, got null"}`,
    "error",
  ),
]

export const DEBUG_CHILD_SESSIONS: Readonly<Record<string, ChildSessionEntry[]>> = {
  "tc-delegate": [
    {
      childSessionId: "debug-child-1",
      toolCallId: "tc-delegate",
      agentName: "reviewer",
      status: "running",
      toolCalls: [
        {
          toolCallId: "debug-child-tool-1",
          toolName: "read",
          status: "completed",
          input: {
            path: "/Users/cvr/Developer/personal/gent/apps/tui/src/components/message-list.tsx",
          },
        },
        {
          toolCallId: "debug-child-tool-2",
          toolName: "grep",
          status: "running",
          input: { pattern: "ToolBox", path: "/Users/cvr/Developer/personal/gent/apps/tui/src" },
        },
      ],
    },
  ],
  "tc-counsel": [
    {
      childSessionId: "debug-child-2",
      toolCallId: "tc-counsel",
      agentName: "codex",
      status: "running",
      toolCalls: [
        {
          toolCallId: "debug-child-tool-3",
          toolName: "read",
          status: "completed",
          input: { path: "/Users/cvr/Developer/personal/gent/apps/tui/src/routes/debug.tsx" },
        },
      ],
    },
  ],
}

export const DEBUG_TASKS: readonly TaskPreview[] = [
  { subject: "Inspect codebase", status: "in_progress" },
  { subject: "Run verification", status: "pending" },
  { subject: "Summarize outcome", status: "pending" },
  { subject: "Fix broken widget layout", status: "completed" },
]

export const DEBUG_ITEMS: readonly SessionItem[] = [
  {
    _tag: "message",
    id: "debug-user-1",
    role: "user",
    kind: "regular",
    content: "Show me every renderer and the composer chrome.",
    reasoning: "",
    images: [],
    createdAt: now,
    toolCalls: undefined,
  },
  {
    _tag: "message",
    id: "debug-assistant-1",
    role: "assistant",
    kind: "regular",
    content:
      "Renderer playground. Use `ctrl+o` to toggle collapsed vs expanded tool views, `ctrl+t` to toggle sample tasks.",
    reasoning: "Loading curated tool outputs and widget samples.",
    images: [],
    createdAt: now + 1,
    toolCalls: DEBUG_TOOL_CALLS.slice(0, 7),
  },
  {
    _tag: "event",
    kind: "turn-ended",
    durationSeconds: 6,
    createdAt: now + 2,
    seq: 1,
  },
  {
    _tag: "message",
    id: "debug-assistant-2",
    role: "assistant",
    kind: "regular",
    content:
      "Subagent and workflow renderers need live-ish samples too. These cover running child sessions, code review output, session search, and fallback error rendering.",
    reasoning: "",
    images: [],
    createdAt: now + 3,
    toolCalls: DEBUG_TOOL_CALLS.slice(7),
  },
]
