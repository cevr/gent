import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { MessageId } from "../domain/ids.js"

/** What the model last saw as its context, recorded after each projection. */
const ModelContextStatus = Schema.Struct({
  estimatedTokens: Schema.Natural,
  availableInputTokens: Schema.Natural,
  contextLimitTokens: Schema.Natural,
  omittedMessages: Schema.Natural,
  /** The handoff marker leading the window; absent when the window carries no summary. */
  handoffMessageId: Schema.optional(MessageId),
})
type ModelContextStatus = typeof ModelContextStatus.Type

/** A request the model made from inside a cell; the next projection consumes it. */
export const ContextDirective = Schema.TaggedUnion({
  Compact: { instructions: Schema.optional(Schema.String) },
  /** The issuer says how the model recovers what the window dropped; core only keeps it durable. */
  NewWindow: { notice: Schema.NonEmptyString },
})
export type ContextDirective = typeof ContextDirective.Type

interface ModelContextLedgerService {
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

  /**
   * The ledger a branch gets when nothing schedules directives.
   *
   * Only a dispatching tool writes this ledger -- the model asks for a fresh
   * window or a focused summary from inside one. A branch without such a tool
   * still projects its context every turn, so the read side must resolve to
   * something rather than fail. Absence means "no directive, and nowhere to
   * record", not an error.
   */
  static readonly inert: ModelContextLedgerService = {
    status: Effect.succeedNone,
    recordProjection: () => Effect.void,
    schedule: () => Effect.void,
    pendingDirective: Effect.succeedNone,
    acknowledgeDirective: () => Effect.void,
    discardDirective: Effect.void,
  }
}
