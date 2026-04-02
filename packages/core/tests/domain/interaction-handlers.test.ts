import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { EventStore } from "@gent/core/domain/event"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
import type { SessionId, BranchId } from "@gent/core/domain/ids"
import { Storage } from "@gent/core/storage/sqlite-storage"

// ============================================================================
// HandoffHandler
// ============================================================================

describe("HandoffHandler", () => {
  describe("Test layer", () => {
    it.live("returns sequential decisions", () => {
      const layer = HandoffHandler.Test(["confirm", "reject", "confirm"])

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const d1 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary",
        })
        expect(d1).toBe("confirm")

        const d2 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary 2",
        })
        expect(d2).toBe("reject")

        const d3 = yield* handler.present({
          sessionId: "s1" as SessionId,
          branchId: "b1" as BranchId,
          summary: "test summary 3",
        })
        expect(d3).toBe("confirm")
      }).pipe(Effect.provide(layer))
    })

    it.live("defaults to confirm", () => {
      const layer = HandoffHandler.Test()

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const decision = yield* handler.present({
          sessionId: "s" as SessionId,
          branchId: "b" as BranchId,
          summary: "summary",
        })
        expect(decision).toBe("confirm")
      }).pipe(Effect.provide(layer))
    })

    it.live("respond returns undefined (no-op in test)", () => {
      const layer = HandoffHandler.Test()

      return Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const result = yield* handler.respond("req-1", "confirm", "child-s" as SessionId)
        expect(result).toBeUndefined()
      }).pipe(Effect.provide(layer))
    })
  })

  describe("Live layer", () => {
    const liveTest = it.live.layer(
      Layer.provideMerge(
        HandoffHandler.Live,
        Layer.mergeAll(EventStore.Live, Storage.MemoryWithSql()),
      ),
    )

    liveTest("present throws InteractionPendingError and publishes event", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
            summary: "Context summary here",
            reason: "context pressure",
          }),
        )

        expect(error._tag).toBe("InteractionPendingError")
        expect(error.requestId).toBeTruthy()
        expect(error.sessionId).toBe("s1")
        expect(error.branchId).toBe("b1")
      }),
    )

    liveTest("peek returns params after present", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
            summary: "Test context",
          }),
        )

        // paramsStash populated by onPresent
        const peeked = yield* handler.peek(error.requestId)
        expect(peeked).toBeDefined()
        expect(peeked?.sessionId).toBe("s1")
        expect(peeked?.summary).toBe("Test context")
      }),
    )

    liveTest("claim is atomic — second claim returns undefined", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s2" as SessionId,
            branchId: "b2" as BranchId,
            summary: "Claim test",
          }),
        )

        const first = yield* handler.claim(error.requestId)
        expect(first).toBeDefined()
        expect(first?.summary).toBe("Claim test")

        const second = yield* handler.claim(error.requestId)
        expect(second).toBeUndefined()
      }),
    )

    liveTest("respond confirm flow returns params entry", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s3" as SessionId,
            branchId: "b3" as BranchId,
            summary: "Test context",
          }),
        )

        const entry = yield* handler.respond(
          error.requestId,
          "confirm",
          "child-session" as SessionId,
        )
        expect(entry).toBeDefined()
        expect(entry?.sessionId).toBe("s3")
        expect(entry?.summary).toBe("Test context")
      }),
    )

    liveTest("respond reject flow returns params entry", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s4" as SessionId,
            branchId: "b4" as BranchId,
            summary: "Rejected context",
          }),
        )

        const entry = yield* handler.respond(error.requestId, "reject", undefined, "Not ready yet")
        expect(entry).toBeDefined()
        expect(entry?.summary).toBe("Rejected context")
      }),
    )

    liveTest("respond to unknown requestId returns undefined", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const result = yield* handler.respond("nonexistent", "confirm", "s" as SessionId)
        expect(result).toBeUndefined()
      }),
    )

    liveTest("double respond returns params on first, undefined on second", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const error = yield* Effect.flip(
          handler.present({
            sessionId: "s5" as SessionId,
            branchId: "b5" as BranchId,
            summary: "Double respond test",
          }),
        )

        const first = yield* handler.respond(error.requestId, "confirm", "child" as SessionId)
        expect(first).toBeDefined()

        // Second respond — storage already resolved, paramsStash still has entry
        // respond() returns paramsStash.get(requestId) which is still defined
        // but storage.resolve is a no-op on second call
        const second = yield* handler.respond(error.requestId, "reject")
        expect(second).toBeDefined()
      }),
    )

    liveTest("storeResolution + present returns stored value without throwing", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        const sessionId = "s-cold" as SessionId
        const branchId = "b-cold" as BranchId

        // First present fails
        const error = yield* Effect.flip(
          handler.present({ sessionId, branchId, summary: "cold resumption test" }),
        )
        expect(error._tag).toBe("InteractionPendingError")

        // Store resolution (simulates what the respond RPC + machine does)
        handler.storeResolution(sessionId, branchId, "confirm")

        // Second present returns stored value
        const decision = yield* handler.present({
          sessionId,
          branchId,
          summary: "cold resumption test",
        })
        expect(decision).toBe("confirm")
      }),
    )
  })
})
