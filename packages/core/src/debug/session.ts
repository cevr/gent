/**
 * Debug session seeding — creates a pre-populated session with realistic
 * tool calls and message history for TUI development/testing.
 */

import { Clock, Effect } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Branch, Message, Session, dateFromMillis } from "../domain/message.js"
import { SessionStorage } from "../storage/session-storage.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { BranchId, MessageId, SessionId, ToolCallId } from "../domain/ids.js"
import { GentPlatform } from "../runtime/gent-platform.js"

export interface DebugSessionInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  readonly reasoningLevel: undefined
}

const makeText = (text: string) => Prompt.textPart({ text })

const asToolCallId = (value: string) => ToolCallId.make(value)

const makeJsonResult = (toolCallId: ToolCallId, toolName: string, value: unknown) =>
  Prompt.toolResultPart({
    id: toolCallId,
    name: toolName,
    isFailure: false,
    result: value,
  })

const makeToolCall = (params: {
  readonly id: ToolCallId
  readonly name: string
  readonly params: unknown
}) => Prompt.toolCallPart({ ...params, providerExecuted: false })

export const seedDebugSession = Effect.fn("DebugSession.seed")(function* (cwd: string) {
  const sessions = yield* SessionStorage
  const branches = yield* BranchStorage
  const messages = yield* MessageStorage
  const platform = yield* GentPlatform
  const sessionId = SessionId.make(yield* platform.randomId)
  const branchId = BranchId.make(yield* platform.randomId)
  const now = yield* Clock.currentTimeMillis
  const nowPlus = (offsetMs: number) => dateFromMillis(now + offsetMs)

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

  const user1 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Review the TUI renderer cleanup and inspect the current implementation.")],
    createdAt: nowPlus(-50_000),
  })

  const assistant1 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      Prompt.reasoningPart({
        text: "Need tool chrome parity, queue semantics, and task widget behavior.",
      }),
      makeText("Inspected the relevant files and compared the renderer chrome paths."),
      makeToolCall({
        id: asToolCallId("dbg-read"),
        name: "read",
        params: { path: `${cwd}/apps/tui/src/routes/session.tsx` },
      }),
      makeToolCall({
        id: asToolCallId("dbg-grep"),
        name: "grep",
        params: { pattern: "ToolFrame", path: `${cwd}/apps/tui/src` },
      }),
      makeToolCall({
        id: asToolCallId("dbg-glob"),
        name: "glob",
        params: { pattern: "**/*.tsx", path: `${cwd}/apps/tui/src` },
      }),
      makeToolCall({
        id: asToolCallId("dbg-bash"),
        name: "bash",
        params: { command: "bun run typecheck" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-edit"),
        name: "edit",
        params: {
          path: `${cwd}/apps/tui/src/components/message-list.tsx`,
          oldString: "<text>[ x ] tool_call</text>",
          newString: "<ToolFrame />",
        },
      }),
      makeToolCall({
        id: asToolCallId("dbg-write"),
        name: "write",
        params: { path: `${cwd}/apps/server/src/debug/session.ts` },
      }),
    ],
    createdAt: nowPlus(-47_000),
  })

  const toolResults1 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
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

  const assistant2 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [makeText("The duplicate chrome came from rendering both tool summary surfaces.")],
    createdAt: nowPlus(-45_000),
  })

  const user2 = Message.Interjection.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Actually check queue vs steer too.")],
    createdAt: nowPlus(-38_000),
  })

  const assistant3 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
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

  const user3 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "user",
    parts: [makeText("Search related sessions and review the audit output.")],
    createdAt: nowPlus(-28_000),
  })

  const assistant4 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
    sessionId,
    branchId,
    role: "assistant",
    parts: [
      makeText("Pulled adjacent context and kicked off review helpers."),
      makeToolCall({
        id: asToolCallId("dbg-webfetch"),
        name: "webfetch",
        params: { url: "https://example.com/docs/tool-renderers" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-delegate"),
        name: "delegate",
        params: { tasks: [{ agent: "explore", task: "Inspect the TUI tool chrome" }] },
      }),
      makeToolCall({
        id: asToolCallId("dbg-explore"),
        name: "delegate",
        params: { agent: "explore", task: "Where is the double-border coming from?" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-review"),
        name: "delegate",
        params: { agent: "explore", task: "Sanity-check the debug session bootstrap." },
      }),
      makeToolCall({
        id: asToolCallId("dbg-review-tool"),
        name: "review",
        params: { description: "Review the debug bootstrap" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-search-sessions"),
        name: "search_sessions",
        params: { query: "tool renderer" },
      }),
      makeToolCall({
        id: asToolCallId("dbg-read-session"),
        name: "read_session",
        params: {
          sessionId: "019debug1-session",
          goal: "Understand the renderer cleanup thread",
        },
      }),
    ],
    createdAt: nowPlus(-25_000),
  })

  const toolResults2 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
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

  const assistant5 = Message.Regular.make({
    id: MessageId.make(yield* platform.randomId),
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
