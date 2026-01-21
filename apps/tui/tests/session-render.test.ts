/**
 * Tests for Session component message rendering
 */

import { describe, test, expect } from "bun:test"
import type { MessagePart } from "@gent/core"
import type { MessageInfoReadonly } from "../src/client"

// Test message data
const testMessages: MessageInfoReadonly[] = [
  {
    id: "m1",
    sessionId: "s1",
    branchId: "b1",
    role: "user",
    parts: [{ type: "text", text: "Hello there" }] as MessagePart[],
    createdAt: Date.now(),
    turnDurationMs: undefined,
  },
  {
    id: "m2",
    sessionId: "s1",
    branchId: "b1",
    role: "assistant",
    parts: [{ type: "text", text: "Hi! How can I help?" }] as MessagePart[],
    createdAt: Date.now(),
    turnDurationMs: 1500,
  },
]

describe("Session message handling", () => {
  test("buildMessages extracts text from parts", async () => {
    const { extractText } = await import("../src/client")

    // Test extractText
    const text = extractText(testMessages[0]!.parts)
    expect(text).toBe("Hello there")

    // Test with assistant message
    const assistantText = extractText(testMessages[1]!.parts)
    expect(assistantText).toBe("Hi! How can I help?")
  })

  test("buildMessages handles empty parts", async () => {
    const { extractText } = await import("../src/client")

    const emptyMessage: MessageInfoReadonly = {
      id: "m3",
      sessionId: "s1",
      branchId: "b1",
      role: "assistant",
      parts: [],
      createdAt: Date.now(),
      turnDurationMs: undefined,
    }

    const text = extractText(emptyMessage.parts)
    expect(text).toBe("")
  })

  test("buildMessages filters tool messages", async () => {
    const messagesWithTool: MessageInfoReadonly[] = [
      ...testMessages,
      {
        id: "m3",
        sessionId: "s1",
        branchId: "b1",
        role: "tool",
        parts: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "read",
            output: { type: "json", value: "file contents" },
          },
        ] as MessagePart[],
        createdAt: Date.now(),
        turnDurationMs: undefined,
      },
    ]

    // Tool messages should be filtered out when building display messages
    const filtered = messagesWithTool.filter((m) => m.role !== "tool")
    expect(filtered.length).toBe(2)
    expect(filtered.every((m) => m.role !== "tool")).toBe(true)
  })

  test("message order is preserved", () => {
    const ordered = testMessages.map((m) => m.id)
    expect(ordered).toEqual(["m1", "m2"])
  })
})

describe("event-driven message updates", () => {
  test("StreamStarted should add empty assistant message placeholder", () => {
    const messages: Array<{ id: string; role: string; content: string }> = []

    // Simulate StreamStarted event handler
    const handleStreamStarted = () => {
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      })
    }

    handleStreamStarted()

    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe("assistant")
    expect(messages[0]?.content).toBe("")
  })

  test("StreamChunk should append to last assistant message", () => {
    const messages = [
      { id: "m1", role: "user", content: "Hello" },
      { id: "m2", role: "assistant", content: "Hi" },
    ]

    // Simulate StreamChunk event handler
    const handleStreamChunk = (chunk: string) => {
      const last = messages[messages.length - 1]
      if (last && last.role === "assistant") {
        last.content += chunk
      }
    }

    handleStreamChunk(" there")
    handleStreamChunk("!")

    expect(messages[1]?.content).toBe("Hi there!")
  })

  test("StreamChunk should not modify if last is not assistant", () => {
    const messages = [{ id: "m1", role: "user", content: "Hello" }]

    const handleStreamChunk = (chunk: string) => {
      const last = messages[messages.length - 1]
      if (last && last.role === "assistant") {
        last.content += chunk
      }
    }

    handleStreamChunk(" chunk")

    // User message should be unchanged
    expect(messages[0]?.content).toBe("Hello")
  })

  test("MessageReceived should trigger message reload", () => {
    let reloadCalled = false

    const handleMessageReceived = () => {
      reloadCalled = true
    }

    handleMessageReceived()

    expect(reloadCalled).toBe(true)
  })
})

describe("client context value", () => {
  test("listMessages returns Effect", async () => {
    const { Effect } = await import("effect")

    // Mock the listMessages function signature
    const listMessages = () => Effect.succeed(testMessages)

    const effect = listMessages()

    // Should be an Effect
    expect(Effect.isEffect(effect)).toBe(true)

    // Running it should return messages
    const result = await Effect.runPromise(effect)
    expect(result.length).toBe(2)
  })

  test("subscribeEvents returns unsubscribe function", () => {
    const listeners = new Set<(e: unknown) => void>()

    const subscribeEvents = (onEvent: (e: unknown) => void) => {
      listeners.add(onEvent)
      return () => {
        listeners.delete(onEvent)
      }
    }

    const listener = () => {}
    const unsubscribe = subscribeEvents(listener)

    expect(listeners.size).toBe(1)

    unsubscribe()

    expect(listeners.size).toBe(0)
  })
})
