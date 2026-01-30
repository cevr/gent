import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { SendMessagePayload } from "@gent/server"

describe("SendMessage API", () => {
  test("SendMessagePayload decodes required fields", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.content).toBe("Hello")
    expect(decoded.sessionId).toBe("s1")
    expect(decoded.branchId).toBe("b1")
  })

  test("SendMessagePayload rejects missing content", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
    }
    expect(() => Schema.decodeUnknownSync(SendMessagePayload)(payload)).toThrow()
  })
})
