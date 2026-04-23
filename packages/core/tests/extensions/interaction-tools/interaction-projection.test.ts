/**
 * InteractionProjection regression locks.
 *
 * Replaces the deleted interaction-actor.test.ts. The actor was pure
 * projection mislabeled — its only job was to mirror events into a UI
 * snapshot. The projection now derives the same shape from
 * `InteractionStorage.listPending(scope)` per evaluation. Source of truth
 * is the storage row, not an in-memory mirror.
 *
 * Locked contracts:
 *  - empty pending → empty model `{}`
 *  - one pending → model `{ requestId, text, metadata? }` matching the
 *    TUI snapshot reader's destructure shape (use-session-feed.ts:333)
 *  - resolved interactions are filtered out (storage.resolve flips status)
 *  - unrelated session+branch pending entries are NOT exposed
 *  - missing branchId in ctx returns empty model (defensive)
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { InteractionStorage } from "@gent/core/storage/interaction-storage"
import { InteractionProjection } from "@gent/extensions/interaction-tools/projection"
import { encodeInteractionParams } from "@gent/core/domain/interaction-request"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { ProjectionUiContext } from "@gent/core/domain/projection"

// `Storage.MemoryWithSql()` provides `InteractionStorage` AND
// `InteractionPendingReader` (the read-only seam used by the projection).

const sid1 = SessionId.make("019d97e0-0000-7000-aaaa-000000000001")
const bid1 = BranchId.make("019d97e0-0000-7001-aaaa-000000000001")
const sid2 = SessionId.make("019d97e0-0000-7000-bbbb-000000000002")
const bid2 = BranchId.make("019d97e0-0000-7001-bbbb-000000000002")

const ctx = (sessionId: SessionId, branchId?: BranchId): ProjectionUiContext => ({
  sessionId,
  ...(branchId !== undefined ? { branchId } : ({} as { branchId: BranchId })),
  cwd: "/tmp",
  home: "/tmp",
})

const layer = Storage.MemoryWithSql()

describe("InteractionProjection", () => {
  it.live("empty pending returns empty model", () =>
    Effect.gen(function* () {
      const value = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(value.model).toEqual({})
    }).pipe(Effect.provide(layer)),
  )

  it.live("one pending interaction populates model", () =>
    Effect.gen(function* () {
      const storage = yield* InteractionStorage
      const paramsJson = yield* encodeInteractionParams({
        text: "Deploy?",
        metadata: { type: "prompt", mode: "confirm" },
      })
      yield* storage.persist({
        requestId: "req-1",
        type: "approval",
        sessionId: sid1,
        branchId: bid1,
        paramsJson,
        status: "pending",
        createdAt: 1,
      })

      const value = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(value.model.requestId).toBe("req-1")
      expect(value.model.text).toBe("Deploy?")
      expect(value.model.metadata).toEqual({ type: "prompt", mode: "confirm" })
    }).pipe(Effect.provide(layer)),
  )

  it.live("resolved interactions are filtered out", () =>
    Effect.gen(function* () {
      const storage = yield* InteractionStorage
      const paramsJson = yield* encodeInteractionParams({ text: "Approve?" })
      yield* storage.persist({
        requestId: "req-2",
        type: "approval",
        sessionId: sid1,
        branchId: bid1,
        paramsJson,
        status: "pending",
        createdAt: 1,
      })
      // Confirm pending picks it up
      const before = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(before.model.requestId).toBe("req-2")

      // Resolve, then projection should report empty
      yield* storage.resolve("req-2")
      const after = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(after.model).toEqual({})
    }).pipe(Effect.provide(layer)),
  )

  it.live("scoped — pending in another session does not leak in", () =>
    Effect.gen(function* () {
      const storage = yield* InteractionStorage
      const paramsJson = yield* encodeInteractionParams({ text: "Other session" })
      yield* storage.persist({
        requestId: "req-other",
        type: "approval",
        sessionId: sid2,
        branchId: bid2,
        paramsJson,
        status: "pending",
        createdAt: 1,
      })
      const value = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(value.model).toEqual({})
    }).pipe(Effect.provide(layer)),
  )

  it.live("pending without metadata: model has no metadata key (not metadata: undefined)", () =>
    Effect.gen(function* () {
      const storage = yield* InteractionStorage
      const paramsJson = yield* encodeInteractionParams({ text: "no meta" })
      yield* storage.persist({
        requestId: "req-no-meta",
        type: "approval",
        sessionId: sid1,
        branchId: bid1,
        paramsJson,
        status: "pending",
        createdAt: 1,
      })
      const value = yield* InteractionProjection.query(ctx(sid1, bid1))
      expect(value.model.requestId).toBe("req-no-meta")
      expect(value.model.text).toBe("no meta")
      expect(Object.hasOwn(value.model, "metadata")).toBe(false)
    }).pipe(Effect.provide(layer)),
  )

  it.live("missing branchId in ctx returns empty model (defensive)", () =>
    Effect.gen(function* () {
      const value = yield* InteractionProjection.query(ctx(sid1))
      expect(value.model).toEqual({})
    }).pipe(Effect.provide(layer)),
  )
})
