import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { SessionId } from "@gent/core/domain/ids"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")

describe("AgentLoopSessionGovernance", () => {
  it.effect("isTerminated returns false for unmarked sessions", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      const terminated = yield* governance.isTerminated(sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("markTerminated then isTerminated reflects the marker per session", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(sessionA)
      const aTerminated = yield* governance.isTerminated(sessionA)
      const bTerminated = yield* governance.isTerminated(sessionB)
      expect(aTerminated).toBe(true)
      expect(bTerminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated removes the marker", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.markTerminated(sessionA)
      yield* governance.clearTerminated(sessionA)
      const terminated = yield* governance.isTerminated(sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )

  it.effect("clearTerminated on an unmarked session is a no-op", () =>
    Effect.gen(function* () {
      const governance = yield* AgentLoopSessionGovernance
      yield* governance.clearTerminated(sessionA)
      const terminated = yield* governance.isTerminated(sessionA)
      expect(terminated).toBe(false)
    }).pipe(Effect.provide(AgentLoopSessionGovernance.Live)),
  )
})
