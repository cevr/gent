import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { EventStore, type HandoffDecision, type HandoffPresented } from "@gent/core/domain/event"
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

    liveTest("present blocks until respond, then returns decision", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler

        // Fork present (blocks on internal Deferred)
        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s1" as SessionId,
              branchId: "b1" as BranchId,
              summary: "Context summary here",
              reason: "context pressure",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        // Should not have resolved yet
        yield* Effect.sleep("10 millis")
        const isDone = yield* Deferred.isDone(decisionDeferred)
        expect(isDone).toBe(false)
      }),
    )

    liveTest("present/respond confirm flow returns entry with summary", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        // Use the EventStore PubSub to capture the requestId
        const requestIdDeferred = yield* Deferred.make<string>()

        // Subscribe to events to grab requestId
        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s1" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        // Fork present (blocks until respond)
        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s1" as SessionId,
              branchId: "b1" as BranchId,
              summary: "Test context",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        // Wait for requestId from event
        const requestId = yield* Deferred.await(requestIdDeferred)
        expect(requestId).toBeTruthy()

        // Respond with confirm
        const entry = yield* handler.respond(requestId, "confirm", "child-session" as SessionId)
        expect(entry).toBeDefined()
        expect(entry?.sessionId).toBe("s1")
        expect(entry?.summary).toBe("Test context")

        // The present Deferred should resolve
        const decision = yield* Deferred.await(decisionDeferred)
        expect(decision).toBe("confirm")
      }),
    )

    liveTest("present/respond reject flow returns entry", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        const requestIdDeferred = yield* Deferred.make<string>()

        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s2" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        const decisionDeferred = yield* Deferred.make<HandoffDecision>()
        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s2" as SessionId,
              branchId: "b2" as BranchId,
              summary: "Rejected context",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(decisionDeferred, d))),
        )

        const requestId = yield* Deferred.await(requestIdDeferred)

        // Respond with reject
        const entry = yield* handler.respond(requestId, "reject", undefined, "Not ready yet")
        expect(entry).toBeDefined()
        expect(entry?.summary).toBe("Rejected context")

        const decision = yield* Deferred.await(decisionDeferred)
        expect(decision).toBe("reject")
      }),
    )

    liveTest("respond to unknown requestId returns undefined", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const result = yield* handler.respond("nonexistent", "confirm", "s" as SessionId)
        expect(result).toBeUndefined()
      }),
    )

    liveTest("double respond returns undefined on second call", () =>
      Effect.gen(function* () {
        const handler = yield* HandoffHandler
        const eventStore = yield* EventStore

        const requestIdDeferred = yield* Deferred.make<string>()

        yield* Effect.forkDetach(
          eventStore.subscribe({ sessionId: "s3" as SessionId }).pipe(
            Stream.runForEach((env) =>
              Effect.gen(function* () {
                if (env.event._tag === "HandoffPresented") {
                  yield* Deferred.succeed(
                    requestIdDeferred,
                    (env.event as HandoffPresented).requestId,
                  )
                }
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        yield* Effect.forkDetach(
          handler
            .present({
              sessionId: "s3" as SessionId,
              branchId: "b3" as BranchId,
              summary: "Double respond test",
            })
            .pipe(Effect.flatMap(() => Effect.void)),
        )

        const requestId = yield* Deferred.await(requestIdDeferred)

        // First respond succeeds
        const first = yield* handler.respond(requestId, "confirm", "child" as SessionId)
        expect(first).toBeDefined()

        // Second respond returns undefined (already consumed)
        const second = yield* handler.respond(requestId, "reject")
        expect(second).toBeUndefined()
      }),
    )
  })
})
