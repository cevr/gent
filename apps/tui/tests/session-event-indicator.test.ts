import { describe, expect, test } from "bun:test"
import { getSessionEventLabel, type SessionEvent } from "../src/components/session-event-label.js"

describe("session event labels", () => {
  test("formats retrying progress", () => {
    const createdAt = 1_000
    const event: SessionEvent = {
      _tag: "event",
      kind: "retrying",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      createdAt,
      seq: 1,
    }

    expect(getSessionEventLabel(event, createdAt)).toBe("Retrying in 2s... 1/3")
    expect(getSessionEventLabel(event, createdAt + 1_100)).toBe("Retrying in 1s... 1/3")
    expect(getSessionEventLabel(event, createdAt + 2_000)).toBe("Retrying now... 1/3")
  })
})
