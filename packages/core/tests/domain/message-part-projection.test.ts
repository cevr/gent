import { describe, expect, test } from "bun:test"
import {
  assistantMessagePartToResponsePart,
  messagePartToPromptPart,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsReasoningLines,
  messagePartsSearchText,
  messagePartsText,
  messagePartsTextLines,
  projectMessagesWithToolInteractions,
  messagePartsToolCallParts,
  messagePartsToolCalls,
  messagePartsToolResultParts,
  messagePartsToolResults,
  messageSingleText,
  responsePartToAssistantMessagePart,
  responsePartToToolResultPart,
  toolResultPartToResponsePart,
} from "@gent/core-internal/domain/message-part-projection"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

describe("message part projection", () => {
  const makeMessage = (
    id: string,
    role: "assistant" | "tool",
    parts: ReadonlyArray<Prompt.TextPart | Prompt.ToolCallPart | Prompt.ToolResultPart>,
  ) =>
    Message.Regular.make({
      id: MessageId.make(id),
      sessionId: SessionId.make("session-projection"),
      branchId: BranchId.make("branch-projection"),
      role,
      parts,
      createdAt: dateFromMillis(0),
      metadata: undefined,
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
    expect(messagePartsToolCalls(parts)).toEqual([
      { id: "tc-projection", toolName: "read", input: { path: "README.md" } },
    ])
    expect(messagePartsToolResults(parts)).toEqual([
      {
        id: "tc-projection",
        toolName: "read",
        value: { ok: true },
        summary: '{"ok":true}',
        text: '{\n  "ok": true\n}',
        isError: false,
      },
    ])
    expect(messagePartsToolCallParts(parts)).toEqual([toolCallPart])
    expect(messagePartsToolResultParts(parts)).toEqual([toolResultPart])
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

  test("maps Gent images to Effect prompt file parts", () => {
    const promptPart = messagePartToPromptPart(
      Prompt.filePart({
        data: "data:image/jpeg;base64,abc",
        mediaType: "image/jpeg",
      }),
    )

    expect(promptPart).toEqual(
      expect.objectContaining({
        type: "file",
        data: "data:image/jpeg;base64,abc",
        mediaType: "image/jpeg",
      }),
    )
  })

  test("maps Gent tool calls to Effect prompt and response parts", () => {
    const part = Prompt.toolCallPart({
      id: ToolCallId.make("tc-1"),
      name: "search",
      params: { query: "effect" },
      providerExecuted: false,
    })

    expect(messagePartToPromptPart(part)).toEqual(
      expect.objectContaining({
        type: "tool-call",
        id: "tc-1",
        name: "search",
        params: { query: "effect" },
        providerExecuted: false,
      }),
    )
    expect(assistantMessagePartToResponsePart(part)).toEqual(
      expect.objectContaining({
        type: "tool-call",
        id: "tc-1",
        name: "search",
        params: { query: "effect" },
        providerExecuted: false,
      }),
    )
  })

  test("maps Gent tool results to Effect result fields", () => {
    const part = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "search",
      isFailure: true,
      result: { message: "nope" },
    })

    expect(messagePartToPromptPart(part)).toEqual(
      expect.objectContaining({
        type: "tool-result",
        id: "tc-1",
        name: "search",
        isFailure: true,
        result: { message: "nope" },
      }),
    )
    expect(toolResultPartToResponsePart(part)).toEqual(
      expect.objectContaining({
        type: "tool-result",
        id: "tc-1",
        name: "search",
        isFailure: true,
        result: { message: "nope" },
        encodedResult: { message: "nope" },
        providerExecuted: false,
        preliminary: false,
      }),
    )
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
      result: "first result",
    })
    const secondResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
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
      result: "first result",
    })
    const secondResult = Prompt.toolResultPart({
      id: ToolCallId.make("tc-1"),
      name: "read",
      isFailure: false,
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

  test("uses URL-backed images for Prompt and rejects them for Response", () => {
    const part = Prompt.filePart({
      data: "https://example.test/image.png",
      mediaType: "image/png",
    })

    expect(messagePartToPromptPart(part)).toEqual(
      expect.objectContaining({
        type: "file",
        data: "https://example.test/image.png",
        mediaType: "image/png",
      } satisfies Partial<Prompt.FilePart>),
    )
    expect(() => assistantMessagePartToResponsePart(part)).toThrow(
      'responsePartsFromMessages only supports data URL images; cannot encode URL-backed image "https://example.test/image.png"',
    )
  })
})
