import { Effect } from "effect"
import {
  Branch,
  Message,
  ReasoningPart,
  Session,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message.js"
import { Storage } from "@gent/core/storage/sqlite-storage.js"
import type { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids.js"
import { startDebugScenario } from "./scenario.js"

export interface DebugSessionInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  readonly bypass: boolean
  readonly reasoningLevel: undefined
}

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

export const seedDebugSession = Effect.fn("DebugSession.seed")(function* (cwd: string) {
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
        input: { path: `${cwd}/packages/core/src/debug/session.ts` },
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
        path: `${cwd}/packages/core/src/debug/session.ts`,
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
    createdAt: nowPlus(-25_000),
  })

  const toolResults2 = new Message({
    id: Bun.randomUUIDv7() as MessageId,
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
        output: "Reviewer agreed the duplicate chrome was stale message-list markup.",
      }),
      makeJsonResult(asToolCallId("dbg-finder"), "finder", {
        answer: "The second border was rendered by the message list, not the tool renderer.",
      }),
      makeJsonResult(asToolCallId("dbg-counsel"), "counsel", {
        answer: "Move debug boot into core-side scenario code and keep the shell thin.",
      }),
      makeJsonResult(asToolCallId("dbg-code-review"), "code_review", {
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

  const assistant5 = new Message({
    id: Bun.randomUUIDv7() as MessageId,
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
    yield* storage.createMessage(message)
  }

  return {
    sessionId,
    branchId,
    name: session.name ?? "debug scenario",
    bypass: session.bypass ?? true,
    reasoningLevel: undefined,
  } satisfies DebugSessionInfo
})

export const prepareDebugSession = Effect.fn("DebugSession.prepare")(function* (cwd: string) {
  const session = yield* seedDebugSession(cwd)
  yield* startDebugScenario({
    sessionId: session.sessionId,
    branchId: session.branchId,
    cwd,
  })
  return session
})
