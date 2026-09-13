import { describe, expect, test } from "bun:test"
import {
  messagePartsImages,
  messagePartsReasoning,
  messagePartsReasoningLines,
  messagePartsSearchText,
  messagePartsText,
  messagePartsTextLines,
  latestAssistantText,
  messagesToolCalls,
  projectMessagesWithToolInteractions,
  messagePartsToolCallParts,
  messageSingleText,
} from "../../src/domain/message-part-display"
import {
  responsePartToAssistantMessagePart,
  responsePartToToolResultPart,
} from "../../src/domain/response-to-prompt"
import { BranchId, MessageId, SessionId, ToolCallId } from "../../src/domain/ids"
import { dateFromMillis, Message } from "../../src/domain/message"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

describe("message part projection", () => {
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
    expect(messagePartsReasoningLines(parts)).toEqual([])
    expect(messagePartsImages(parts)).toEqual([
      { image: "data:image/png;base64,abc", mediaType: "image/png", rawMediaType: "image/png" },
    ])
    expect(messagePartsToolCallParts(parts)).toEqual([toolCallPart])
    expect(messagePartsSearchText(parts)).toBe(
      'hello\nimage/png data:image/png;base64,abc\nread {"path":"README.md"}\nread {"ok":true}',
    )
  })

  test("preserves line-oriented text and reasoning projections", () => {
    const first = Prompt.textPart({ text: "one" })
    const parts = [first, Prompt.reasoningPart({ text: "think" }), Prompt.textPart({ text: "two" })]

    expect(messageSingleText([first])).toBe("one")
    expect(messagePartsText(parts)).toBe("onetwo")
    expect(messagePartsTextLines(parts)).toEqual(["one", "two"])
    expect(messagePartsReasoning(parts)).toBe("think")
    expect(messagePartsReasoningLines(parts)).toEqual(["think"])
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
    })
    expect(projected[2]?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc-1"),
      toolName: "read",
      status: "completed",
      input: { path: "second.txt" },
      summary: "second result",
      output: "second result",
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
      },
      {
        id: ToolCallId.make("tc-1"),
        toolName: "read",
        status: "completed",
        input: { path: "second.txt" },
        summary: "second result",
        output: "second result",
      },
    ])
  })

  test("projects Effect response parts back to Gent transcript parts", () => {
    expect(responsePartToAssistantMessagePart(Response.makePart("text", { text: "hi" }))).toEqual(
      Prompt.textPart({ text: "hi" }),
    )

    expect(
      responsePartToAssistantMessagePart(
        Response.makePart("file", {
          data: Uint8Array.from(Buffer.from("abc")),
          mediaType: "image/png",
        }),
      ),
    ).toEqual(
      Prompt.filePart({
        data: "data:image/png;base64,YWJj",
        mediaType: "image/png",
      }),
    )

    expect(
      responsePartToToolResultPart(
        Response.makePart("tool-result", {
          id: "tc-2",
          name: "read",
          isFailure: false,
          result: "visible",
          encodedResult: { value: "encoded" },
          providerExecuted: false,
          preliminary: false,
        }),
      ),
    ).toEqual(
      Prompt.toolResultPart({
        id: ToolCallId.make("tc-2"),
        name: "read",
        isFailure: false,
        providerExecuted: false,
        result: { value: "encoded" },
      }),
    )

    expect(
      responsePartToAssistantMessagePart(
        Response.makePart("tool-approval-request", {
          approvalId: "approval-2",
          toolCallId: "tc-approval-2",
        }),
      ),
    ).toEqual(
      Prompt.toolApprovalRequestPart({
        approvalId: "approval-2",
        toolCallId: "tc-approval-2",
      }),
    )
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
