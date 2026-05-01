import { describe, expect, test } from "bun:test"
import {
  assistantMessagePartToResponsePart,
  messagePartToPromptPart,
  messagePartsImages,
  messagePartsReasoning,
  messagePartsSearchText,
  messagePartsText,
  messagePartsToolCalls,
  messagePartsToolResults,
  responsePartToAssistantMessagePart,
  responsePartToToolResultPart,
  toolResultPartToResponsePart,
} from "@gent/core/domain/message-part-compat"
import { ToolCallId } from "@gent/core/domain/ids"
import { ImagePart, TextPart, ToolCallPart, ToolResultPart } from "@gent/core/domain/message"
import type * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

describe("message part compatibility", () => {
  test("projects Gent transcript parts without exposing persisted field names", () => {
    const toolCallId = ToolCallId.make("tc-projection")
    const parts = [
      new TextPart({ type: "text", text: "hello" }),
      new ImagePart({ type: "image", image: "data:image/png;base64,abc" }),
      new ToolCallPart({
        type: "tool-call",
        toolCallId,
        toolName: "read",
        input: { path: "README.md" },
      }),
      new ToolResultPart({
        type: "tool-result",
        toolCallId,
        toolName: "read",
        output: { type: "json", value: { ok: true } },
      }),
    ]

    expect(messagePartsText(parts)).toBe("hello")
    expect(messagePartsReasoning(parts)).toBe("")
    expect(messagePartsImages(parts)).toEqual([
      { image: "data:image/png;base64,abc", mediaType: "image", rawMediaType: undefined },
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
    expect(messagePartsSearchText(parts)).toBe(
      'hello\ndata:image/png;base64,abc\nread {"path":"README.md"}\nread {"ok":true}',
    )
  })

  test("maps Gent images to Effect prompt file parts", () => {
    const promptPart = messagePartToPromptPart(
      new ImagePart({
        type: "image",
        image: "data:image/jpeg;base64,abc",
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
    const part = new ToolCallPart({
      type: "tool-call",
      toolCallId: ToolCallId.make("tc-1"),
      toolName: "search",
      input: { query: "effect" },
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
    const part = new ToolResultPart({
      type: "tool-result",
      toolCallId: ToolCallId.make("tc-1"),
      toolName: "search",
      output: { type: "error-json", value: { message: "nope" } },
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

  test("projects Effect response parts back to Gent transcript parts", () => {
    expect(responsePartToAssistantMessagePart(Response.makePart("text", { text: "hi" }))).toEqual(
      new TextPart({ type: "text", text: "hi" }),
    )

    expect(
      responsePartToAssistantMessagePart(
        Response.makePart("file", {
          data: Uint8Array.from(Buffer.from("abc")),
          mediaType: "image/png",
        }),
      ),
    ).toEqual(
      new ImagePart({
        type: "image",
        image: "data:image/png;base64,YWJj",
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
      new ToolResultPart({
        type: "tool-result",
        toolCallId: ToolCallId.make("tc-2"),
        toolName: "read",
        output: { type: "json", value: { value: "encoded" } },
      }),
    )
  })

  test("uses URL-backed images for Prompt and rejects them for Response", () => {
    const part = new ImagePart({
      type: "image",
      image: "https://example.test/image.png",
      mediaType: "image/png",
    })

    expect(messagePartToPromptPart(part)).toEqual(
      expect.objectContaining({
        type: "file",
        data: new URL("https://example.test/image.png"),
        mediaType: "image/png",
      } satisfies Partial<Prompt.FilePart>),
    )
    expect(() => assistantMessagePartToResponsePart(part)).toThrow("data URL images")
  })
})
