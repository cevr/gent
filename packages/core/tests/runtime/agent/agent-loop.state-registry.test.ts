import { describe, expect, it } from "effect-bun-test"
import { Effect, Semaphore, SubscriptionRef } from "effect"
import { AgentLoopStateRegistry } from "../../../src/runtime/agent/agent-loop.state-registry"
import type { AgentLoopState } from "../../../src/runtime/agent/agent-loop.state"
import { BranchId, SessionId } from "@gent/core/domain/ids"

const sessionA = SessionId.make("session-a")
const sessionB = SessionId.make("session-b")
const branchMain = BranchId.make("branch-main")
const branchSecond = BranchId.make("branch-second")
const workspaceA = "a".repeat(64)
const workspaceB = "b".repeat(64)

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
      yield* registry.register(workspaceA, sessionA, branchMain, handle)
      const found = yield* registry.find(workspaceA, sessionA, branchMain)
      expect(found).toBe(handle)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("find returns undefined for unregistered keys", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const found = yield* registry.find(workspaceA, sessionA, branchMain)
      expect(found).toBeUndefined()
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregister with stale loopRef is a no-op (newer registration wins)", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const first = yield* makeStub()
      const second = yield* makeStub()
      yield* registry.register(workspaceA, sessionA, branchMain, first)
      yield* registry.register(workspaceA, sessionA, branchMain, second)
      yield* registry.deregister(workspaceA, sessionA, branchMain, first.loopRef)
      const found = yield* registry.find(workspaceA, sessionA, branchMain)
      expect(found).toBe(second)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregister with matching loopRef removes the entry", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const handle = yield* makeStub()
      yield* registry.register(workspaceA, sessionA, branchMain, handle)
      yield* registry.deregister(workspaceA, sessionA, branchMain, handle.loopRef)
      const found = yield* registry.find(workspaceA, sessionA, branchMain)
      expect(found).toBeUndefined()
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect(
    "does not collide when sessionId or branchId contains a `:` (nested-map invariant)",
    () =>
      Effect.gen(function* () {
        const registry = yield* AgentLoopStateRegistry
        // These two pairs would collide under delimiter encoding:
        //   `${"a:"}:${"x"}`     === "a::x"
        //   `${"a"}:${":x"}`     === "a::x"
        const trickySessionA = SessionId.make("a:")
        const trickyBranchA = BranchId.make("x")
        const trickySessionB = SessionId.make("a")
        const trickyBranchB = BranchId.make(":x")
        const handleA = yield* makeStub()
        const handleB = yield* makeStub()
        yield* registry.register(workspaceA, trickySessionA, trickyBranchA, handleA)
        yield* registry.register(workspaceA, trickySessionB, trickyBranchB, handleB)
        const foundA = yield* registry.find(workspaceA, trickySessionA, trickyBranchA)
        const foundB = yield* registry.find(workspaceA, trickySessionB, trickyBranchB)
        expect(foundA).toBe(handleA)
        expect(foundB).toBe(handleB)
      }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("deregisterSession removes every branch matching sessionId", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const aMain = yield* makeStub()
      const aSecond = yield* makeStub()
      const bMain = yield* makeStub()
      yield* registry.register(workspaceA, sessionA, branchMain, aMain)
      yield* registry.register(workspaceA, sessionA, branchSecond, aSecond)
      yield* registry.register(workspaceA, sessionB, branchMain, bMain)

      yield* registry.deregisterSession(workspaceA, sessionA)

      const aMainAfter = yield* registry.find(workspaceA, sessionA, branchMain)
      const aSecondAfter = yield* registry.find(workspaceA, sessionA, branchSecond)
      const bMainAfter = yield* registry.find(workspaceA, sessionB, branchMain)
      expect(aMainAfter).toBeUndefined()
      expect(aSecondAfter).toBeUndefined()
      expect(bMainAfter).toBe(bMain)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )

  it.effect("same session and branch ids do not collide across workspaces", () =>
    Effect.gen(function* () {
      const registry = yield* AgentLoopStateRegistry
      const handleA = yield* makeStub()
      const handleB = yield* makeStub()
      yield* registry.register(workspaceA, sessionA, branchMain, handleA)
      yield* registry.register(workspaceB, sessionA, branchMain, handleB)

      const foundA = yield* registry.find(workspaceA, sessionA, branchMain)
      const foundB = yield* registry.find(workspaceB, sessionA, branchMain)

      expect(foundA).toBe(handleA)
      expect(foundB).toBe(handleB)
    }).pipe(Effect.provide(AgentLoopStateRegistry.Live)),
  )
})
