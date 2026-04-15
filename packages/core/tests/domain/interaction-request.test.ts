import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import {
  makeInteractionService,
  type InteractionRequestRecord,
  type InteractionStorageConfig,
} from "@gent/core/domain/interaction-request"
import { SessionId, BranchId } from "@gent/core/domain/ids"

// ============================================================================
// Interaction Request — cold interaction mechanics
// ============================================================================

describe("Interaction Request", () => {
  const storageLive = Storage.MemoryWithSql()

  test("present persists request to storage and throws InteractionPendingError", async () => {
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

        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
          storage: storageCallbacks,
        })

        // present() should fail with InteractionPendingError
        const error = yield* Effect.flip(
          interaction.present(
            { text: "Approve this?" },
            { sessionId: SessionId.of("s1"), branchId: BranchId.of("b1") },
          ),
        )
        expect(error._tag).toBe("InteractionPendingError")
        expect(error.requestId).toBeTruthy()
        expect(error.sessionId).toBe("s1")
        expect(error.branchId).toBe("b1")

        // Verify persisted to storage
        const pending = yield* is.listPending()
        expect(pending.length).toBe(1)
        expect(pending[0]!.sessionId).toBe("s1")
        expect(pending[0]!.branchId).toBe("b1")
        expect(pending[0]!.status).toBe("pending")
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
          type: "approval",
          sessionId: SessionId.of("s2"),
          branchId: BranchId.of("b2"),
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
          type: "approval",
          sessionId: SessionId.of("s3"),
          branchId: BranchId.of("b3"),
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })
        yield* is.persist({
          requestId: "req-del-2",
          type: "approval",
          sessionId: SessionId.of("s3"),
          branchId: BranchId.of("b4"),
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })

        // Delete only b3
        yield* is.deletePending(SessionId.of("s3"), BranchId.of("b3"))

        // Only b4 should remain
        const remaining = yield* is.listPending()
        expect(remaining.filter((r) => r.sessionId === "s3").length).toBe(1)
        expect(remaining[0]!.branchId).toBe("b4")
      }).pipe(Effect.provide(storageLive)),
    )
  })

  test("storeResolution + subsequent present returns stored value without throwing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
        })

        const sessionId = SessionId.of("s-cold")
        const branchId = BranchId.of("b-cold")

        // First present — fails with InteractionPendingError
        const error = yield* Effect.flip(
          interaction.present({ text: "Approve?" }, { sessionId, branchId }),
        )
        expect(error._tag).toBe("InteractionPendingError")

        // Store resolution keyed by requestId
        interaction.storeResolution(error.requestId, { approved: true })

        // Second present — finds stored resolution, returns it
        const result = yield* interaction.present({ text: "Approve?" }, { sessionId, branchId })
        expect(result.approved).toBe(true)
      }),
    )
  })

  test("rehydrate + storeResolution + present returns stored value (restart-resume)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Simulate a fresh service after restart — no in-memory state
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
        })

        const sessionId = SessionId.of("s-restart")
        const branchId = BranchId.of("b-restart")
        const requestId = "req-restart-1"

        // Rehydrate rebuilds the pendingByContext reverse lookup
        yield* interaction.rehydrate(requestId, { text: "Approve?" }, { sessionId, branchId })

        // Client responds — store the resolution
        interaction.storeResolution(requestId, { approved: true, notes: "yes" })

        // Tool re-calls present() — should find stored resolution via context lookup
        const result = yield* interaction.present({ text: "Approve?" }, { sessionId, branchId })
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("yes")
      }),
    )
  })

  test("cold-resume with InteractionStorage: persist → new service → rehydrate → resolve", async () => {
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

        const sessionId = SessionId.of("s-cold-resume")
        const branchId = BranchId.of("b-cold-resume")

        // Phase 1: original service — present() persists and throws
        const service1 = makeInteractionService({
          onPresent: () => Effect.void,
          storage: storageCallbacks,
        })

        const error = yield* Effect.flip(
          service1.present({ text: "Approve deployment?" }, { sessionId, branchId }),
        )
        expect(error._tag).toBe("InteractionPendingError")
        const requestId = error.requestId

        // Verify persisted to SQL
        const pending = yield* is.listPending()
        expect(pending.some((r) => r.requestId === requestId)).toBe(true)

        // Phase 2: simulate restart — create a fresh service instance (no in-memory state)
        const service2 = makeInteractionService({
          onPresent: () => Effect.void,
          storage: storageCallbacks,
        })

        // Load pending request from storage and rehydrate
        const persisted = pending.find((r) => r.requestId === requestId)!
        const params = JSON.parse(persisted.paramsJson) as { text: string; metadata?: unknown }
        yield* service2.rehydrate(requestId, params, { sessionId, branchId })

        // Client responds
        service2.storeResolution(requestId, { approved: true, notes: "ship it" })

        // Tool re-calls present() — should find the stored resolution
        const result = yield* service2.present(
          { text: "Approve deployment?" },
          { sessionId, branchId },
        )
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("ship it")

        // Verify resolved in storage
        const afterResolve = yield* is.listPending()
        expect(afterResolve.some((r) => r.requestId === requestId)).toBe(false)
      }).pipe(Effect.provide(storageLive)),
    )
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

        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
          autoResolve: () => ({ approved: true, notes: "auto" }),
          storage: storageCallbacks,
        })

        // Auto-resolved — should not persist and not throw
        const result = yield* interaction.present(
          { text: "Auto approve?" },
          { sessionId: SessionId.of("s4"), branchId: BranchId.of("b5") },
        )
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("auto")

        const pending = yield* is.listPending()
        expect(pending.filter((r) => r.sessionId === "s4").length).toBe(0)
      }).pipe(Effect.provide(storageLive)),
    )
  })
})
