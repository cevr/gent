/**
 * Debug session seeding — creates a pre-populated session with realistic
 * tool calls and message history for TUI development/testing.
 */

import { Effect } from "effect"
import {
  Branch,
  Message,
  ReasoningPart,
  Session,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../domain/message.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"

export interface DebugSessionInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  readonly reasoningLevel: undefined
}

const makeText = (text: string) => new TextPart({ type: "text", text })

const asToolCallId = (value: string) => ToolCallId.make(value)

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: unknown) =>
  new ToolResultPart({
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: "json", value },
  })

const nowPlus = (offsetMs: number) => new Date(Date.now() + offsetMs)

export const seedDebugSession = Effect.fn("DebugSession.seed")(function* (cwd: string) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const sessionId = SessionId.make(Bun.randomUUIDv7())
  const branchId = BranchId.make(Bun.randomUUIDv7())

  const session = new Session({
    id: sessionId,
    name: "debug scenario",
    cwd,
    createdAt: nowPlus(-60_000),
    updatedAt: nowPlus(-1_000),
  })
  const branch = new Branch({
    id: branchId,
    sessionId,
    createdAt: nowPlus(-60_000),
  })

  yield* sessions.createSession(session)
  yield* branches.createBranch(branch)

  const user1 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Review the TUI renderer cleanup and inspect the current implementation.")],
    createdAt: nowPlus(-50_000),
  })

  const assistant1 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
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
        input: { path: `${cwd}/apps/server/src/debug/session.ts` },
      }),
    ],
    createdAt: nowPlus(-47_000),
  })

  const toolResults1 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
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
        path: `${cwd}/apps/server/src/debug/session.ts`,
        bytesWritten: 7421,
      }),
    ],
    createdAt: nowPlus(-46_000),
  })

  const assistant2 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText("The old duplicate chrome came from the legacy tool header in the message list."),
    ],
    createdAt: nowPlus(-45_000),
  })

  const user2 = new Message.interjection({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Actually check queue vs steer too.")],
    createdAt: nowPlus(-38_000),
  })

  const assistant3 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
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

  const user3 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Search related sessions and review the audit output.")],
    createdAt: nowPlus(-28_000),
  })

  const assistant4 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
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
        input: { tasks: [{ agent: "explore", task: "Inspect the TUI tool chrome" }] },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: asToolCallId("dbg-explore"),
        toolName: "delegate",
        input: { agent: "explore", task: "Where is the double-border coming from?" },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: asToolCallId("dbg-review"),
        toolName: "delegate",
        input: { agent: "explore", task: "Sanity-check the debug session bootstrap." },
      }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId: asToolCallId("dbg-review-tool"),
        toolName: "review",
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
    createdAt: nowPlus(-25_000),
  })

  const toolResults2 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "tool",
    parts: [
      makeJsonResult(asToolCallId("dbg-webfetch"), "webfetch", {
        url: "https://example.com/docs/tool-renderers",
        title: "Tool renderer notes",
        excerpt: "Use ToolFrame once and let specialized renderers own body layout.",
      }),
      makeJsonResult(asToolCallId("dbg-delegate"), "delegate", {
        output: "Explorer agreed the duplicate chrome was stale message-list markup.",
      }),
      makeJsonResult(asToolCallId("dbg-explore"), "delegate", {
        output: "The second border was rendered by the message list, not the tool renderer.",
      }),
      makeJsonResult(asToolCallId("dbg-review"), "delegate", {
        output: "Move debug boot into core-side scenario code and keep the shell thin.",
      }),
      makeJsonResult(asToolCallId("dbg-review-tool"), "review", {
        summary: { critical: 0, high: 0, medium: 1, low: 0 },
      }),
      makeJsonResult(asToolCallId("dbg-search-sessions"), "search_sessions", {
        sessions: [{ sessionId: "019debug1-session", name: "tui renderer cleanup" }],
      }),
      makeJsonResult(asToolCallId("dbg-read-session"), "read_session", {
        sessionId: "019debug1-session",
        extracted: true,
        content: "Audit said queue semantics and renderer chrome should be tested together.",
      }),
    ],
    createdAt: nowPlus(-23_000),
  })

  const assistant5 = new Message.regular({
    id: MessageId.make(Bun.randomUUIDv7()),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText(
        "Audit lines up: keep one tool frame, make queue state structural, and test renderer behavior directly.",
      ),
    ],
    createdAt: nowPlus(-21_000),
  })

  const seedMessages = [
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
  ]

  for (const message of seedMessages) {
    yield* messages.createMessage(message)
  }

  return {
    sessionId,
    branchId,
    name: session.name ?? "debug scenario",
    reasoningLevel: undefined,
  } satisfies DebugSessionInfo
})
