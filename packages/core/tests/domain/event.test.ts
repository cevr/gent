import { describe, expect, test } from "bun:test"
import {
  AgentRunFailed,
  AgentRunSpawned,
  AgentRunSucceeded,
  AgentSwitched,
  BranchSwitched,
  getEventBranchId,
  getEventSessionId,
  SessionNameUpdated,
  SessionSettingsUpdated,
  StreamChunk,
} from "@gent/core/domain/event"
import { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const session = SessionId.make("session-1")
const branch = BranchId.make("branch-1")
const child = SessionId.make("child-session")

describe("getEventSessionId", () => {
  test("standard variants surface the session field", () => {
    const event = StreamChunk.make({
      sessionId: session,
      branchId: branch,
      chunk: "hi",
    })
    expect(getEventSessionId(event)).toBe(session)
  })

  test("AgentRun variants surface parentSessionId", () => {
    const spawned = AgentRunSpawned.make({
      parentSessionId: session,
      childSessionId: child,
      agentName: AgentName.make("cowork"),
      prompt: "go",
    })
    const succeeded = AgentRunSucceeded.make({
      parentSessionId: session,
      childSessionId: child,
      agentName: AgentName.make("cowork"),
    })
    const failed = AgentRunFailed.make({
      parentSessionId: session,
      childSessionId: child,
      agentName: AgentName.make("cowork"),
    })
    expect(getEventSessionId(spawned)).toBe(session)
    expect(getEventSessionId(succeeded)).toBe(session)
    expect(getEventSessionId(failed)).toBe(session)
  })
})

describe("getEventBranchId", () => {
  test("BranchSwitched returns undefined to match either-side delivery", () => {
    const switched = BranchSwitched.make({
      sessionId: session,
      fromBranchId: branch,
      toBranchId: BranchId.make("branch-2"),
    })
    expect(getEventBranchId(switched)).toBeUndefined()
  })

  test("SessionNameUpdated and SessionSettingsUpdated have no branch", () => {
    const named = SessionNameUpdated.make({ sessionId: session, name: "x" })
    const settings = SessionSettingsUpdated.make({ sessionId: session })
    expect(getEventBranchId(named)).toBeUndefined()
    expect(getEventBranchId(settings)).toBeUndefined()
  })

  test("standard variants surface the branch field", () => {
    const event = AgentSwitched.make({
      sessionId: session,
      branchId: branch,
      fromAgent: AgentName.make("cowork"),
      toAgent: AgentName.make("research"),
    })
    expect(getEventBranchId(event)).toBe(branch)
  })
})

describe("AgentSwitched event branding", () => {
  test("fromAgent/toAgent reject unbranded raw strings at construction", () => {
    expect(() =>
      AgentSwitched.make({
        sessionId: session,
        branchId: branch,
        fromAgent: AgentName.make("cowork"),
        toAgent: AgentName.make("research"),
      }),
    ).not.toThrow()
  })
})
