import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage.js"
import {
  Session,
  Branch,
  Message,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import { Task } from "@gent/core/domain/task.js"
import type { BranchId, SessionId, MessageId, TaskId, ToolCallId } from "@gent/core/domain/ids.js"
import type { Session as ClientSession } from "../client/index"

const makeText = (text: string) => new TextPart({ type: "text", text })

const asToolCallId = (value: string) => value as ToolCallId

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: unknown) =>
  new ToolResultPart({
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: "json", value },
  })

const nowPlus = (offsetMs: number) => new Date(Date.now() + offsetMs)

export const seedDebugSession = (cwd: string): Effect.Effect<ClientSession, never, Storage> =>
  Effect.gen(function* () {
    const storage = yield* Storage
    const sessionId = Bun.randomUUIDv7() as SessionId
    const branchId = Bun.randomUUIDv7() as BranchId

    const session = new Session({
      id: sessionId,
      name: "debug scenario",
      cwd,
      bypass: true,
      createdAt: nowPlus(-60_000),
      updatedAt: nowPlus(-1_000),
    })
    const branch = new Branch({
      id: branchId,
      sessionId,
      createdAt: nowPlus(-60_000),
    })

    yield* storage.createSession(session)
    yield* storage.createBranch(branch)

    const user1 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "user",
      kind: "regular",
      parts: [makeText("Review the TUI renderer cleanup and inspect the current implementation.")],
      createdAt: nowPlus(-50_000),
    })

    const assistant1 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        new ReasoningPart({
          type: "reasoning",
          text: "Need tool chrome parity, queue semantics, and task widget behavior.",
        }),
        makeText("Inspected the relevant files and compared the renderer chrome paths."),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-read"),
          toolName: "read",
          input: { path: `${cwd}/apps/tui/src/routes/session.tsx` },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-grep"),
          toolName: "grep",
          input: { pattern: "ToolFrame", path: `${cwd}/apps/tui/src` },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-glob"),
          toolName: "glob",
          input: { pattern: "**/*.tsx", path: `${cwd}/apps/tui/src` },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-bash"),
          toolName: "bash",
          input: { command: "bun run typecheck" },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-edit"),
          toolName: "edit",
          input: {
            path: `${cwd}/apps/tui/src/components/message-list.tsx`,
            oldString: "<text>[ x ] tool_call</text>",
            newString: "<ToolFrame />",
          },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-write"),
          toolName: "write",
          input: { path: `${cwd}/apps/tui/src/debug/bootstrap.ts` },
        }),
      ],
      createdAt: nowPlus(-47_000),
    })

    const toolResults1 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "tool",
      parts: [
        makeJsonResult(asToolCallId("dbg-read"), "read", {
          path: `${cwd}/apps/tui/src/routes/session.tsx`,
          lineCount: 18,
          truncated: false,
          content:
            "const [toolsExpanded, setToolsExpanded] = createSignal(false)\nconst [composerState, setComposerState] = createSignal(...)",
        }),
        makeJsonResult(asToolCallId("dbg-grep"), "grep", {
          matches: [
            {
              file: `${cwd}/apps/tui/src/components/tool-renderers/generic.tsx`,
              line: 3,
              content: 'import { ToolFrame } from "../tool-frame"',
            },
          ],
          truncated: false,
        }),
        makeJsonResult(asToolCallId("dbg-glob"), "glob", {
          files: [
            "apps/tui/src/app.tsx",
            "apps/tui/src/routes/session.tsx",
            "apps/tui/src/components/message-list.tsx",
          ],
          truncated: false,
        }),
        makeJsonResult(asToolCallId("dbg-bash"), "bash", {
          stdout: "$ turbo run typecheck\nTasks: 4 successful, 4 total",
          stderr: "",
          exitCode: 0,
        }),
        makeJsonResult(asToolCallId("dbg-edit"), "edit", {
          path: `${cwd}/apps/tui/src/components/message-list.tsx`,
          oldString: "<text>[ x ] tool_call</text>",
          newString: "<ToolFrame />",
        }),
        makeJsonResult(asToolCallId("dbg-write"), "write", {
          path: `${cwd}/apps/tui/src/debug/bootstrap.ts`,
          bytesWritten: 7421,
        }),
      ],
      createdAt: nowPlus(-46_000),
    })

    const assistant2 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        makeText("The old duplicate chrome came from the legacy tool header in the message list."),
      ],
      createdAt: nowPlus(-45_000),
    })

    const user2 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "user",
      kind: "interjection",
      parts: [makeText("Actually check queue vs steer too.")],
      createdAt: nowPlus(-38_000),
    })

    const assistant3 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        makeText(
          "Steer should cut ahead of queued regular work. Regular sends should merge by newline while a turn is active.",
        ),
      ],
      createdAt: nowPlus(-36_000),
    })

    const user3 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "user",
      kind: "regular",
      parts: [makeText("Search related sessions and review the audit output.")],
      createdAt: nowPlus(-28_000),
    })

    const assistant4 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        makeText("Pulled adjacent context and kicked off review helpers."),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-webfetch"),
          toolName: "webfetch",
          input: { url: "https://example.com/docs/tool-renderers" },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-delegate"),
          toolName: "delegate",
          input: { tasks: [{ agent: "reviewer", task: "Inspect the TUI tool chrome" }] },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-finder"),
          toolName: "finder",
          input: { query: "Where is the double-border coming from?" },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-counsel"),
          toolName: "counsel",
          input: { prompt: "Sanity-check the debug session bootstrap." },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-code-review"),
          toolName: "code_review",
          input: { description: "Review the debug bootstrap" },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-search-sessions"),
          toolName: "search_sessions",
          input: { query: "tool renderer" },
        }),
        new ToolCallPart({
          type: "tool-call",
          toolCallId: asToolCallId("dbg-read-session"),
          toolName: "read_session",
          input: {
            sessionId: "019debug1-session",
            goal: "Understand the renderer cleanup thread",
          },
        }),
      ],
      createdAt: nowPlus(-26_000),
    })

    const toolResults2 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "tool",
      parts: [
        makeJsonResult(asToolCallId("dbg-webfetch"), "webfetch", {
          url: "https://example.com/docs/tool-renderers",
          title: "Tool Renderer Guidelines",
          content: "# Tool Renderer Guidelines\n\nUse chrome-based boxes for consistency.",
        }),
        makeJsonResult(asToolCallId("dbg-finder"), "finder", {
          found: true,
          response:
            "The old header lived in message-list.tsx while bash/edit already wrapped themselves in ToolFrame.",
          metadata: { usage: { input: 451, output: 92, cost: 0.01 } },
        }),
        makeJsonResult(asToolCallId("dbg-code-review"), "code_review", {
          summary: { critical: 0, high: 1, medium: 1, low: 0 },
          comments: [
            {
              file: "apps/tui/src/debug/bootstrap.ts",
              line: 121,
              severity: "high",
              type: "bug",
              text: "Keep seeded sample paths aligned with real files, or renderer previews drift into fiction.",
            },
          ],
        }),
        makeJsonResult(asToolCallId("dbg-search-sessions"), "search_sessions", {
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
        makeJsonResult(asToolCallId("dbg-read-session"), "read_session", {
          sessionId: "019debug1-session",
          extracted: true,
          goal: "Understand the renderer cleanup thread",
          content:
            "User reported double borders, broken task widget placement, and option-backspace deleting the whole line.",
          messageCount: 24,
          branchCount: 1,
        }),
      ],
      createdAt: nowPlus(-25_000),
    })

    const assistant5 = new Message({
      id: Bun.randomUUIDv7() as MessageId,
      sessionId,
      branchId,
      role: "assistant",
      parts: [
        makeText(
          "The review flow is in place. Running helper tools show as active because their results have not landed yet.",
        ),
      ],
      createdAt: nowPlus(-24_000),
    })

    for (const message of [
      user1,
      assistant1,
      toolResults1,
      assistant2,
      user2,
      assistant3,
      user3,
      assistant4,
      toolResults2,
      assistant5,
    ]) {
      yield* storage.createMessage(message)
    }

    for (const [index, status, subject] of [
      [0, "in_progress", "Inspect codebase"],
      [1, "pending", "Run verification"],
      [2, "pending", "Summarize outcome"],
      [3, "completed", "Fix broken widget layout"],
    ] as const) {
      const createdAt = nowPlus(-20_000 + index * 1_000)
      yield* storage.createTask(
        new Task({
          id: Bun.randomUUIDv7() as TaskId,
          sessionId,
          branchId,
          subject,
          status,
          createdAt,
          updatedAt: createdAt,
        }),
      )
    }

    return {
      sessionId,
      branchId,
      name: session.name ?? "debug scenario",
      bypass: session.bypass ?? true,
      reasoningLevel: session.reasoningLevel,
    }
  }).pipe(Effect.orDie)
