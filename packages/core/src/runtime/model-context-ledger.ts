import { Context, Effect, Layer, Option, Ref, Schema } from "effect"

/** What the model last saw as its context, recorded after each projection. */
export const ModelContextStatus = Schema.Struct({
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  contextLimitTokens: Schema.Natural,
  omittedMessages: Schema.Natural,
  /** Revision of the newest summary in the projection; absent when nothing is compacted. */
  compactedRevision: Schema.optional(Schema.String),
})
export type ModelContextStatus = typeof ModelContextStatus.Type

/** A request the model made from inside a cell; the next projection consumes it. */
export const ContextDirective = Schema.TaggedUnion({
  Compact: { instructions: Schema.optional(Schema.String) },
  NewWindow: {},
})
export type ContextDirective = typeof ContextDirective.Type

export interface ModelContextLedgerService {
  readonly status: Effect.Effect<Option.Option<ModelContextStatus>>
  readonly recordProjection: (status: ModelContextStatus) => Effect.Effect<void>
  /** A later directive replaces an earlier one; only the newest is honored. */
  readonly schedule: (directive: ContextDirective) => Effect.Effect<void>
  /** Hands the pending directive to the projection exactly once. */
  readonly takeDirective: Effect.Effect<Option.Option<ContextDirective>>
}

/** One branch's view of its model context: the last projection and any pending directive. */
export class ModelContextLedger extends Context.Service<
  ModelContextLedger,
  ModelContextLedgerService
>()("@gent/core/src/runtime/model-context-ledger/ModelContextLedger") {
  static make = Effect.gen(function* () {
    const statusRef = yield* Ref.make(Option.none<ModelContextStatus>())
    const directiveRef = yield* Ref.make(Option.none<ContextDirective>())
    return ModelContextLedger.of({
      status: Ref.get(statusRef),
      recordProjection: (status) => Ref.set(statusRef, Option.some(status)),
      schedule: (directive) => Ref.set(directiveRef, Option.some(directive)),
      takeDirective: Ref.getAndSet(directiveRef, Option.none()),
    })
  })

  static Branch = Layer.effect(ModelContextLedger, ModelContextLedger.make)
}
