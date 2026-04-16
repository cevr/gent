/**
 * InteractionProjection — derives the active pending-interaction snapshot
 * from `InteractionStorage`.
 *
 * Replaces the actor-as-mirror that mapped `InteractionPresented`/
 * `InteractionResolved` events into a `Pending` state. The actor's only
 * job was the snapshot; the actual interaction workflow is owned by
 * `AgentLoop.WaitingForInteraction` + `ApprovalService`. The actor was
 * pure projection mislabeled (`derive-do-not-create-states`).
 *
 * Surfaces:
 *   - `ui` — `{ requestId?, text?, metadata? }`. Empty object when no
 *     pending interaction exists for this session+branch. Shape is
 *     preserved exactly so the TUI snapshot reader (which destructures
 *     `requestId`, `text`, `metadata` from `interactionSnap.model`) is
 *     unchanged.
 *
 * @module
 */

import { Effect, Schema } from "effect"
import {
  type ProjectionContribution,
  ProjectionError,
  InteractionStorage,
  decodeInteractionParams,
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
  InteractionStorage
> = {
  id: "interaction-pending",
  query: (ctx) =>
    Effect.gen(function* () {
      // The projection has no branchId in some contexts — when absent,
      // we cannot scope, so return an empty model. Production always has
      // both for UI evaluation (event-publisher passes the real branch).
      if (ctx.branchId === undefined) return { model: {} }
      const storage = yield* InteractionStorage
      const pending = yield* storage
        .listPending({ sessionId: ctx.sessionId, branchId: ctx.branchId })
        .pipe(
          Effect.catchEager((e) =>
            Effect.fail(
              new ProjectionError({
                projectionId: "interaction-pending",
                reason: `InteractionStorage.listPending failed: ${String(e)}`,
              }),
            ),
          ),
        )
      const first = pending[0]
      if (first === undefined) return { model: {} }
      const params = yield* decodeInteractionParams(first.paramsJson).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new ProjectionError({
              projectionId: "interaction-pending",
              reason: `decodeInteractionParams failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return {
        model: {
          requestId: first.requestId,
          text: params.text,
          ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
        },
      }
    }),
  ui: {
    schema: InteractionUiModel,
    project: (value) => value.model,
  },
}
