import { describe, expect, test } from "bun:test"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { SessionState, transitionSessionState, type Session } from "../src/client/session-state"

const session: Session = {
  sessionId: "session-1" as SessionId,
  branchId: "branch-1" as BranchId,
  name: "Session 1",
  reasoningLevel: undefined,
}

describe("session-state", () => {
  test("create lifecycle only models the real async state", () => {
    const creating = transitionSessionState(SessionState.none(), { _tag: "CreateRequested" })
    const active = transitionSessionState(creating, { _tag: "CreateSucceeded", session })

    expect(creating).toEqual({ status: "creating" })
    expect(active).toEqual({ status: "active", session })
  })

  test("activate replaces current session without ceremonial switching state", () => {
    const next = transitionSessionState(SessionState.active(session), {
      _tag: "Activated",
      session: { ...session, sessionId: "session-2" as SessionId, name: "Session 2" },
    })

    expect(next).toEqual({
      status: "active",
      session: {
        ...session,
        sessionId: "session-2" as SessionId,
        name: "Session 2",
      },
    })
  })

  test("clear resets to none", () => {
    expect(transitionSessionState(SessionState.active(session), { _tag: "Clear" })).toEqual({
      status: "none",
    })
  })
})
