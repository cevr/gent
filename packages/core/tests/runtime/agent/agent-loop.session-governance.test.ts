import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { SessionId } from "@gent/core/domain/ids"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const workspaceA = "a".repeat(64)
const workspaceB = "b".repeat(64)

describe("AgentLoopSessionGovernance", () => {
  it.effect("isTerminated returns false for unmarked sessions", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("markTerminated then isTerminated reflects the marker per session", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)
      const aTerminated = yield* governance.isTerminated(workspaceA, sessionA)
      const bTerminated = yield* governance.isTerminated(workspaceA, sessionB)
      expect(aTerminated).toBe(true)
      expect(bTerminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated removes the marker", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)
      yield* governance.clearTerminated(workspaceA, sessionA)
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated on an unmarked session is a no-op", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.clearTerminated(workspaceA, sessionA)
      const terminated = yield* governance.isTerminated(workspaceA, sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("same session id does not collide across workspaces", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(workspaceA, sessionA)

      const workspaceATerminated = yield* governance.isTerminated(workspaceA, sessionA)
      const workspaceBTerminated = yield* governance.isTerminated(workspaceB, sessionA)

      expect(workspaceATerminated).toBe(true)
      expect(workspaceBTerminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )
})
