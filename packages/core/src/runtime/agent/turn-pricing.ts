import { Effect } from "effect"
import { calculateCost, type ModelId } from "../../domain/model.js"
import { ModelRegistry } from "../model-registry.js"

// Freeze pricing into the StreamEnded event at emit time. Returns undefined
// when usage is absent or pricing is missing; the reducer treats that as a
// zero contribution. Storing the computed cost on the event makes the
// transcript authoritative: replaying the same events always sums to the
// same cost, even if ModelRegistry pricing later refreshes.
export const computeStreamEndedCost: (params: {
  modelId: ModelId
  usage: { inputTokens: number; outputTokens: number } | undefined
}) => Effect.Effect<number | undefined, never, ModelRegistry> = Effect.fn(
  "TurnHelpers.computeStreamEndedCost",
)(function* (params) {
  if (params.usage === undefined) return undefined
  const modelRegistry = yield* ModelRegistry
  const pricing = yield* modelRegistry.list().pipe(
    Effect.map((models) => models.find((m) => m.id === params.modelId)?.pricing),
    Effect.catchEager(() =>
      Effect.sync((): { readonly input: number; readonly output: number } | undefined => undefined),
    ),
  )
  if (pricing === undefined) return undefined
  return calculateCost(params.usage, pricing)
})
