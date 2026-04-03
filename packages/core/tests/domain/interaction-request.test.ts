import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
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

        interface TestParams {
          sessionId: SessionId
          branchId: BranchId
          value: string
        }

        const TestParamsSchema = Schema.Struct({
          sessionId: Schema.String,
          branchId: Schema.String,
          value: Schema.String,
        })

        const interaction = makeInteractionService<TestParams, string>({
          type: "permission",
          paramsSchema: TestParamsSchema,
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
          storage: storageCallbacks,
        })

        // present() should fail with InteractionPendingError
        const error = yield* Effect.flip(
          interaction.present({
            sessionId: "s1" as SessionId,
            branchId: "b1" as BranchId,
            value: "test",
          }),
        )
        expect(error._tag).toBe("InteractionPendingError")
        expect(error.requestId).toBeTruthy()
        expect(error.sessionId).toBe("s1")
        expect(error.branchId).toBe("b1")

        // Verify persisted to storage
        const pending = yield* is.listPending()
        expect(pending.length).toBe(1)
        expect(pending[0]!.type).toBe("permission")
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

  test("storeResolution + subsequent present returns stored value without throwing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const interaction = makeInteractionService<
          { sessionId: SessionId; branchId: BranchId },
          string
        >({
          type: "permission",
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
        })

        const sessionId = "s-cold" as SessionId
        const branchId = "b-cold" as BranchId

        // First present — fails with InteractionPendingError
        const error = yield* Effect.flip(interaction.present({ sessionId, branchId }))
        expect(error._tag).toBe("InteractionPendingError")

        // Store resolution (simulates what respond() + machine does)
        interaction.storeResolution(sessionId, branchId, "allow")

        // Second present — finds stored resolution, returns it
        const result = yield* interaction.present({ sessionId, branchId })
        expect(result).toBe("allow")
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

        interface TestParams {
          sessionId: SessionId
          branchId: BranchId
        }

        const TestParamsSchema = Schema.Struct({
          sessionId: Schema.String,
          branchId: Schema.String,
        })

        const interaction = makeInteractionService<TestParams, string>({
          type: "prompt",
          paramsSchema: TestParamsSchema,
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          autoResolve: () => "auto-yes",
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
          storage: storageCallbacks,
        })

        // Auto-resolved — should not persist and not throw
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

  test("present fails loudly when durable storage has no params schema", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const is = yield* InteractionStorage

        const interaction = makeInteractionService<
          { sessionId: SessionId; branchId: BranchId },
          string
        >({
          type: "prompt",
          onPresent: () => Effect.void,
          onRespond: () => Effect.void,
          getContext: (p) => ({ sessionId: p.sessionId, branchId: p.branchId }),
          storage: {
            persist: (record) =>
              is.persist(record).pipe(
                Effect.asVoid,
                Effect.catchEager(() => Effect.void),
              ),
            resolve: (requestId) =>
              is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
          },
        })

        const error = yield* Effect.flip(
          interaction.present({
            sessionId: "s-schema" as SessionId,
            branchId: "b-schema" as BranchId,
          }),
        )

        expect(error._tag).toBe("EventStoreError")
        expect(error.message).toContain("requires paramsSchema")
      }).pipe(Effect.provide(storageLive)),
    )
  })
})
