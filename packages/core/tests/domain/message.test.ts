import { describe, expect, test } from "bun:test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import {
  copyMessageToBranch,
  dateFromMillis,
  formatHeadTail,
  headTail,
  headTailChars,
  latestAssistantText,
  Message,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCallParts,
  messageSingleText,
  projectMessagesWithToolInteractions,
  projectResponsePartsToMessageParts,
  SteerCommand,
  toolCallDurations,
} from "../../src/domain/message"
import { AgentEvent, EventEnvelope, EventId } from "../../src/domain/event"
import { Option, Schema } from "effect"
import * as Response from "effect/unstable/ai/Response"

// ── message.test ────────────────────────────────────────────────────────────

describe("steer command", () => {
  test("a stored Interrupt row still decodes", () => {
    const decoded = Schema.decodeSync(SteerCommand)({
      _tag: "Interrupt",
      sessionId: "stored-session",
      branchId: "stored-branch",
      requestId: "stored-request",
    })
    expect(decoded._tag).toBe("Interrupt")
  })
})

describe("message branch copies", () => {
  test("preserves interjection variant when copying to a new branch", () => {
    const message = Message.cases.interjection.make({
      id: MessageId.make("source-message"),
      sessionId: SessionId.make("source-session"),
      branchId: BranchId.make("source-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "steer now" })],
      createdAt: dateFromMillis(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copied-message"),
      branchId: BranchId.make("copied-branch"),
    })

    expect(copied._tag).toBe("interjection")
    expect(copied.id).toBe(MessageId.make("copied-message"))
    expect(copied.branchId).toBe(BranchId.make("copied-branch"))
    expect(copied.sessionId).toBe(SessionId.make("source-session"))
  })

  test("preserves regular variant and role when copying", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "assistant",
      parts: [Prompt.textPart({ text: "hello" })],
      createdAt: dateFromMillis(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied._tag).toBe("regular")
    expect(copied.role).toBe("assistant")
    expect(copied.id).toBe(MessageId.make("copy-msg"))
    expect(copied.branchId).toBe(BranchId.make("copy-branch"))
    expect(copied.sessionId).toBe(SessionId.make("src-session"))
    expect(copied.parts).toEqual(message.parts)
  })

  test("threads explicit sessionId override when provided", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "x" })],
      createdAt: dateFromMillis(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      sessionId: SessionId.make("override-session"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied.sessionId).toBe(SessionId.make("override-session"))
  })

  test("preserves optional fields (turnDurationMs, metadata) when present", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "assistant",
      parts: [Prompt.textPart({ text: "x" })],
      createdAt: dateFromMillis(0),
      turnDurationMs: 1234,
      metadata: { customType: "demo", extensionId: ExtensionId.make("ext-x") },
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect(copied.turnDurationMs).toBe(1234)
    expect(copied.metadata?.customType).toBe("demo")
    expect(copied.metadata?.extensionId).toBe("ext-x")
  })

  test("omits optional fields when source has none (no spurious undefined keys)", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("src-msg"),
      sessionId: SessionId.make("src-session"),
      branchId: BranchId.make("src-branch"),
      role: "user",
      parts: [Prompt.textPart({ text: "x" })],
      createdAt: dateFromMillis(0),
    })

    const copied = copyMessageToBranch(message, {
      id: MessageId.make("copy-msg"),
      branchId: BranchId.make("copy-branch"),
    })

    expect("turnDurationMs" in copied).toBe(false)
    expect("metadata" in copied).toBe(false)
  })
})

// ── head-tail.test ──────────────────────────────────────────────────────────

describe("headTail", () => {
  test("returns all items when under limit", () => {
    const result = headTail([1, 2, 3], 10)
    expect(result.head).toEqual([1, 2, 3])
    expect(result.tail).toEqual([])
    expect(result.truncatedCount).toBe(0)
  })

  test("splits evenly when over limit", () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    const result = headTail(items, 10)
    expect(result.head).toEqual([0, 1, 2, 3, 4])
    expect(result.tail).toEqual([15, 16, 17, 18, 19])
    expect(result.truncatedCount).toBe(10)
  })

  test("handles exact limit", () => {
    const result = headTail([1, 2, 3, 4], 4)
    expect(result.head).toEqual([1, 2, 3, 4])
    expect(result.truncatedCount).toBe(0)
  })

  test("handles empty array", () => {
    const result = headTail([], 10)
    expect(result.head).toEqual([])
    expect(result.truncatedCount).toBe(0)
  })
})

describe("formatHeadTail", () => {
  test("joins all items when under limit", () => {
    expect(formatHeadTail(["a", "b", "c"], 10)).toBe("a\nb\nc")
  })

  test("inserts truncation marker", () => {
    const items = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const result = formatHeadTail(items, 6)
    expect(result).toContain("... [14 lines truncated] ...")
    expect(result.startsWith("line 0")).toBe(true)
    expect(result.endsWith("line 19")).toBe(true)
  })

  test("custom truncation message", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i}`)
    const result = formatHeadTail(items, 4, (n) => `[${n} omitted]`)
    expect(result).toContain("[6 omitted]")
  })
})

describe("headTailChars", () => {
  test("returns full text when under limit", () => {
    const result = headTailChars("hello", 100)
    expect(result.text).toBe("hello")
    expect(result.truncated).toBe(false)
  })

  test("truncates long text", () => {
    const text = "x".repeat(200)
    const result = headTailChars(text, 100)
    expect(result.truncated).toBe(true)
    expect(result.totalChars).toBe(200)
    expect(result.text).toContain("characters truncated")
  })
})

// ── message-part-projection.test ────────────────────────────────────────────

describe("message part projection", () => {
  const absent = Option.getOrUndefined(Option.none<number>())
  const makeMessage = (
    id: string,
    role: "assistant" | "tool",
    parts: ReadonlyArray<
      Prompt.TextPart | Prompt.ReasoningPart | Prompt.ToolCallPart | Prompt.ToolResultPart
    >,
  ) =>
    Message.cases.regular.make({
      id: MessageId.make(id),
      sessionId: SessionId.make("session-projection"),
      branchId: BranchId.make("branch-projection"),
      role,
      parts,
      createdAt: dateFromMillis(0),
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      metadata: undefined,
      // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
      turnDurationMs: undefined,
    })

  test("an assistant answer projects its pieces in the order the model produced them", () => {
    const message = makeMessage("a-segments", "assistant", [
      Prompt.reasoningPart({ text: "thinking" }),
      Prompt.textPart({ text: "before" }),
      Prompt.toolCallPart({ id: "tc-1", name: "read", params: {}, providerExecuted: false }),
      Prompt.textPart({ text: "after" }),
      Prompt.toolCallPart({ id: "tc-2", name: "read", params: {}, providerExecuted: false }),
    ])
    const [projected] = projectMessagesWithToolInteractions([
      message,
      makeMessage("t-segments", "tool", [
        Prompt.toolResultPart({
          id: "tc-1",
          name: "read",
          result: "ok",
          isFailure: false,
          providerExecuted: false,
        }),
      ]),
    ])
    expect(projected?.segments).toEqual([
      { _tag: "Reasoning", content: "thinking" },
      { _tag: "Text", content: "before" },
      { _tag: "ToolCall", toolCallId: ToolCallId.make("tc-1") },
      { _tag: "Text", content: "after" },
      // A call still running carries a segment; its interaction says "running".
      { _tag: "ToolCall", toolCallId: ToolCallId.make("tc-2") },
    ])
    expect(projected?.toolInteractions.map((entry) => entry.status)).toEqual([
      "completed",
      "running",
    ])
  })

  test("an image part becomes a segment and a non-assistant message gets none", () => {
    const assistant = Message.cases.regular.make({
      id: MessageId.make("a-image"),
      sessionId: SessionId.make("session-projection"),
      branchId: BranchId.make("branch-projection"),
      role: "assistant",
      parts: [
        Prompt.filePart({ mediaType: "image/png", data: "" }),
        Prompt.filePart({ mediaType: "application/pdf", data: "" }),
      ],
      createdAt: dateFromMillis(0),
    })
    const user = Message.cases.regular.make({
      id: MessageId.make("u-image"),
      sessionId: SessionId.make("session-projection"),
      branchId: BranchId.make("branch-projection"),
      role: "user",
      parts: [Prompt.textPart({ text: "hello" })],
      createdAt: dateFromMillis(0),
    })
    const projected = projectMessagesWithToolInteractions([assistant, user])
    // A non-image file carries no transcript segment.
    expect(projected[0]?.segments).toEqual([{ _tag: "Image", mediaType: "image/png" }])
    expect(projected[1]?.segments).toEqual([])
  })

  test("a tool call's duration is the gap between its started and terminal receipts", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const done = ToolCallId.make("tc-done")
    const failed = ToolCallId.make("tc-failed")
    const open = ToolCallId.make("tc-open")
    const envelope = (id: number, createdAt: number, event: AgentEvent) =>
      EventEnvelope.make({ id: EventId.make(id), createdAt, event })
    const started = (toolCallId: ToolCallId) =>
      AgentEvent.cases.ToolCallStarted.make({ sessionId, branchId, toolCallId, toolName: "cell" })
    const events = [
      envelope(1, 1_000, started(done)),
      envelope(2, 1_200, started(failed)),
      envelope(3, 1_300, started(open)),
      envelope(
        4,
        2_250,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: done,
          toolName: "cell",
        }),
      ),
      envelope(
        5,
        1_212,
        AgentEvent.cases.ToolCallFailed.make({
          sessionId,
          branchId,
          toolCallId: failed,
          toolName: "cell",
        }),
      ),
    ]
    const durations = toolCallDurations(events)
    expect(durations.get(done)).toBe(1_250)
    expect(durations.get(failed)).toBe(12)
    expect(durations.has(open)).toBe(false)

    const call = (id: ToolCallId) =>
      Prompt.toolCallPart({ id, name: "cell", params: { code: "1" }, providerExecuted: false })
    const result = (id: ToolCallId) =>
      Prompt.toolResultPart({
        id,
        name: "cell",
        isFailure: false,
        providerExecuted: false,
        result: 1,
      })
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [call(done), call(open)]),
        makeMessage("t", "tool", [result(done)]),
      ],
      durations,
    )
    expect(projected[0]?.toolInteractions.map((entry) => entry.durationMs)).toEqual([1_250, absent])
  })

  test("projects Gent transcript parts without exposing persisted field names", () => {
    const toolCallId = ToolCallId.make("tc-projection")
    const textPart = Prompt.textPart({ text: "hello" })
    const imagePart = Prompt.filePart({
      data: "data:image/png;base64,abc",
      mediaType: "image/png",
    })
    const toolCallPart = Prompt.toolCallPart({
      id: toolCallId,
      name: "read",
      params: { path: "README.md" },
      providerExecuted: false,
    })
    const toolResultPart = Prompt.toolResultPart({
      id: toolCallId,
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: { ok: true },
    })
    const parts = [textPart, imagePart, toolCallPart, toolResultPart]

    expect(messagePartsText(parts)).toBe("hello")
    expect(messagePartsTextLines(parts)).toEqual(["hello"])
    expect(messageSingleText(parts)).toBeUndefined()
    expect(messagePartsReasoning(parts)).toBe("")
    expect(messagePartsImages(parts)).toEqual([{ mediaType: "image/png" }])
    expect(messagePartsToolCallParts(parts)).toEqual([toolCallPart])
  })

  test("preserves line-oriented text and reasoning projections", () => {
    const first = Prompt.textPart({ text: "one" })
    const parts = [first, Prompt.reasoningPart({ text: "think" }), Prompt.textPart({ text: "two" })]

    expect(messageSingleText([first])).toBe("one")
    expect(messagePartsText(parts)).toBe("onetwo")
    expect(messagePartsTextLines(parts)).toEqual(["one", "two"])
    expect(messagePartsReasoning(parts)).toBe("think")
  })

  test("pairs duplicate provider tool ids with the result before the next duplicate call", () => {
    const firstCall = Prompt.toolCallPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      params: { path: "first.txt" },
      providerExecuted: false,
    })
    const secondCall = Prompt.toolCallPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      params: { path: "second.txt" },
      providerExecuted: false,
    })
    const firstResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: "first result",
    })
    const secondResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: "second result",
    })

    const projected = projectMessagesWithToolInteractions([
      makeMessage("m-assistant-1", "assistant", [firstCall]),
      makeMessage("m-tool-1", "tool", [firstResult]),
      makeMessage("m-assistant-2", "assistant", [secondCall]),
      makeMessage("m-tool-2", "tool", [secondResult]),
    ])

    expect(projected[0]?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc-1"),
      toolName: "read",
      status: "completed",
      input: { path: "first.txt" },
      summary: "first result",
      output: "first result",
      durationMs: absent,
    })
    expect(projected[2]?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc-1"),
      toolName: "read",
      status: "completed",
      input: { path: "second.txt" },
      summary: "second result",
      output: "second result",
      durationMs: absent,
    })
  })

  test("pairs same-message duplicate provider tool ids by part order", () => {
    const firstCall = Prompt.toolCallPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      params: { path: "first.txt" },
      providerExecuted: false,
    })
    const secondCall = Prompt.toolCallPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      params: { path: "second.txt" },
      providerExecuted: false,
    })
    const firstResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: "first result",
    })
    const secondResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: "second result",
    })

    const projected = projectMessagesWithToolInteractions([
      makeMessage("m-assistant", "assistant", [firstCall, secondCall]),
      makeMessage("m-tool-1", "tool", [firstResult]),
      makeMessage("m-tool-2", "tool", [secondResult]),
    ])

    expect(projected[0]?.toolInteractions).toEqual([
      {
        id: ToolCallId.make("tc-1"),
        toolName: "read",
        status: "completed",
        input: { path: "first.txt" },
        summary: "first result",
        output: "first result",
        durationMs: absent,
      },
      {
        id: ToolCallId.make("tc-1"),
        toolName: "read",
        status: "completed",
        input: { path: "second.txt" },
        summary: "second result",
        output: "second result",
        durationMs: absent,
      },
    ])
  })

  test("projects Effect response parts back to Gent transcript parts", () => {
    const projection = projectResponsePartsToMessageParts([
      Response.makePart("text", { text: "hi" }),
      Response.makePart("file", {
        data: Uint8Array.from(Buffer.from("abc")),
        mediaType: "image/png",
      }),
      Response.makePart("tool-approval-request", {
        approvalId: "approval-2",
        toolCallId: "tc-approval-2",
      }),
      Response.makePart("tool-result", {
        id: "tc-2",
        name: "read",
        isFailure: false,
        result: "visible",
        encodedResult: { value: "encoded" },
        providerExecuted: false,
        preliminary: false,
      }),
    ])

    expect(projection.assistant).toEqual([
      Prompt.textPart({ text: "hi" }),
      Prompt.filePart({ data: "data:image/png;base64,YWJj", mediaType: "image/png" }),
      Prompt.toolApprovalRequestPart({ approvalId: "approval-2", toolCallId: "tc-approval-2" }),
    ])
    expect(projection.tool).toEqual([
      Prompt.toolResultPart({
        id: ToolCallId.make("tc-2"),
        name: "read",
        isFailure: false,
        providerExecuted: false,
        result: { value: "encoded" },
      }),
    ])
  })

  test("a child's answer is its last assistant text, or its reasoning when the model wrote nothing else", () => {
    const reasoningOnly = [
      makeMessage("a-1", "assistant", [
        Prompt.reasoningPart({ text: "I analyzed the repository" }),
      ]),
    ]
    expect(latestAssistantText(reasoningOnly)).toBe("I analyzed the repository")
    const mixed = [
      makeMessage("a-2", "assistant", [
        Prompt.reasoningPart({ text: "thinking step" }),
        Prompt.textPart({ text: "the actual answer" }),
      ]),
    ]
    expect(latestAssistantText(mixed)).toBe("the actual answer")
    const latestWins = [
      makeMessage("a-3", "assistant", [Prompt.textPart({ text: "first" })]),
      makeMessage("t-3", "tool", [
        Prompt.toolResultPart({
          id: ToolCallId.make("tc-3"),
          name: "bash",
          isFailure: false,
          providerExecuted: false,
          result: "ok",
        }),
      ]),
      makeMessage("a-4", "assistant", [Prompt.textPart({ text: "second" })]),
    ]
    expect(latestAssistantText(latestWins)).toBe("second")
    expect(latestAssistantText([])).toBe("")
  })
})
