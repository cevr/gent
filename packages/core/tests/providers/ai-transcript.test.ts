import { describe, expect, test } from "bun:test"
import {
  GENT_MESSAGE_METADATA_FIELDS,
  EFFECT_AI_CONTENT_FIELDS,
  responsePartsToMessageParts,
  toPrompt,
  toPromptMessages,
} from "@gent/core/providers/ai-transcript"
import { ToolCallId } from "@gent/core/domain/ids"
import {
  ImagePart,
  Message,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "@gent/core/domain/message"
import * as Response from "effect/unstable/ai/Response"

const baseMessage = (message: Omit<ConstructorParameters<typeof Message>[0], "createdAt">) =>
  new Message({
    ...message,
    createdAt: new Date(0),
  })

describe("AI transcript bridge", () => {
  test("converts visible Gent messages to Effect Prompt messages without Gent metadata", () => {
    const prompt = toPrompt(
      [
        baseMessage({
          id: "system-msg",
          sessionId: "session",
          branchId: "branch",
          role: "system",
          parts: [new TextPart({ type: "text", text: "Be precise." })],
        }),
        baseMessage({
          id: "user-msg",
          sessionId: "session",
          branchId: "branch",
          role: "user",
          kind: "interjection",
          metadata: { hidden: false, extensionId: "inline-image" },
          parts: [
            new TextPart({ type: "text", text: "What is this?" }),
            new ImagePart({
              type: "image",
              image: "data:image/jpeg;base64,abc",
              mediaType: "image/jpeg",
            }),
          ],
        }),
        baseMessage({
          id: "assistant-msg",
          sessionId: "session",
          branchId: "branch",
          role: "assistant",
          turnDurationMs: 12,
          parts: [
            new ReasoningPart({ type: "reasoning", text: "Inspect image first." }),
            new TextPart({ type: "text", text: "I see it." }),
            new ImagePart({
              type: "image",
              image: "data:image/png;base64,assistant-image",
              mediaType: "image/png",
            }),
            new ToolCallPart({
              type: "tool-call",
              toolCallId: ToolCallId.of("tc-1"),
              toolName: "describe",
              input: { image: true },
            }),
          ],
        }),
        baseMessage({
          id: "tool-msg",
          sessionId: "session",
          branchId: "branch",
          role: "tool",
          parts: [
            new ToolResultPart({
              type: "tool-result",
              toolCallId: ToolCallId.of("tc-1"),
              toolName: "describe",
              output: { type: "json", value: { label: "diagram" } },
            }),
          ],
        }),
      ],
      { systemPrompt: "Global policy." },
    )

    expect(prompt.content.map((message) => message.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ])
    expect(prompt.content[0]?.content).toBe("Global policy.")
    expect(prompt.content[1]?.content).toBe("Be precise.")

    const userMessage = prompt.content[2]
    expect(userMessage?.role).toBe("user")
    if (userMessage?.role === "user") {
      expect(userMessage.content[1]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/jpeg;base64,abc",
          mediaType: "image/jpeg",
        }),
      )
    }

    const assistantMessage = prompt.content[3]
    expect(assistantMessage?.role).toBe("assistant")
    if (assistantMessage?.role === "assistant") {
      expect(assistantMessage.content.map((part) => part.type)).toEqual([
        "reasoning",
        "text",
        "file",
        "tool-call",
      ])
      expect(assistantMessage.content[2]).toEqual(
        expect.objectContaining({
          type: "file",
          data: "data:image/png;base64,assistant-image",
          mediaType: "image/png",
        }),
      )
    }

    expect(GENT_MESSAGE_METADATA_FIELDS).toEqual([
      "id",
      "sessionId",
      "branchId",
      "kind",
      "createdAt",
      "turnDurationMs",
      "metadata",
    ])
    expect(EFFECT_AI_CONTENT_FIELDS).toEqual(["role", "parts"])
  })

  test("hidden metadata excludes messages from model context unless explicitly included", () => {
    const visible = baseMessage({
      id: "visible",
      sessionId: "session",
      branchId: "branch",
      role: "user",
      parts: [new TextPart({ type: "text", text: "send this" })],
    })
    const hidden = baseMessage({
      id: "hidden",
      sessionId: "session",
      branchId: "branch",
      role: "user",
      parts: [new TextPart({ type: "text", text: "hide this" })],
      metadata: { hidden: true },
    })

    expect(toPromptMessages([visible, hidden]).length).toBe(1)
    expect(toPromptMessages([visible, hidden], { includeHidden: true }).length).toBe(2)
  })

  test("converts Effect Response parts back to persisted assistant and tool parts", () => {
    const parts = responsePartsToMessageParts([
      Response.makePart("text", { text: "Done." }),
      Response.makePart("reasoning", { text: "Need a tool." }),
      Response.makePart("tool-call", {
        id: "tc-2",
        name: "read",
        params: { path: "README.md" },
        providerExecuted: false,
      }),
      Response.makePart("file", {
        mediaType: "image/png",
        data: new Uint8Array([104, 105]),
      }),
      Response.makePart("tool-result", {
        id: "tc-2",
        name: "read",
        isFailure: false,
        result: { ok: true },
        encodedResult: { ok: true },
        providerExecuted: false,
        preliminary: false,
      }),
    ])

    expect(parts.assistant.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
      "tool-call",
      "image",
    ])
    expect(parts.assistant[3]).toEqual(
      expect.objectContaining({
        type: "image",
        image: "data:image/png;base64,aGk=",
        mediaType: "image/png",
      }),
    )
    expect(parts.tool).toHaveLength(1)
    expect(parts.tool[0]).toEqual(
      expect.objectContaining({
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "read",
        output: { type: "json", value: { ok: true } },
      }),
    )
  })
})
