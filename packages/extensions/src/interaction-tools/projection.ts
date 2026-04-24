/**
 * InteractionProjection — derives the active pending-interaction snapshot
 * from `InteractionPendingReader` (a read-only seam over `InteractionStorage`).
 *
 * The projection itself contributes no agent-loop surface. It registers the
 * extension as having observable state, so the event publisher emits
 * `ExtensionStateChanged` pulses for refetch signals; clients query the
 * actual pending interaction via the typed transport surface.
 *
 * @module
 */

import { Effect, Schema } from "effect"
import { type ProjectionContribution, ProjectionError } from "@gent/core/extensions/api"
import { InteractionPendingReader } from "../builtin-internal.js"

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
}
