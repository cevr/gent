import { describe, expect, test } from "bun:test"
import { MessageId } from "@gent/core-internal/domain/ids.js"
import type { QueueEntryInfo } from "@gent/sdk"
import {
  beginAuthCheck,
  clearQueue,
  closeAuthGate,
  completeAuthCheck,
  failAuthCheck,
  initialSessionControllerState,
  queuedDraftText,
  setQueue,
} from "../src/routes/session-controller-state"

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
    const closed = closeAuthGate(checking, "deep")
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
      steering: [queueEntry("steering", "m1", "switch agents")],
      followUp: [
        queueEntry("follow-up", "m2", "then continue"),
        queueEntry("follow-up", "m3", "and summarize"),
      ],
    }

    const withQueue = setQueue(initialSessionControllerState({ agent: "fast" }), queue)
    const cleared = clearQueue(withQueue)

    expect(queuedDraftText(withQueue.queue)).toBe("switch agents\nthen continue\nand summarize")
    expect(queuedDraftText(cleared.queue)).toBeUndefined()
  })
})
