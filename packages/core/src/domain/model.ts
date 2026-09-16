import { Option, Schema } from "effect"
import { branded } from "./ids.js"

// Model ID - provider/model format

export const ModelId = Schema.String.pipe(branded("ModelId"))
export type ModelId = typeof ModelId.Type

// Provider - AI provider identifier (open, branded string — extensible via extensions)

export const ProviderId = Schema.String.pipe(branded("ProviderId"))
export type ProviderId = typeof ProviderId.Type

// Model pricing per million tokens (USD)

export const ModelPricing = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})
export type ModelPricing = typeof ModelPricing.Type

// Model - individual model from a provider (built-in or custom)

export class Model extends Schema.Class<Model>("Model")({
  id: ModelId,
  name: Schema.String,
  provider: ProviderId,
  contextLength: Schema.optional(Schema.Finite),
  pricing: Schema.optional(ModelPricing),
  /** models.dev `release_date`, an ISO-8601 prefix: `2026-02-17` or `2025-04`. */
  releaseDate: Schema.optional(Schema.String),
}) {}

/**
 * Newest release first; models without a date sort last.
 *
 * ISO-8601 prefixes compare correctly as plain strings, so a partial
 * `2025-04` orders just ahead of any fuller date in that month.
 */
export const byReleaseDateDesc = (models: readonly Model[]): readonly Model[] =>
  [...models].sort((left, right) => {
    const l = Option.getOrElse(Option.fromUndefinedOr(left.releaseDate), () => "")
    const r = Option.getOrElse(Option.fromUndefinedOr(right.releaseDate), () => "")
    if (l === r) return 0
    if (l.length === 0) return 1
    if (r.length === 0) return -1
    if (l > r) return -1
    return 1
  })

// Calculate cost from token usage

export const calculateCost = (
  usage: { inputTokens: number; outputTokens: number },
  pricing: Option.Option<ModelPricing>,
): number => {
  if (Option.isNone(pricing)) return 0
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.value.input
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.value.output
  return inputCost + outputCost
}

export const parseModelProvider = (modelId: string): Option.Option<ProviderId> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some(ProviderId.make(modelId.slice(0, slash)))
}

export const parseModelId = (modelId: string): Option.Option<readonly [ProviderId, string]> => {
  const slash = modelId.indexOf("/")
  if (slash <= 0 || slash === modelId.length - 1) return Option.none()
  return Option.some([ProviderId.make(modelId.slice(0, slash)), modelId.slice(slash + 1)])
}
