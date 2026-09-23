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
  toolCallReceipts,
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

  test("a cut keeps every emoji whole and the marker inside the cap", () => {
    const text = "😀".repeat(200)
    for (const maxChars of [101, 150, 257]) {
      const result = headTailChars(text, maxChars)
      expect(result.text.length).toBeLessThanOrEqual(maxChars)
      expect(LONE_SURROGATE.test(result.text)).toBe(false)
    }
  })
})

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

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
    const receipts = toolCallReceipts(events)

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
        makeMessage("a", "assistant", [call(done), call(failed), call(open)]),
        makeMessage("t", "tool", [result(done), result(failed)]),
      ],
      receipts,
    )
    expect(projected[0]?.toolInteractions.map((entry) => entry.durationMs)).toEqual([
      1_250,
      12,
      absent,
    ])
  })

  test("a cell's operations come back from their stored receipts", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const cell = ToolCallId.make("tc-cell")
    const read = ToolCallId.make("tc-read")
    const lost = ToolCallId.make("tc-lost")
    const forked = ToolCallId.make("tc-forked")
    const noText = Option.getOrUndefined(Option.none<string>())
    const envelope = (id: number, createdAt: number, event: AgentEvent) =>
      EventEnvelope.make({ id: EventId.make(id), createdAt, event })
    const events = [
      envelope(
        1,
        1_000,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: cell,
          toolName: "cell",
        }),
      ),
      envelope(
        2,
        1_010,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: read,
          toolName: "read",
          input: { path: "a.md" },
          parentToolCallId: cell,
        }),
      ),
      envelope(
        3,
        1_040,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: read,
          toolName: "read",
          summary: "3 lines",
          output: "one\ntwo\nthree",
          parentToolCallId: cell,
        }),
      ),
      // A crash left this operation with no terminal receipt.
      envelope(
        4,
        1_050,
        AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: lost,
          toolName: "bash",
          input: { command: "ls" },
          parentToolCallId: cell,
        }),
      ),
      envelope(
        5,
        1_100,
        AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: cell,
          toolName: "cell",
        }),
      ),
    ]
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
        makeMessage("a", "assistant", [call(cell), call(forked)]),
        makeMessage("t", "tool", [result(cell), result(forked)]),
      ],
      toolCallReceipts(events),
    )
    const [cellInteraction, forkedInteraction] = projected[0]?.toolInteractions ?? []
    expect(cellInteraction?.operations).toEqual([
      {
        id: read,
        toolName: "read",
        status: "completed",
        input: { path: "a.md" },
        summary: "3 lines",
        // A short output is its own bounded excerpt.
        output: "one\ntwo\nthree",
        durationMs: 30,
      },
      // The cell settled, so an operation that never ended is not running.
      {
        id: lost,
        toolName: "bash",
        status: "error",
        input: { command: "ls" },
        summary: noText,
        output: noText,
        durationMs: absent,
      },
    ])
    // A forked branch copies messages, not events: the saved receipts stay the fallback.
    expect(forkedInteraction?.operations).toBeUndefined()
    // Operations are not top-level calls.
    expect(projected[0]?.toolInteractions.map((entry) => entry.id)).toEqual([cell, forked])
  })

  test("two steps that reuse a cell call id each show only their own operations", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    // Providers can reuse a call id across steps; storage keys a cell by its message too.
    const cell = ToolCallId.make("tc-reused")
    const op = ToolCallId.make("tc-op-reused")
    const envelope = (id: number, event: AgentEvent) =>
      EventEnvelope.make({ id: EventId.make(id), createdAt: id * 10, event })
    const step = (first: number, message: string, toolName: string) => {
      const assistantMessageId = MessageId.make(message)
      return [
        envelope(
          first,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: cell,
            toolName: "cell",
            assistantMessageId,
          }),
        ),
        envelope(
          first + 1,
          AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName,
            input: {},
            parentToolCallId: cell,
            assistantMessageId,
          }),
        ),
        envelope(
          first + 2,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName,
            summary: `${toolName} done`,
            parentToolCallId: cell,
            assistantMessageId,
          }),
        ),
        envelope(
          first + 3,
          AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: cell,
            toolName: "cell",
            assistantMessageId,
          }),
        ),
      ]
    }
    const call = Prompt.toolCallPart({
      id: cell,
      name: "cell",
      params: { code: "1" },
      providerExecuted: false,
    })
    const result = Prompt.toolResultPart({
      id: cell,
      name: "cell",
      isFailure: false,
      providerExecuted: false,
      result: 1,
    })
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("step-1", "assistant", [call]),
        makeMessage("step-1-tools", "tool", [result]),
        makeMessage("step-2", "assistant", [call]),
        makeMessage("step-2-tools", "tool", [result]),
      ],
      toolCallReceipts([...step(1, "step-1", "read"), ...step(5, "step-2", "bash")]),
    )
    const opsOf = (index: number) =>
      projected[index]?.toolInteractions[0]?.operations?.map((entry) => [
        entry.toolName,
        entry.summary,
      ])
    expect(opsOf(0)).toEqual([["read", "read done"]])
    expect(opsOf(2)).toEqual([["bash", "bash done"]])
  })

  test("two steps that reuse a call id each show their own duration", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const reused = ToolCallId.make("call_0")
    const run = (message: string, first: number, startedAt: number, endedAt: number) => {
      const assistantMessageId = MessageId.make(message)
      return [
        EventEnvelope.make({
          id: EventId.make(first),
          createdAt: startedAt,
          event: AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: reused,
            toolName: "read",
            assistantMessageId,
          }),
        }),
        EventEnvelope.make({
          id: EventId.make(first + 1),
          createdAt: endedAt,
          event: AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: reused,
            toolName: "read",
            assistantMessageId,
          }),
        }),
      ]
    }
    const call = Prompt.toolCallPart({
      id: reused,
      name: "read",
      params: {},
      providerExecuted: false,
    })
    const result = Prompt.toolResultPart({
      id: reused,
      name: "read",
      isFailure: false,
      providerExecuted: false,
      result: 1,
    })
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("m1", "assistant", [call]),
        makeMessage("m1-tools", "tool", [result]),
        makeMessage("m2", "assistant", [call]),
        makeMessage("m2-tools", "tool", [result]),
      ],
      toolCallReceipts([...run("m1", 1, 1_000, 6_000), ...run("m2", 3, 7_000, 7_010)]),
    )
    expect(projected[0]?.toolInteractions[0]?.durationMs).toBe(5_000)
    expect(projected[2]?.toolInteractions[0]?.durationMs).toBe(10)
  })

  test("an operation with a large input and output projects a bounded row", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const cell = ToolCallId.make("tc-cell-large")
    const write = ToolCallId.make("tc-write-large")
    const large = "x".repeat(50_000)
    const events = [
      EventEnvelope.make({
        id: EventId.make(1),
        createdAt: 0,
        event: AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId: write,
          toolName: "write",
          input: { path: "big.txt", content: large, nested: { content: large } },
          parentToolCallId: cell,
        }),
      }),
      EventEnvelope.make({
        id: EventId.make(2),
        createdAt: 5,
        event: AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId: write,
          toolName: "write",
          summary: large,
          output: large,
          parentToolCallId: cell,
        }),
      }),
    ]
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [
          Prompt.toolCallPart({ id: cell, name: "cell", params: {}, providerExecuted: false }),
        ]),
      ],
      toolCallReceipts(events),
    )
    const [operation] = projected[0]?.toolInteractions[0]?.operations ?? []
    // A field too large for the budget is left out whole, never cut: a cut
    // string draws wrong content.
    expect(operation?.input).toEqual({ path: "big.txt" })
    expect(operation?.summary).toBe(`${"x".repeat(100)}...`)
    // The output keeps a bounded excerpt, not the full 50 KB: the whole
    // operation fits one encoded budget.
    expect(operation?.output?.startsWith("x")).toBe(true)
    expect(
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(operation).length,
    ).toBeLessThanOrEqual(8_192)
  })

  test("an operation with many short fields stays within one encoded budget", () => {
    const sessionId = SessionId.make("session-budget")
    const branchId = BranchId.make("branch-budget")
    const cell = ToolCallId.make("tc-cell-budget")
    const op = ToolCallId.make("tc-op-budget")
    // Short strings and numbers alike: each field's key costs as much as its value.
    const many = Object.fromEntries([
      ...Array.from({ length: 1_500 }, (_, index) => [`text_${index}`, "v"]),
      ...Array.from({ length: 1_500 }, (_, index) => [`count_${index}`, index]),
    ])
    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [
          Prompt.toolCallPart({ id: cell, name: "cell", params: {}, providerExecuted: false }),
        ]),
      ],
      toolCallReceipts([
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 1,
          event: AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName: "bash",
            input: many,
            parentToolCallId: cell,
          }),
        }),
        EventEnvelope.make({
          id: EventId.make(2),
          createdAt: 2,
          event: AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName: "bash",
            summary: "done",
            output: encodeJson(many),
            parentToolCallId: cell,
          }),
        }),
      ]),
    )
    const [operation] = projected[0]?.toolInteractions[0]?.operations ?? []
    // Keys and kept numbers count against the budget, not only strings.
    expect(encodeJson(operation).length).toBeLessThanOrEqual(8_192)
    expect(
      Object.keys(
        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(operation?.input),
      ).length,
    ).toBeGreaterThan(0)
  })

  test("a cut output carries its whole line count and the line its tail starts on", () => {
    const sessionId = SessionId.make("session-cut")
    const branchId = BranchId.make("branch-cut")
    const cell = ToolCallId.make("tc-cell-cut")
    const op = ToolCallId.make("tc-op-cut")
    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
    // Every line is emoji, so any cut that splits a pair shows up.
    const stdout = Array.from({ length: 3_000 }, (_, index) => `😀 line ${index + 1}`).join("\n")
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [
          Prompt.toolCallPart({ id: cell, name: "cell", params: {}, providerExecuted: false }),
        ]),
      ],
      toolCallReceipts([
        EventEnvelope.make({
          id: EventId.make(1),
          createdAt: 1,
          event: AgentEvent.cases.ToolCallStarted.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName: "bash",
            input: { command: "seq" },
            parentToolCallId: cell,
          }),
        }),
        EventEnvelope.make({
          id: EventId.make(2),
          createdAt: 2,
          event: AgentEvent.cases.ToolCallSucceeded.make({
            sessionId,
            branchId,
            toolCallId: op,
            toolName: "bash",
            summary: "done",
            output: encodeJson({ stdout, stderr: "", exitCode: 0 }),
            parentToolCallId: cell,
          }),
        }),
      ]),
    )
    const [operation] = projected[0]?.toolInteractions[0]?.operations ?? []
    const output = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Finite }),
      ),
    )(operation?.output)
    expect(output.exitCode).toBe(0)
    expect(output.stderr).toBe("")
    expect(LONE_SURROGATE.test(output.stdout)).toBe(false)
    const [cut] = operation?.cuts ?? []
    expect(cut?._tag).toBe("Text")
    if (cut?._tag !== "Text") return
    expect(cut.field).toBe("stdout")
    expect(cut.lines).toBe(3_000)
    const tailLine = cut.tailLine
    // The excerpt is head lines, one marker line, then the tail from `tailLine` to the end.
    const excerpt = output.stdout.split("\n")
    const tail = excerpt.slice(-(3_000 - tailLine + 1))
    expect(excerpt[0]).toBe("😀 line 1")
    expect(tail.at(-1)).toBe("😀 line 3000")
    expect(tail[0]).toBe(`😀 line ${tailLine}`)
    expect(tail[1]).toBe(`😀 line ${tailLine + 1}`)
    expect(encodeJson(operation).length).toBeLessThanOrEqual(8_192)
  })

  test("a reloaded operation keeps a bash exit code and the whole edit it drew", () => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const cell = ToolCallId.make("tc-cell-row")
    const bash = ToolCallId.make("tc-bash-row")
    const edit = ToolCallId.make("tc-edit-row")
    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
    const stdout = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")
    const editInput = {
      path: `/workspace/${"deeply/nested/".repeat(10)}module.ts`,
      oldString: `export const value = "${"a".repeat(150)}"`,
      newString: `export const value = "${"b".repeat(150)}"\nexport const other = 1`,
    }
    const started = (
      id: number,
      toolCallId: ToolCallId,
      toolName: string,
      input: Readonly<Record<string, string>>,
    ) =>
      EventEnvelope.make({
        id: EventId.make(id),
        createdAt: id,
        event: AgentEvent.cases.ToolCallStarted.make({
          sessionId,
          branchId,
          toolCallId,
          toolName,
          input,
          parentToolCallId: cell,
        }),
      })
    const succeeded = (id: number, toolCallId: ToolCallId, toolName: string, output: string) =>
      EventEnvelope.make({
        id: EventId.make(id),
        createdAt: id,
        event: AgentEvent.cases.ToolCallSucceeded.make({
          sessionId,
          branchId,
          toolCallId,
          toolName,
          summary: "done",
          output,
          parentToolCallId: cell,
        }),
      })
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [
          Prompt.toolCallPart({ id: cell, name: "cell", params: {}, providerExecuted: false }),
        ]),
      ],
      toolCallReceipts([
        started(1, bash, "bash", { command: "bun test" }),
        succeeded(2, bash, "bash", encodeJson({ stdout, stderr: "1 fail", exitCode: 1 })),
        started(3, edit, "edit", editInput),
        succeeded(4, edit, "edit", encodeJson({ path: editInput.path, replacements: 1 })),
      ]),
    )
    const [bashOp, editOp] = projected[0]?.toolInteractions[0]?.operations ?? []
    const bashOutput = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Finite }),
      ),
    )(bashOp?.output)
    // A failed command still reads as failed after a reload.
    expect(bashOutput.exitCode).toBe(1)
    expect(bashOutput.stderr).toBe("1 fail")
    // Output within the size bound is kept whole: a cut would renumber the
    // lines the row draws, so the reloaded row would differ from the live one.
    expect(bashOutput.stdout).toBe(stdout)
    // The edit keeps the whole strings its diff is built from, and its path.
    expect(editOp?.input).toEqual(editInput)
  })

  /** One op a cell admitted, projected as a reload reads it. */
  const projectOperation = (
    toolName: string,
    input: Readonly<Record<string, string>>,
    output: string,
    options: { readonly id?: string; readonly running?: boolean } = {},
  ) => {
    const sessionId = SessionId.make("session-projection")
    const branchId = BranchId.make("branch-projection")
    const cell = ToolCallId.make("tc-cell-op")
    const op = ToolCallId.make(options.id ?? "tc-op")
    const started = EventEnvelope.make({
      id: EventId.make(1),
      createdAt: 1,
      event: AgentEvent.cases.ToolCallStarted.make({
        sessionId,
        branchId,
        toolCallId: op,
        toolName,
        input,
        parentToolCallId: cell,
      }),
    })
    const succeeded = EventEnvelope.make({
      id: EventId.make(2),
      createdAt: 2,
      event: AgentEvent.cases.ToolCallSucceeded.make({
        sessionId,
        branchId,
        toolCallId: op,
        toolName,
        summary: "done",
        output,
        parentToolCallId: cell,
      }),
    })
    // A running op has no terminal receipt yet.
    const receipts = [started]
    if (options.running !== true) receipts.push(succeeded)
    const projected = projectMessagesWithToolInteractions(
      [
        makeMessage("a", "assistant", [
          Prompt.toolCallPart({ id: cell, name: "cell", params: {}, providerExecuted: false }),
        ]),
      ],
      toolCallReceipts(receipts),
    )
    const [operation] = projected[0]?.toolInteractions[0]?.operations ?? []
    return operation
  }
  const encodeValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
  const BashOutputJson = Schema.fromJsonString(
    Schema.Struct({ stdout: Schema.String, stderr: Schema.String, exitCode: Schema.Finite }),
  )
  const GrepOutputJson = Schema.fromJsonString(
    Schema.Struct({
      matches: Schema.Array(
        Schema.Struct({ file: Schema.String, line: Schema.Finite, content: Schema.String }),
      ),
      truncated: Schema.Boolean,
    }),
  )

  test("a cut inside one long line records the characters it leaves out", () => {
    const json = encodeValue({
      rows: Array.from({ length: 800 }, (_, index) => ({ id: index, name: `row-${index}` })),
    })
    expect(json.length).toBeGreaterThan(20_000)
    expect(json.includes("\n")).toBe(false)
    const operation = projectOperation(
      "bash",
      { command: "curl api" },
      encodeValue({ stdout: json, stderr: "", exitCode: 0 }),
    )
    const output = Schema.decodeUnknownSync(BashOutputJson)(operation?.output)
    const [cut] = operation?.cuts ?? []
    expect(cut?._tag).toBe("Text")
    if (cut?._tag !== "Text") return
    expect(cut).toMatchObject({ field: "stdout", lines: 1, tailLine: 1 })
    const [head = "", tail = ""] = output.stdout.split("\n…\n")
    // Head, cut and tail together are the whole line: nothing goes missing unmarked.
    expect(head.length + cut.chars + tail.length).toBe(json.length)
    expect(json.startsWith(head)).toBe(true)
    expect(json.endsWith(tail)).toBe(true)
    expect(encodeValue(operation).length).toBeLessThanOrEqual(8_192)
  })

  test("a cut across lines keeps whole lines at its head and tail", () => {
    const stdout = Array.from({ length: 900 }, (_, index) => `${index + 1}:${"x".repeat(37)}`).join(
      "\n",
    )
    const operation = projectOperation(
      "bash",
      { command: "seq" },
      encodeValue({ stdout, stderr: "", exitCode: 0 }),
    )
    const output = Schema.decodeUnknownSync(BashOutputJson)(operation?.output)
    const [cut] = operation?.cuts ?? []
    expect(cut?._tag).toBe("Text")
    if (cut?._tag !== "Text") return
    const [head = "", tail = ""] = output.stdout.split("\n…\n")
    const whole = stdout.split("\n")
    const headLines = head.split("\n")
    const tailLines = tail.split("\n")
    expect(headLines).toEqual(whole.slice(0, headLines.length))
    expect(tailLines).toEqual(whole.slice(cut.tailLine - 1))
  })

  test("a reloaded grep op keeps the head and tail of its matches with a cut record", () => {
    const matches = Array.from({ length: 200 }, (_, index) => ({
      file: `src/module-${Math.floor(index / 20)}.ts`,
      line: index + 1,
      content: `const value${index} = compute(${index})`,
      context: { before: ["// above"], after: ["// below"] },
    }))
    const operation = projectOperation(
      "grep",
      { pattern: "value" },
      encodeValue({ matches, truncated: false }),
    )
    const output = Schema.decodeUnknownSync(GrepOutputJson)(operation?.output)
    const [cut] = operation?.cuts ?? []
    expect(cut?._tag).toBe("Items")
    if (cut?._tag !== "Items") return
    // Ten files hold the 200 matches; the cut counts them all, not only the kept ones.
    expect(cut).toMatchObject({ field: "matches", items: 200, files: 10 })
    const tailCount = 200 - cut.tailItem + 1
    const headCount = output.matches.length - tailCount
    expect(headCount).toBeGreaterThan(0)
    expect(tailCount).toBeGreaterThan(0)
    const drawn = (match: (typeof matches)[number]) => ({
      file: match.file,
      line: match.line,
      content: match.content,
    })
    expect(output.matches.slice(0, headCount)).toEqual(matches.slice(0, headCount).map(drawn))
    expect(output.matches.slice(headCount)).toEqual(matches.slice(cut.tailItem - 1).map(drawn))
    expect(output.truncated).toBe(false)
    expect(encodeValue(operation).length).toBeLessThanOrEqual(8_192)
  })

  test("a reloaded grep op that fits keeps every match and no cut", () => {
    const matches = Array.from({ length: 12 }, (_, index) => ({
      file: `src/module-${index % 3}.ts`,
      line: index + 1,
      content: `hit ${index}`,
    }))
    const operation = projectOperation(
      "grep",
      { pattern: "hit" },
      encodeValue({ matches, truncated: false }),
    )
    expect(Schema.decodeUnknownSync(GrepOutputJson)(operation?.output).matches).toEqual(matches)
    expect(operation?.cuts).toBeUndefined()
  })

  test("a reloaded edit keeps diff strings larger than the input share", () => {
    const input = {
      path: "/workspace/src/module.ts",
      oldString: Array.from(
        { length: 60 },
        (_, index) => `old line ${index} ${"a".repeat(40)}`,
      ).join("\n"),
      newString: Array.from(
        { length: 60 },
        (_, index) => `new line ${index} ${"b".repeat(40)}`,
      ).join("\n"),
    }
    expect(encodeValue(input).length).toBeGreaterThan(4_096)
    const operation = projectOperation(
      "edit",
      input,
      encodeValue({ path: input.path, replacements: 1 }),
    )
    expect(operation?.input).toEqual(input)
    expect(encodeValue(operation).length).toBeLessThanOrEqual(8_192)
  })

  test("an op with a long call id and a long tool name stays within the op budget", () => {
    const outputs = {
      none: encodeValue({}),
      text: "plain text result\n".repeat(1_000),
      bash: encodeValue({ stdout: "out\n".repeat(3_000), stderr: "", exitCode: 0 }),
      grep: encodeValue({
        matches: Array.from({ length: 300 }, (_, index) => ({
          file: `src/f${index % 7}.ts`,
          line: index,
          content: `hit ${index}`,
        })),
        truncated: false,
      }),
    }
    const input = { path: "/workspace/src/a.ts", oldString: "x".repeat(9_000) }
    const ids = { short: "tc-op", long: `tc-${"i".repeat(3_000)}`, huge: `tc-${"i".repeat(9_000)}` }
    const names = { short: "grep", long: `tool-${"n".repeat(9_000)}` }
    const cases = Object.entries(ids).flatMap(([idKind, id]) =>
      Object.entries(names).flatMap(([nameKind, toolName]) =>
        Object.entries(outputs).flatMap(([outputKind, output]) =>
          [false, true].map((running) => ({
            idKind,
            id,
            nameKind,
            toolName,
            output,
            running,
            outputKind,
          })),
        ),
      ),
    )
    for (const each of cases) {
      const operation = projectOperation(each.toolName, input, each.output, {
        id: each.id,
        running: each.running,
      })
      const path = `${each.idKind} id, ${each.nameKind} name, ${each.outputKind}, running ${each.running}`
      expect(encodeValue(operation).length, path).toBeLessThanOrEqual(8_192)
      const id = String(operation?.id)
      const toolName = String(operation?.toolName)
      // An id that fits stays whole: the live feed matches results to ops by it.
      if (each.idKind !== "huge") expect(id, path).toBe(each.id)
      if (each.idKind === "huge") expect(each.id.startsWith(id), path).toBe(true)
      if (each.nameKind === "short") expect(toolName, path).toBe(each.toolName)
      if (each.nameKind === "long") {
        expect(each.toolName.startsWith(toolName), path).toBe(true)
        expect(toolName.length, path).toBeLessThan(each.toolName.length)
      }
    }
  })

  test("an id that leaves only a few characters drops the input and output rather than overflow", () => {
    const input = { path: "/workspace/src/a.ts" }
    const bash = encodeValue({ stdout: "hello", stderr: "", exitCode: 0 })
    // Id lengths across the edge where the id fits whole with 0 to 60 characters left.
    for (let length = 8_020; length <= 8_100; length += 1) {
      const id = `tc-${"i".repeat(length)}`
      const operation = projectOperation("bash", input, bash, { id })
      expect(encodeValue(operation).length, `id length ${length}`).toBeLessThanOrEqual(8_192)
    }
  })

  test("an input that grows into the output room leaves a small body whole", () => {
    const bash = encodeValue({ stdout: "hello\nworld", stderr: "", exitCode: 0 })
    const grep = encodeValue({
      matches: [
        { file: "src/a.ts", line: 1, content: "hit one" },
        { file: "src/b.ts", line: 2, content: "hit two" },
      ],
      truncated: false,
    })
    // Input sizes across the edge where the input takes all the room the whole
    // output leaves; the step is narrower than a cut record, the space at risk.
    for (let filler = 7_700; filler <= 8_100; filler += 10) {
      const input = { path: "/workspace/src/a.ts", oldString: "x".repeat(filler) }
      const shell = projectOperation("bash", input, bash)
      expect(Schema.decodeUnknownSync(BashOutputJson)(shell?.output), `bash, ${filler}`).toEqual(
        Schema.decodeSync(BashOutputJson)(bash),
      )
      expect(shell?.cuts, `bash, filler ${filler}`).toBeUndefined()
      const search = projectOperation("grep", input, grep)
      expect(Schema.decodeUnknownSync(GrepOutputJson)(search?.output), `grep, ${filler}`).toEqual(
        Schema.decodeSync(GrepOutputJson)(grep),
      )
      expect(search?.cuts, `grep, filler ${filler}`).toBeUndefined()
      expect(encodeValue(search).length).toBeLessThanOrEqual(8_192)
    }
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

  test("image projection keeps every image in order and empty parts project to nothing", () => {
    const parts = [
      Prompt.textPart({ text: "Before" }),
      Prompt.filePart({ data: "abc", mediaType: "image/gif" }),
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: {},
        providerExecuted: false,
      }),
      Prompt.filePart({ data: "xyz", mediaType: "image/webp" }),
    ]

    expect(messagePartsImages(parts)).toEqual([
      { mediaType: "image/gif" },
      { mediaType: "image/webp" },
    ])
    expect(messagePartsText([])).toBe("")
    expect(messagePartsImages([])).toEqual([])
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
