import { describe, expect, test } from "bun:test"
import { MessageId } from "@gent/core/protocol"
import type { QueueEntryInfo } from "@gent/sdk"
import {
  beginAuthCheck,
  clearQueue,
  closeAuthGateState,
  completeAuthCheck,
  failAuthCheck,
  initialSessionControllerState,
  queuedDraftText,
  setQueue,
} from "../src/session"

const queueEntry = (tag: QueueEntryInfo["_tag"], id: string, content: string): QueueEntryInfo => ({
  _tag: tag,
  id: MessageId.make(id),
  content,
  createdAt: 0,
})

describe("session controller state", () => {
  test("auth checks ignore stale success and failure results", () => {
    const initial = initialSessionControllerState({ agent: "fast" })
    const first = beginAuthCheck(initial)
    const second = beginAuthCheck(first)

    const staleSuccess = completeAuthCheck(second, {
      version: first.authCheckVersion,
      agent: "fast",
      missing: true,
    })
    const staleFailure = failAuthCheck(second, first.authCheckVersion)

    expect(staleSuccess).toBe(second)
    expect(staleFailure).toBe(second)
    expect(second.authGate).toBe("checking")
  })

  test("manual auth close invalidates pending checks and stores the current agent", () => {
    const checking = beginAuthCheck(initialSessionControllerState({ agent: "fast" }))
    const closed = closeAuthGateState(checking, "deep")
    const staleResult = completeAuthCheck(closed, {
      version: checking.authCheckVersion,
      agent: "fast",
      missing: true,
    })

    expect(closed.authGate).toBe("closed")
    expect(closed.validatedAgent).toBe("deep")
    expect(closed.authCheckVersion).toBe(checking.authCheckVersion + 1)
    expect(staleResult).toBe(closed)
  })

  test("queued draft text preserves steering before follow-up entries", () => {
    const queue = {
      steering: [queueEntry("Steering", "m1", "switch agents")],
      followUp: [
        queueEntry("FollowUp", "m2", "then continue"),
        queueEntry("FollowUp", "m3", "and summarize"),
      ],
    }

    const withQueue = setQueue(initialSessionControllerState({ agent: "fast" }), queue)
    const cleared = clearQueue(withQueue)

    expect(queuedDraftText(withQueue.queue)).toBe("switch agents\nthen continue\nand summarize")
    expect(queuedDraftText(cleared.queue)).toBeUndefined()
  })
})
