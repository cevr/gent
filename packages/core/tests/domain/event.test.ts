import { describe, test, expect } from "effect-bun-test"
import { InteractionPresented, InteractionResolved } from "@gent/core/domain/event"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

// ============================================================================
// Interaction Events -- schema roundtrip
// ============================================================================

describe("Interaction Events", () => {
  test("InteractionPresented has correct _tag and fields", () => {
    const event = new InteractionPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      text: "Approve this action?",
      metadata: { type: "handoff", reason: "context pressure" },
    })

    expect(event._tag).toBe("InteractionPresented")
    expect(event.sessionId).toBe("s1")
    expect(event.text).toBe("Approve this action?")
    expect(event.metadata).toEqual({ type: "handoff", reason: "context pressure" })
  })

  test("InteractionPresented without optional metadata", () => {
    const event = new InteractionPresented({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      text: "Approve?",
    })

    expect(event.metadata).toBeUndefined()
  })

  test("InteractionResolved approved has correct _tag and fields", () => {
    const event = new InteractionResolved({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      approved: true,
      notes: "Looks good",
    })

    expect(event._tag).toBe("InteractionResolved")
    expect(event.approved).toBe(true)
    expect(event.notes).toBe("Looks good")
  })

  test("InteractionResolved rejected has correct _tag and fields", () => {
    const event = new InteractionResolved({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      approved: false,
      notes: "Not ready",
    })

    expect(event._tag).toBe("InteractionResolved")
    expect(event.approved).toBe(false)
    expect(event.notes).toBe("Not ready")
  })

  test("InteractionResolved without optional notes", () => {
    const event = new InteractionResolved({
      sessionId: "s1" as SessionId,
      branchId: "b1" as BranchId,
      requestId: "req-1",
      approved: true,
    })

    expect(event.notes).toBeUndefined()
  })
})
