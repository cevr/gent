import { describe, expect, it } from "effect-bun-test"
import { Effect, Semaphore, SubscriptionRef } from "effect"
import { AgentLoopStateRegistry } from "../../../src/runtime/agent/agent-loop.state-registry"
import type { AgentLoopState } from "../../../src/runtime/agent/agent-loop.state"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const branchMain = BranchId.make("branch-main")
const branchSecond = BranchId.make("branch-second")

const makeStub = () =>
  Effect.gen(function* () {
    const loopRef = yield* SubscriptionRef.make({} as AgentLoopState)
    const queueMutationSemaphore = yield* Semaphore.make(1)
    return { loopRef, queueMutationSemaphore }
  })

describe("AgentLoopStateRegistry", () => {
  it.effect("register exposes the handle to find by (sessionId, branchId)", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const handle = yield* makeStub()
      yield* registry.register(sessionA, branchMain, handle)
      const found = yield* registry.find(sessionA, branchMain)
      expect(found).toBe(handle)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("find returns undefined for unregistered keys", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const found = yield* registry.find(sessionA, branchMain)
      expect(found).toBeUndefined()
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregister with stale loopRef is a no-op (newer registration wins)", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const first = yield* makeStub()
      const second = yield* makeStub()
      yield* registry.register(sessionA, branchMain, first)
      yield* registry.register(sessionA, branchMain, second)
      yield* registry.deregister(sessionA, branchMain, first.loopRef)
      const found = yield* registry.find(sessionA, branchMain)
      expect(found).toBe(second)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregister with matching loopRef removes the entry", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const handle = yield* makeStub()
      yield* registry.register(sessionA, branchMain, handle)
      yield* registry.deregister(sessionA, branchMain, handle.loopRef)
      const found = yield* registry.find(sessionA, branchMain)
      expect(found).toBeUndefined()
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregisterSession removes every branch matching sessionId", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const aMain = yield* makeStub()
      const aSecond = yield* makeStub()
      const bMain = yield* makeStub()
      yield* registry.register(sessionA, branchMain, aMain)
      yield* registry.register(sessionA, branchSecond, aSecond)
      yield* registry.register(sessionB, branchMain, bMain)

      yield* registry.deregisterSession(sessionA)

      const aMainAfter = yield* registry.find(sessionA, branchMain)
      const aSecondAfter = yield* registry.find(sessionA, branchSecond)
      const bMainAfter = yield* registry.find(sessionB, branchMain)
      expect(aMainAfter).toBeUndefined()
      expect(aSecondAfter).toBeUndefined()
      expect(bMainAfter).toBe(bMain)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )
})
