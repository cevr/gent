import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import {
  makeInteractionService,
  type InteractionRequestRecord,
  type InteractionStorageConfig,
} from "@gent/core/domain/interaction-request"
import type { SessionId, BranchId } from "@gent/core/domain/ids"

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
            { sessionId: "s1" as SessionId, branchId: "b1" as BranchId },
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
          type: "approval",
          sessionId: "s3" as SessionId,
          branchId: "b3" as BranchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })
        yield* is.persist({
          requestId: "req-del-2",
          type: "approval",
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

  test("storeResolution + subsequent present returns stored value without throwing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
        })

        const sessionId = "s-cold" as SessionId
        const branchId = "b-cold" as BranchId

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
          { sessionId: "s4" as SessionId, branchId: "b5" as BranchId },
        )
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("auto")

        const pending = yield* is.listPending()
        expect(pending.filter((r) => r.sessionId === "s4").length).toBe(0)
      }).pipe(Effect.provide(storageLive)),
    )
  })
})
