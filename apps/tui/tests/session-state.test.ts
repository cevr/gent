import { describe, expect, test } from "bun:test"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { SessionState, transitionSessionState, type Session } from "../src/client/session-state"

const session: Session = {
  sessionId: SessionId.make("session-1"),
  branchId: BranchId.make("branch-1"),
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
      session: { ...session, sessionId: SessionId.make("session-2"), name: "Session 2" },
    })

    expect(next).toEqual({
      status: "active",
      session: {
        ...session,
        sessionId: SessionId.make("session-2"),
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
