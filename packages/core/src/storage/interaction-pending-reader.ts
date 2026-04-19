/**
 * InteractionPendingReader — read-only extension boundary into pending
 * interaction requests.
 *
 * Wraps `InteractionStorage.listPending(scope)` and decodes the params at
 * the service boundary so projections receive `{ requestId, text,
 * metadata? }` directly rather than a paramsJson blob.
 *
 * The full `InteractionStorage` (with `persist`, `resolve`, `deletePending`)
 * is intentionally NOT exported through `@gent/core/extensions/api`. Per
 * `boundary-discipline`: extensions get a read-only seam; writes happen in
 * `ApprovalService` / `AgentLoop`. The lint rule `gent/no-projection-writes`
 * cannot catch arbitrary method names like `persist`/`resolve`, so the
 * boundary itself is what enforces the contract — counsel finding from
 * Commit 6.
 *
 * @module
 */

import { Context, Effect, Layer } from "effect"
import { decodeInteractionParams } from "../domain/interaction-request.js"
import { type ReadOnly, ReadOnlyBrand, withReadOnly } from "../domain/read-only.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import { InteractionStorage } from "./interaction-storage.js"
import type { StorageError } from "./sqlite-storage.js"

/** A pending interaction surfaced through the read-only boundary. */
export interface PendingInteraction {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly text: string
  readonly metadata?: unknown
  readonly createdAt: number
}

export interface InteractionPendingReaderService {
  /** List pending interactions, scoped to a session+branch when provided. */
  readonly listPending: (scope?: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<ReadonlyArray<PendingInteraction>, StorageError>
}

/**
 * `InteractionPendingReader` carries the `ReadOnly` brand — the surface
 * is structurally read-only by construction (only `listPending` is
 * exposed; writes live on `InteractionStorage`). The brand makes the
 * read-only contract checkable at the type level for projection and
 * read-intent capability R-channels (B11.4).
 */
export class InteractionPendingReader extends Context.Service<
  InteractionPendingReader,
  ReadOnly<InteractionPendingReaderService>
>()("@gent/core/src/storage/interaction-pending-reader/InteractionPendingReader") {
  // Brand on the Tag identifier — see `domain/read-only.ts`.
  declare readonly [ReadOnlyBrand]: true

  static Live: Layer.Layer<InteractionPendingReader, never, InteractionStorage> = Layer.effect(
    InteractionPendingReader,
    Effect.gen(function* () {
      const storage = yield* InteractionStorage
      return withReadOnly({
        listPending: (scope) =>
          Effect.gen(function* () {
            const records = yield* storage.listPending(scope)
            const out: PendingInteraction[] = []
            for (const r of records) {
              const params = yield* decodeInteractionParams(r.paramsJson).pipe(
                Effect.catchEager(() =>
                  Effect.succeed({ text: "<unparseable>", metadata: undefined }),
                ),
              )
              out.push({
                requestId: r.requestId,
                sessionId: r.sessionId,
                branchId: r.branchId,
                text: params.text,
                ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
                createdAt: r.createdAt,
              })
            }
            return out
          }),
      } satisfies InteractionPendingReaderService)
    }),
  )
}
