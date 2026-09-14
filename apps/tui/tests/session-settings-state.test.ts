import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { BranchId, ModelId, SessionId } from "@gent/core/protocol"
import {
  SessionState,
  SessionStateEvent,
  sessionSettings,
  transitionSessionState,
} from "../src/client/session-state"

const absent = Option.getOrUndefined(Option.none())

const active = SessionState.active({
  sessionId: SessionId.make("s"),
  branchId: BranchId.make("b"),
  name: "S",
  modelId: absent,
  reasoningLevel: "high",
})

describe("session settings", () => {
  test("an update replaces both settings at once", () => {
    const next = transitionSessionState(
      active,
      SessionStateEvent.cases.UpdateSettings.make({
        modelId: ModelId.make("openai/gpt-5.6-luna"),
        reasoningLevel: absent,
      }),
    )
    expect(next.status).toBe("active")
    if (next.status === "active") {
      expect(sessionSettings(next.session)).toEqual({
        modelId: ModelId.make("openai/gpt-5.6-luna"),
        reasoningLevel: absent,
      })
      expect(next.session.name).toBe("S")
    }
  })

  test("an update while no session is active is ignored", () => {
    const next = transitionSessionState(
      SessionState.none(),
      SessionStateEvent.cases.UpdateSettings.make({ modelId: absent, reasoningLevel: "low" }),
    )
    expect(next).toEqual(SessionState.none())
  })
})
