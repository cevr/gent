import { describe, test, expect } from "bun:test"
import * as Prompt from "effect/unstable/ai/Prompt"
import { extractText, extractImages, Message, type Message as DomainMessage } from "@gent/sdk"
import { dateFromMillis, type MessagePart } from "@gent/core/domain/message"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { projectMessagesWithToolInteractions } from "@gent/core/domain/message-part-projection"

describe("extractText", () => {
  test("extracts text from text part", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "Hello world" })]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("returns empty string when no text part", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: {},
        providerExecuted: false,
      }),
    ]
    expect(extractText(parts)).toBe("")
  })

  test("concatenates all text parts", () => {
    const parts: MessagePart[] = [
      Prompt.textPart({ text: "First" }),
      Prompt.textPart({ text: "Second" }),
    ]
    expect(extractText(parts)).toBe("FirstSecond")
  })

  test("handles mixed parts", () => {
    const parts: MessagePart[] = [
      Prompt.toolCallPart({
        id: ToolCallId.make("tc1"),
        name: "read",
        params: {},
        providerExecuted: false,
      }),
      Prompt.textPart({ text: "Response after tool" }),
    ]
    expect(extractText(parts)).toBe("Response after tool")
  })

  test("returns empty string for empty parts", () => {
    expect(extractText([])).toBe("")
  })
})

describe("extractImages", () => {
  test("extracts images from parts", () => {
    const parts: MessagePart[] = [
      Prompt.filePart({ data: "data:image/png;base64,abc", mediaType: "image/png" }),
      Prompt.textPart({ text: "Some text" }),
      Prompt.filePart({ data: "data:image/jpeg;base64,xyz", mediaType: "image/jpeg" }),
    ]

    const images = extractImages(parts)
    expect(images.length).toBe(2)
    expect(images[0]).toEqual({ mediaType: "image/png" })
    expect(images[1]).toEqual({ mediaType: "image/jpeg" })
  })

  test("returns empty array when no images", () => {
    const parts: MessagePart[] = [Prompt.textPart({ text: "Just text" })]
    expect(extractImages(parts)).toEqual([])
  })

  test("uses file mediaType for image parts", () => {
    const parts: MessagePart[] = [Prompt.filePart({ data: "data:abc", mediaType: "image/png" })]

    const images = extractImages(parts)
    expect(images[0]).toEqual({ mediaType: "image/png" })
  })

  test("handles empty parts", () => {
    expect(extractImages([])).toEqual([])
  })

  test("handles mixed content with images", () => {
    const parts: MessagePart[] = [
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

    const images = extractImages(parts)
    expect(images.length).toBe(2)
    expect(images[0]?.mediaType).toBe("image/gif")
    expect(images[1]?.mediaType).toBe("image/webp")
  })
})

describe("projectMessagesWithToolInteractions", () => {
  const makeMsg = (role: "user" | "assistant" | "tool", parts: MessagePart[]): DomainMessage =>
    Message.Regular.make({
      id: MessageId.make(Bun.randomUUIDv7()),
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      role,
      parts,
      createdAt: dateFromMillis(0),
      turnDurationMs: undefined,
    })

  const toolResult = (id: string, value: unknown, isError = false): MessagePart =>
    Prompt.toolResultPart({
      id: ToolCallId.make(id),
      name: "test-tool",
      isFailure: isError,
      result: value,
    })

  test("exposes running tool calls on projected messages", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: { path: "/foo" },
          providerExecuted: false,
        }),
        Prompt.textPart({ text: "Some text" }),
        Prompt.toolCallPart({
          id: ToolCallId.make("tc2"),
          name: "edit",
          params: { path: "/bar" },
          providerExecuted: false,
        }),
      ]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions).toEqual([
      {
        id: ToolCallId.make("tc1"),
        toolName: "read",
        status: "running",
        input: { path: "/foo" },
        summary: undefined,
        output: undefined,
      },
      {
        id: ToolCallId.make("tc2"),
        toolName: "edit",
        status: "running",
        input: { path: "/bar" },
        summary: undefined,
        output: undefined,
      },
    ])
  })

  test("returns empty interactions when no tool calls", () => {
    const projected = projectMessagesWithToolInteractions([
      makeMsg("assistant", [Prompt.textPart({ text: "Just text" })]),
    ])[0]
    expect(projected?.toolInteractions).toEqual([])
  })

  test("joins tool calls with tool-message results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "file contents here")]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc1"),
      toolName: "read",
      status: "completed",
      input: {},
      summary: "file contents here",
      output: "file contents here",
    })
  })

  test("handles error results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "File not found", true)]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]).toEqual({
      id: ToolCallId.make("tc1"),
      toolName: "read",
      status: "error",
      input: {},
      summary: "File not found",
      output: "File not found",
    })
  })

  test("truncates long output in summary", () => {
    const longText = "x".repeat(150)
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", longText)]),
    ]

    const result = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions[0]!
    const summary = result.summary
    if (summary === undefined) throw new Error("expected projected tool summary")
    expect(summary.length).toBe(103) // 100 + "..."
    expect(summary.endsWith("...")).toBe(true)
    expect(result.output).toBe(longText) // full output preserved
  })

  test("summary uses first line only", () => {
    const multiline = "First line\nSecond line\nThird line"
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", multiline)]),
    ]

    expect(projectMessagesWithToolInteractions(messages)[0]?.toolInteractions[0]?.summary).toBe(
      "First line",
    )
  })

  test("handles object output", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", { files: ["a.ts", "b.ts"] })]),
    ]

    const result = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions[0]!
    expect(result.summary).toBe('{"files":["a.ts","b.ts"]}')
    expect(result.output).toContain('"files"')
  })

  test("handles multiple tool results", () => {
    const messages: DomainMessage[] = [
      makeMsg("assistant", [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: {},
          providerExecuted: false,
        }),
        Prompt.toolCallPart({
          id: ToolCallId.make("tc2"),
          name: "edit",
          params: {},
          providerExecuted: false,
        }),
      ]),
      makeMsg("tool", [toolResult("tc1", "result1"), toolResult("tc2", "result2")]),
    ]

    const interactions = projectMessagesWithToolInteractions(messages)[0]!.toolInteractions
    expect(interactions.length).toBe(2)
    expect(interactions[0]?.output).toBe("result1")
    expect(interactions[1]?.output).toBe("result2")
  })

  test("ignores tool results without matching message-local calls", () => {
    const messages: DomainMessage[] = [
      makeMsg("user", [Prompt.textPart({ text: "Hello" })]),
      makeMsg("assistant", [Prompt.textPart({ text: "Hi there" })]),
      makeMsg("tool", [toolResult("tc1", "orphan")]),
    ]

    const projected = projectMessagesWithToolInteractions(messages)
    expect(projected.flatMap((message) => message.toolInteractions)).toEqual([])
  })
})
