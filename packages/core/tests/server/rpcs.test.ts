import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { SendMessageInput } from "@gent/core/server/rpcs"

describe("SendMessage API", () => {
  test("SendMessageInput decodes required fields", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
    }
    const decoded = Schema.decodeUnknownSync(SendMessageInput)(payload)
    expect(decoded.content).toBe("Hello")
    expect(decoded.sessionId).toBe("s1")
    expect(decoded.branchId).toBe("b1")
  })

  test("SendMessageInput rejects missing content", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
    }
    expect(() => Schema.decodeUnknownSync(SendMessageInput)(payload)).toThrow()
  })
})
