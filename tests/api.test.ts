import { describe, test, expect } from "bun:test"
import { Schema } from "effect"
import { SendMessagePayload } from "@gent/server"

describe("SendMessage API", () => {
  test("SendMessagePayload accepts mode parameter", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
      mode: "plan" as const,
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.mode).toBe("plan")
  })

  test("SendMessagePayload mode is optional", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.mode).toBeUndefined()
  })

  test("SendMessagePayload accepts build mode", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
      mode: "build" as const,
    }
    const decoded = Schema.decodeUnknownSync(SendMessagePayload)(payload)
    expect(decoded.mode).toBe("build")
  })

  test("SendMessagePayload rejects invalid mode", () => {
    const payload = {
      sessionId: "s1",
      branchId: "b1",
      content: "Hello",
      mode: "invalid",
    }
    expect(() => Schema.decodeUnknownSync(SendMessagePayload)(payload)).toThrow()
  })
})
