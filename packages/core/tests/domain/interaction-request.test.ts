import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  InteractionStorage,
  type InteractionStorageService,
} from "@gent/core/storage/interaction-storage"
import { ensureStorageParents } from "@gent/core/test-utils"
import { EventStoreError } from "@gent/core/domain/event"
import {
  makeInteractionService,
  InteractionPendingError,
  type InteractionRequestRecord,
  type InteractionStorageConfig,
} from "@gent/core/domain/interaction-request"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core/domain/ids"

const persistInteraction = (is: InteractionStorageService, record: InteractionRequestRecord) =>
  is.persist(record).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new EventStoreError({
          message: "Failed to persist interaction request",
          cause,
        }),
    ),
  )
// ============================================================================
// Interaction Request — cold interaction mechanics
// ============================================================================
describe("Interaction Request", () => {
  const storageLive = Storage.MemoryWithSql()
  it.live("present persists request to storage and throws InteractionPendingError", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) => persistInteraction(is, record),
          resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        }
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
          storage: storageCallbacks,
        })
        yield* ensureStorageParents({
          sessionId: SessionId.make("s1"),
          branchId: BranchId.make("b1"),
        })
        // present() should fail with InteractionPendingError
        const error = yield* Effect.flip(
          interaction.present(
            { text: "Approve this?" },
            { sessionId: SessionId.make("s1"), branchId: BranchId.make("b1") },
          ),
        )
        expect(error._tag).toBe("InteractionPendingError")
        if (!(error instanceof InteractionPendingError)) throw new Error("expected pending")
        expect(error.requestId).toBeTruthy()
        expect(error.sessionId).toBe(SessionId.make("s1"))
        expect(error.branchId).toBe(BranchId.make("b1"))
        // Verify persisted to storage
        const pending = yield* is.listPending()
        expect(pending.length).toBe(1)
        expect(pending[0]!.sessionId).toBe(SessionId.make("s1"))
        expect(pending[0]!.branchId).toBe(BranchId.make("b1"))
        expect(pending[0]!.status).toBe("pending")
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("respond marks request as resolved in storage", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        // Manually insert a pending record
        const record: InteractionRequestRecord = {
          requestId: InteractionRequestId.make("req-manual-1"),
          type: "approval",
          sessionId: SessionId.make("s2"),
          branchId: BranchId.make("b2"),
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        }
        yield* ensureStorageParents({ sessionId: record.sessionId, branchId: record.branchId })
        yield* is.persist(record)
        // Verify it's pending
        const before = yield* is.listPending()
        expect(before.some((r) => r.requestId === InteractionRequestId.make("req-manual-1"))).toBe(
          true,
        )
        // Resolve it
        yield* is.resolve(InteractionRequestId.make("req-manual-1"))
        // Verify it's no longer pending
        const after = yield* is.listPending()
        expect(after.some((r) => r.requestId === InteractionRequestId.make("req-manual-1"))).toBe(
          false,
        )
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("pending requests are unique per session branch", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        const sessionId = SessionId.make("s-singleton")
        const branchId = BranchId.make("b-singleton")
        yield* ensureStorageParents({ sessionId, branchId })
        yield* is.persist({
          requestId: InteractionRequestId.make("req-singleton-1"),
          type: "approval",
          sessionId,
          branchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: 1,
        })
        const duplicate = yield* Effect.exit(
          is.persist({
            requestId: InteractionRequestId.make("req-singleton-2"),
            type: "approval",
            sessionId,
            branchId,
            paramsJson: "{}",
            status: "pending",
            createdAt: 2,
          }),
        )
        expect(duplicate._tag).toBe("Failure")
        const pending = yield* is.listPending({ sessionId, branchId })
        expect(pending.map((record) => record.requestId)).toEqual([
          InteractionRequestId.make("req-singleton-1"),
        ])
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("service fails closed when durable pending singleton rejects a second request", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        const sessionId = SessionId.make("s-service-singleton")
        const branchId = BranchId.make("b-service-singleton")
        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) => persistInteraction(is, record),
          resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        }
        yield* ensureStorageParents({ sessionId, branchId })
        yield* is.persist({
          requestId: InteractionRequestId.make("req-existing-pending"),
          type: "approval",
          sessionId,
          branchId,
          paramsJson: "{}",
          status: "pending",
          createdAt: 1,
        })

        const presented: InteractionRequestId[] = []
        const interaction = makeInteractionService({
          onPresent: (requestId) =>
            Effect.sync(() => {
              presented.push(requestId)
            }),
          storage: storageCallbacks,
        })
        const exit = yield* Effect.exit(
          interaction.present({ text: "second" }, { sessionId, branchId }),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Cause.pretty(exit.cause)).toContain("Failed to persist interaction request")
        }
        expect(presented).toEqual([])
        expect(interaction.pendingRequestId({ sessionId, branchId })).toBeUndefined()
        const pending = yield* is.listPending({ sessionId, branchId })
        expect(pending.map((record) => record.requestId)).toEqual([
          InteractionRequestId.make("req-existing-pending"),
        ])
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("deletePendingInteractionRequests clears by session+branch", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        yield* ensureStorageParents({
          sessionId: SessionId.make("s3"),
          branchId: BranchId.make("b3"),
        })
        yield* ensureStorageParents({
          sessionId: SessionId.make("s3"),
          branchId: BranchId.make("b4"),
        })
        // Insert requests for two different branches
        yield* is.persist({
          requestId: InteractionRequestId.make("req-del-1"),
          type: "approval",
          sessionId: SessionId.make("s3"),
          branchId: BranchId.make("b3"),
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })
        yield* is.persist({
          requestId: InteractionRequestId.make("req-del-2"),
          type: "approval",
          sessionId: SessionId.make("s3"),
          branchId: BranchId.make("b4"),
          paramsJson: "{}",
          status: "pending",
          createdAt: Date.now(),
        })
        // Delete only b3
        yield* is.deletePending(SessionId.make("s3"), BranchId.make("b3"))
        // Only b4 should remain
        const remaining = yield* is.listPending()
        expect(remaining.filter((r) => r.sessionId === SessionId.make("s3")).length).toBe(1)
        expect(remaining[0]!.branchId).toBe(BranchId.make("b4"))
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("storeResolution + subsequent present returns stored value without throwing", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
        })
        const sessionId = SessionId.make("s-cold")
        const branchId = BranchId.make("b-cold")
        // First present — fails with InteractionPendingError
        const error = yield* Effect.flip(
          interaction.present({ text: "Approve?" }, { sessionId, branchId }),
        )
        expect(error._tag).toBe("InteractionPendingError")
        if (!(error instanceof InteractionPendingError)) throw new Error("expected pending")
        // Store resolution keyed by requestId
        interaction.storeResolution(error.requestId, { approved: true })
        // Second present — finds stored resolution, returns it
        const result = yield* interaction.present({ text: "Approve?" }, { sessionId, branchId })
        expect(result.approved).toBe(true)
      })
    }),
  )
  it.live("rehydrate + storeResolution + present returns stored value (restart-resume)", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        // Simulate a fresh service after restart — no in-memory state
        const interaction = makeInteractionService({
          onPresent: () => Effect.void,
        })
        const sessionId = SessionId.make("s-restart")
        const branchId = BranchId.make("b-restart")
        const requestId = InteractionRequestId.make("req-restart-1")
        // Rehydrate rebuilds the pendingByContext reverse lookup
        yield* interaction.rehydrate(requestId, { text: "Approve?" }, { sessionId, branchId })
        // Client responds — store the resolution
        interaction.storeResolution(requestId, { approved: true, notes: "yes" })
        // Tool re-calls present() — should find stored resolution via context lookup
        const result = yield* interaction.present({ text: "Approve?" }, { sessionId, branchId })
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("yes")
      })
    }),
  )
  it.live("cold-resume with InteractionStorage: persist → new service → rehydrate → resolve", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) => persistInteraction(is, record),
          resolve: (requestId) => is.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
        }
        const sessionId = SessionId.make("s-cold-resume")
        const branchId = BranchId.make("b-cold-resume")
        yield* ensureStorageParents({ sessionId, branchId })
        // Phase 1: original service — present() persists and throws
        const service1 = makeInteractionService({
          onPresent: () => Effect.void,
          storage: storageCallbacks,
        })
        const error = yield* Effect.flip(
          service1.present({ text: "Approve deployment?" }, { sessionId, branchId }),
        )
        expect(error._tag).toBe("InteractionPendingError")
        if (!(error instanceof InteractionPendingError)) throw new Error("expected pending")
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
        const params = JSON.parse(persisted.paramsJson) as {
          text: string
          metadata?: unknown
        }
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
      }).pipe(Effect.provide(storageLive))
    }),
  )
  it.live("autoResolve skips storage persistence", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const is = yield* InteractionStorage
        const storageCallbacks: InteractionStorageConfig = {
          persist: (record) => persistInteraction(is, record),
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
          { sessionId: SessionId.make("s4"), branchId: BranchId.make("b5") },
        )
        expect(result.approved).toBe(true)
        expect(result.notes).toBe("auto")
        const pending = yield* is.listPending()
        expect(pending.filter((r) => r.sessionId === "s4").length).toBe(0)
      }).pipe(Effect.provide(storageLive))
    }),
  )
})
