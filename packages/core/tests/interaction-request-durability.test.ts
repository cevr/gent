import { describe, test, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import {
  makeInteractionService,
  type InteractionRequestRecord,
  type InteractionStorageConfig,
} from "@gent/core/domain/interaction-request"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

// ============================================================================
// Interaction Request Durability
// ============================================================================

describe("Interaction Request Durability", () => {
  const storageLayer = Storage.MemoryWithSql()
  const storageLive = Layer.mergeAll(
    storageLayer,
    Layer.provide(InteractionStorage.Live, storageLayer),
  )

  test("present persists request to storage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const is = yield* InteractionStorage

        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) =>
            is.persist(record).pipe(
              Effect.asVoid,
              Effect.catchEager(() => Effect.void),
            ),
          resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        }

        interface TestParams {
          sessionId: SessionId
          branchId: BranchId
          value: string
        }

        const interaction = makeInteractionService<TestParams, string>({
          type: "permission",
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
          storage: storageCallbacks,
        })

        // Fork present — it will block on the deferred
        const resultDeferred = yield* Deferred.make<string>()
        yield* Effect.forkDetach(
          interaction
            .present({
              sessionId: "s1" as SessionId,
              branchId: "b1" as BranchId,
              value: "test",
            })
            .pipe(Effect.flatMap((d) => Deferred.succeed(resultDeferred, d))),
        )

        // Give the fork time to persist
        yield* Effect.sleep("10 millis")

        // Verify persisted
        const pending = yield* is.listPending()
        expect(pending.length).toBe(1)
        expect(pending[0]!.type).toBe("permission")
        expect(pending[0]!.sessionId).toBe("s1")
        expect(pending[0]!.branchId).toBe("b1")
        expect(pending[0]!.status).toBe("pending")

        // Respond — should resolve the deferred
        const requestId = pending[0]!.requestId
        yield* interaction.respond(requestId, "allow")

        const result = yield* Deferred.await(resultDeferred)
        expect(result).toBe("allow")

        // Verify resolved in storage
        const afterResolve = yield* is.listPending()
        expect(afterResolve.length).toBe(0)
      }).pipe(Effect.provide(storageLive)),
    )
  })

  test("respond marks request as resolved in storage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const is = yield* InteractionStorage

        // Manually insert a pending record
        const record: InteractionRequestRecord = {
          requestId: "req-manual-1",
          type: "prompt",
          sessionId: "s2" as SessionId,
          branchId: "b2" as BranchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        }
        yield* is.persist(record)

        // Verify it's pending
        const before = yield* is.listPending()
        expect(before.some((r) => r.requestId === "req-manual-1")).toBe(true)

        // Resolve it
        yield* is.resolve("req-manual-1")

        // Verify it's no longer pending
        const after = yield* is.listPending()
        expect(after.some((r) => r.requestId === "req-manual-1")).toBe(false)
      }).pipe(Effect.provide(storageLive)),
    )
  })

  test("deletePendingInteractionRequests clears by session+branch", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const is = yield* InteractionStorage

        // Insert requests for two different branches
        yield* is.persist({
          requestId: "req-del-1",
          type: "permission",
          sessionId: "s3" as SessionId,
          branchId: "b3" as BranchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })
        yield* is.persist({
          requestId: "req-del-2",
          type: "handoff",
          sessionId: "s3" as SessionId,
          branchId: "b4" as BranchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })

        // Delete only b3
        yield* is.deletePending("s3" as SessionId, "b3" as BranchId)

        // Only b4 should remain
        const remaining = yield* is.listPending()
        expect(remaining.filter((r) => r.sessionId === "s3").length).toBe(1)
        expect(remaining[0]!.branchId).toBe("b4")
      }).pipe(Effect.provide(storageLive)),
    )
  })

  test("double respond is idempotent — second call is a no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const interaction = makeInteractionService<
          { sessionId: SessionId; branchId: BranchId },
          string
        >({
          type: "permission",
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
        })

        // Fork present — blocks on deferred
        const resultDeferred = yield* Deferred.make<string>()
        yield* Effect.forkDetach(
          interaction
            .present({ sessionId: "s-dr" as SessionId, branchId: "b-dr" as BranchId })
            .pipe(Effect.flatMap((d) => Deferred.succeed(resultDeferred, d))),
        )
        yield* Effect.sleep("10 millis")

        // Get the requestId from pending map
        const entries = [...interaction.pending.entries()]
        expect(entries.length).toBe(1)
        const requestId = entries[0]![0]

        // First respond — should succeed
        const first = yield* interaction.respond(requestId, "allow")
        expect(first).toBeDefined()

        // Second respond — should be no-op
        const second = yield* interaction.respond(requestId, "deny")
        expect(second).toBeUndefined()

        // The deferred should have resolved with the first decision
        const result = yield* Deferred.await(resultDeferred)
        expect(result).toBe("allow")
      }),
    )
  })

  test("claim is atomic — second claim returns undefined", () => {
    const interaction = makeInteractionService<{ value: string }, string>({
      type: "permission",
      onPresent: () => Effect.void,
      onRespond: () => Effect.void,
    })

    // Manually insert a pending entry for testing
    const deferred = Effect.runSync(Deferred.make<string>())
    interaction.pending.set("req-claim", { deferred, params: { value: "test" } })

    // First claim succeeds
    const first = interaction.claim("req-claim")
    expect(first).toBeDefined()
    expect(first!.params.value).toBe("test")

    // Second claim returns undefined
    const second = interaction.claim("req-claim")
    expect(second).toBeUndefined()
  })

  test("autoResolve skips storage persistence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const is = yield* InteractionStorage

        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) =>
            is.persist(record).pipe(
              Effect.asVoid,
              Effect.catchEager(() => Effect.void),
            ),
          resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        }

        interface TestParams {
          sessionId: SessionId
          branchId: BranchId
        }

        const interaction = makeInteractionService<TestParams, string>({
          type: "prompt",
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          autoResolve: () => "auto-yes",
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
          storage: storageCallbacks,
        })

        // Auto-resolved — should not persist
        const result = yield* interaction.present({
          sessionId: "s4" as SessionId,
          branchId: "b5" as BranchId,
        })
        expect(result).toBe("auto-yes")

        const pending = yield* is.listPending()
        expect(pending.filter((r) => r.sessionId === "s4").length).toBe(0)
      }).pipe(Effect.provide(storageLive)),
    )
  })
})
