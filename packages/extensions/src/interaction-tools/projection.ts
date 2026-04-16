/**
 * InteractionProjection — derives the active pending-interaction snapshot
 * from `InteractionPendingReader` (a read-only seam over `InteractionStorage`).
 *
 * Replaces the actor-as-mirror that mapped `InteractionPresented`/
 * `InteractionResolved` events into a `Pending` state. The actor's only
 * job was the snapshot; the actual interaction workflow is owned by
 * `AgentLoop.WaitingForInteraction` + `ApprovalService`. The actor was
 * pure projection mislabeled (`derive-do-not-create-states`).
 *
 * Boundary: the extension does NOT see `InteractionStorage` (which has
 * `persist`/`resolve`/`deletePending`). It sees `InteractionPendingReader`
 * — a read-only view that decodes params at the seam and exposes only
 * `listPending(scope?)`. This is `boundary-discipline`: the contract a
 * projection can hold is structurally read-only, not enforced by lint
 * method-name allowlists alone.
 *
 * Surfaces:
 *   - `ui` — `{ requestId?, text?, metadata? }`. Empty object when no
 *     pending interaction exists for this session+branch. Shape matches
 *     the TUI snapshot reader's destructure (`use-session-feed.ts:333`).
 *
 * @module
 */

import { Effect, Schema } from "effect"
import {
  type ProjectionContribution,
  ProjectionError,
  InteractionPendingReader,
} from "@gent/core/extensions/api"

export const InteractionUiModel = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
})
export type InteractionUiModel = typeof InteractionUiModel.Type

interface InteractionProjectionValue {
  readonly model: InteractionUiModel
}

export const InteractionProjection: ProjectionContribution<
  InteractionProjectionValue,
  InteractionPendingReader
> = {
  id: "interaction-pending",
  query: (ctx) =>
    Effect.gen(function* () {
      // The projection has no branchId in some contexts — when absent,
      // we cannot scope, so return an empty model. Production always has
      // both for UI evaluation (event-publisher passes the real branch).
      if (ctx.branchId === undefined) return { model: {} }
      const reader = yield* InteractionPendingReader
      const pending = yield* reader
        .listPending({ sessionId: ctx.sessionId, branchId: ctx.branchId })
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(
              new ProjectionError({
                projectionId: "interaction-pending",
                reason: `InteractionPendingReader.listPending failed: ${String(e)}`,
              }),
            ),
          ),
        )
      const first = pending[0]
      if (first === undefined) return { model: {} }
      return {
        model: {
          requestId: first.requestId,
          text: first.text,
          ...(first.metadata !== undefined ? { metadata: first.metadata } : {}),
        },
      }
    }),
  ui: {
    schema: InteractionUiModel,
    project: (value) => value.model,
  },
}
