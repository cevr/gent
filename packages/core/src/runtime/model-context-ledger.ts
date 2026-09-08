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
  /** The directive waiting for the next projection; it stays until acknowledged or discarded. */
  readonly pendingDirective: Effect.Effect<Option.Option<ContextDirective>>
  /** Clears the directive once its projection succeeded; a newer directive survives. */
  readonly acknowledgeDirective: (directive: ContextDirective) => Effect.Effect<void>
  /** Drops whatever is pending; a new turn starts without the last turn's request. */
  readonly discardDirective: Effect.Effect<void>
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
      pendingDirective: Ref.get(directiveRef),
      acknowledgeDirective: (directive) =>
        Ref.update(directiveRef, (current) =>
          Option.filter(current, (value) => value !== directive),
        ),
      discardDirective: Ref.set(directiveRef, Option.none()),
    })
  })

  static Branch = Layer.effect(ModelContextLedger, ModelContextLedger.make)
}
