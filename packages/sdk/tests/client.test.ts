import { describe, test, expect } from "bun:test"
import {
  Gent,
  extractText,
  extractImages,
  extractToolCalls,
  buildToolResultMap,
  type MessageInfoReadonly,
} from "../src/index"

describe("sdk client helpers", () => {
  test("sdk entrypoint exports the public constructors", () => {
    // New composable API
    expect(typeof Gent.server).toBe("function")
    expect(typeof Gent.client).toBe("function")
    expect(typeof Gent.state.sqlite).toBe("function")
    expect(typeof Gent.state.memory).toBe("function")
    expect(typeof Gent.provider.live).toBe("function")
    expect(typeof Gent.provider.mock).toBe("function")
    // Legacy (removed in Batch 9)
    expect(typeof Gent.spawn).toBe("function")
    expect(typeof Gent.connect).toBe("function")
    expect(typeof Gent.local).toBe("function")
    expect(typeof Gent.test).toBe("function")
  })

  test("extractText extracts text from message parts", () => {
    const parts = [{ type: "text" as const, text: "Hello world" }]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("extractImages extracts image metadata", () => {
    const parts = [{ type: "image" as const, image: "base64data", mediaType: "image/png" }]
    const images = extractImages(parts)
    expect(images.length).toBe(1)
    expect(images[0]?.mediaType).toBe("image/png")
  })

  test("extractToolCalls extracts tool calls", () => {
    const parts = [
      { type: "tool-call" as const, toolCallId: "tc1", toolName: "read", input: { path: "/foo" } },
    ]
    const calls = extractToolCalls(parts)
    expect(calls.length).toBe(1)
    expect(calls[0]?.id).toBe("tc1")
    expect(calls[0]?.toolName).toBe("read")
  })

  test("buildToolResultMap indexes tool outputs by call id", () => {
    const messages: MessageInfoReadonly[] = [
      {
        id: "m1",
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
        ],
        createdAt: Date.now(),
      },
    ]
    const map = buildToolResultMap(messages)
    expect(map.size).toBe(1)
    expect(map.get("tc1")?.output).toBe("file contents")
  })
})
