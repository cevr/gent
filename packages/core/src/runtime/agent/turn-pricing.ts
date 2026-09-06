import { Effect, Option } from "effect"
import { calculateCost, type ModelId } from "../../domain/model.js"
import { ModelRegistry } from "../model-registry.js"

// Freeze pricing into the StreamEnded event at emit time. Returns None
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
export const computeStreamEndedCost: (params: {
  modelId: ModelId
  usage: Option.Option<{ inputTokens: number; outputTokens: number }>
}) => Effect.Effect<Option.Option<number>, never, ModelRegistry> = Effect.fn(
  "TurnHelpers.computeStreamEndedCost",
)(function* (params) {
  if (Option.isNone(params.usage)) return Option.none()
  const modelRegistry = yield* ModelRegistry
  const pricing = yield* modelRegistry.list.pipe(
    Effect.map((models) =>
      Option.fromUndefinedOr(models.find((m) => m.id === params.modelId)?.pricing),
    ),
    Effect.catchEager(() => Effect.succeedNone),
  )
  if (Option.isNone(pricing)) return Option.none()
  return Option.some(calculateCost(params.usage.value, pricing))
})
