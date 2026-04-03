import { describe, test, expect } from "bun:test"
import {
  Gent,
  extractText,
  extractImages,
  extractToolCalls,
  buildToolResultMap,
  type GentClientBundle,
  type MessageInfoReadonly,
} from "../src/index"

describe("Gent constructors", () => {
  test("Gent.spawn, Gent.connect, Gent.local, and Gent.test are functions", () => {
    expect(typeof Gent.spawn).toBe("function")
    expect(typeof Gent.connect).toBe("function")
    expect(typeof Gent.local).toBe("function")
    expect(typeof Gent.test).toBe("function")
  })
})

describe("GentClientBundle shape", () => {
  test("has client (namespaced), runtime (cast/fork/run/lifecycle)", () => {
    // Verify the type at compile time — if this compiles, the shape is correct
    const assertShape = (_bundle: GentClientBundle) => {
      expect(typeof _bundle.client).toBe("object")
      expect(typeof _bundle.runtime.cast).toBe("function")
      expect(typeof _bundle.runtime.fork).toBe("function")
      expect(typeof _bundle.runtime.run).toBe("function")
      expect(typeof _bundle.runtime.lifecycle).toBe("object")
      expect(typeof _bundle.runtime.lifecycle.getState).toBe("function")
      expect(typeof _bundle.runtime.lifecycle.subscribe).toBe("function")
    }
    // Just a type check — we can't easily construct a full client without layers
    void assertShape
  })
})

describe("utility functions", () => {
  test("extractText extracts text from parts", () => {
    const parts = [{ type: "text" as const, text: "Hello world" }]
    expect(extractText(parts)).toBe("Hello world")
  })

  test("extractImages extracts image info", () => {
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

  test("buildToolResultMap builds map from messages", () => {
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
