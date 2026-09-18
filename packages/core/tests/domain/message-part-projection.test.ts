import { describe, expect, test } from "bun:test"
import {
  dateFromMillis,
  latestAssistantText,
  Message,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsText,
  messagePartsTextLines,
  messagePartsToolCallParts,
  messageSingleText,
  messagesToolCalls,
  projectMessagesWithToolInteractions,
  projectResponsePartsToMessageParts,
  toolCallDurations,
} from "../../src/domain/message"
import { AgentEvent, EventEnvelope, EventId } from "../../src/domain/event"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

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

  test("finished tool calls keep object params and drop scalar or array params", () => {
    const call = (id: string, name: string, params: Prompt.ToolCallPart["params"]) =>
      Prompt.toolCallPart({ id: ToolCallId.make(id), name, params, providerExecuted: false })
    const result = (id: string, name: string, isFailure: boolean) =>
      Prompt.toolResultPart({
        id: ToolCallId.make(id),
        name,
        isFailure,
        providerExecuted: false,
        result: "done",
      })
    const messages = [
      makeMessage("a-1", "assistant", [
        call("scalar", "scalar-tool", "scalar input"),
        call("array", "array-tool", ["array", 1]),
        call("object", "object-tool", { path: "src", limit: 2 }),
        call("pending", "slow-tool", {}),
      ]),
      makeMessage("t-1", "tool", [
        result("scalar", "scalar-tool", false),
        result("array", "array-tool", true),
        result("object", "object-tool", false),
      ]),
    ]
    expect(messagesToolCalls(messages)).toEqual([
      { toolName: "scalar-tool", args: {}, isError: false },
      { toolName: "array-tool", args: {}, isError: true },
      { toolName: "object-tool", args: { path: "src", limit: 2 }, isError: false },
    ])
    expect(messagesToolCalls([])).toEqual([])
  })
})
