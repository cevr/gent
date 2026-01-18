import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@gent/storage"
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  type MessagePart,
} from "@gent/core"

// Type chain test - ensure MessagePart flows correctly through all layers
// core → storage → server

// Helper to extract text (mirrors client.ts)
function extractText(parts: readonly MessagePart[]): string {
  const textPart = parts.find((p): p is TextPart => p.type === "text")
  return textPart?.text ?? ""
}

describe("Type chain", () => {
  describe("MessagePart type compatibility", () => {
    test("core MessagePart types are usable", () => {
      const textPart: MessagePart = new TextPart({ type: "text", text: "hello" })
      expect(textPart.type).toBe("text")
      expect((textPart as TextPart).text).toBe("hello")

      const toolCallPart: MessagePart = new ToolCallPart({
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "test",
        input: { foo: "bar" },
      })
      expect(toolCallPart.type).toBe("tool-call")
      expect((toolCallPart as ToolCallPart).toolName).toBe("test")

      const toolResultPart: MessagePart = new ToolResultPart({
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "test",
        output: { type: "json", value: "result" },
      })
      expect(toolResultPart.type).toBe("tool-result")
    })

    test("extractText works with MessagePart array", () => {
      const parts: readonly MessagePart[] = [
        new TextPart({ type: "text", text: "hello world" }),
      ]
      const text = extractText(parts)
      expect(text).toBe("hello world")
    })

    test("extractText returns empty for non-text parts", () => {
      const parts: readonly MessagePart[] = [
        new ToolCallPart({
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "test",
          input: {},
        }),
      ]
      const text = extractText(parts)
      expect(text).toBe("")
    })
  })

  describe("Message with parts", () => {
    test("Message stores and retrieves parts", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const parts: readonly MessagePart[] = [
            new TextPart({ type: "text", text: "Hello" }),
            new ToolCallPart({
              type: "tool-call",
              toolCallId: "tc-1",
              toolName: "test_tool",
              input: { query: "test" },
            }),
          ]

          const message = new Message({
            id: "type-chain-msg",
            sessionId: "type-session",
            branchId: "type-branch",
            role: "assistant",
            parts,
            createdAt: new Date(),
          })

          // Verify parts are properly typed
          expect(message.parts).toHaveLength(2)
          expect(message.parts[0]?.type).toBe("text")
          expect(message.parts[1]?.type).toBe("tool-call")

          // Type narrowing works
          const textPart = message.parts.find((p): p is TextPart => p.type === "text")
          expect(textPart?.text).toBe("Hello")

          const toolPart = message.parts.find((p): p is ToolCallPart => p.type === "tool-call")
          expect(toolPart?.toolName).toBe("test_tool")
        }).pipe(Effect.provide(Storage.Test()))
      )
    })
  })
})
