import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { SendMessagePayload } from "@gent/server"

describe("SendMessage API", () => {
  test("SendMessagePayload accepts model parameter", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
      model: "openai/opus-4.5",
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.model).toBe("openai/opus-4.5")
  })

  test("SendMessagePayload model is optional", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.model).toBeUndefined()
  })

  test("SendMessagePayload rejects invalid model type", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
      model: 123,
    }
    expect(() => Schema.decodeUnknownSync(SendMessagePayload)(payload)).toThrow()
  })
})
