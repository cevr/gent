import { describe, test, expect } from "effect-bun-test"
import { HandoffPresented, HandoffConfirmed, HandoffRejected } from "@gent/core/domain/event"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

// ============================================================================
// Handoff Events -- schema roundtrip
// ============================================================================

describe("Handoff Events", () => {
  test("HandoffPresented has correct _tag and fields", () => {
    const event = new HandoffPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      summary: "Context summary",
      reason: "context pressure",
    })

    expect(event._tag).toBe("HandoffPresented")
    expect(event.sessionId).toBe("s1")
    expect(event.summary).toBe("Context summary")
    expect(event.reason).toBe("context pressure")
  })

  test("HandoffConfirmed has correct _tag and fields", () => {
    const event = new HandoffConfirmed({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      childSessionId: "child-s1" as SessionId,
    })

    expect(event._tag).toBe("HandoffConfirmed")
    expect(event.childSessionId).toBe("child-s1")
  })

  test("HandoffRejected has correct _tag and fields", () => {
    const event = new HandoffRejected({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      reason: "Not ready",
    })

    expect(event._tag).toBe("HandoffRejected")
    expect(event.reason).toBe("Not ready")
  })

  test("HandoffPresented without optional reason", () => {
    const event = new HandoffPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      summary: "Just a summary",
    })

    expect(event.reason).toBeUndefined()
  })

  test("HandoffRejected without optional reason", () => {
    const event = new HandoffRejected({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
    })

    expect(event.reason).toBeUndefined()
  })
})
