/**
 * Resolving a typed model query against the registry catalogue.
 *
 * Shared by `/model <query>` and the model picker's filter row so the two
 * agree on what a query matches: the exact id first, then a case-insensitive
 * substring of the id or display name.
 *
 * @module
 */

import { Option, Schema } from "effect"
import { Model } from "@gent/core/protocol"

const normalize = (query: string): string => query.trim().toLowerCase()

export const filterModels = (models: readonly Model[], query: string): readonly Model[] => {
  const needle = normalize(query)
  if (needle.length === 0) return models
  return models.filter(
    (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  )
}

export const ModelQueryResult = Schema.TaggedUnion({
  Match: { model: Model },
  None: {},
  Ambiguous: { candidates: Schema.Array(Model) },
})
export type ModelQueryResult = Schema.Schema.Type<typeof ModelQueryResult>

export const resolveModelQuery = (models: readonly Model[], query: string): ModelQueryResult => {
  const needle = normalize(query)
  const exact = Option.fromNullishOr(models.find((model) => model.id.toLowerCase() === needle))
  if (Option.isSome(exact)) return ModelQueryResult.cases.Match.make({ model: exact.value })
  const candidates = filterModels(models, needle)
  const single = Option.fromNullishOr(candidates[0])
  if (candidates.length === 1 && Option.isSome(single)) {
    return ModelQueryResult.cases.Match.make({ model: single.value })
  }
  if (candidates.length === 0) return ModelQueryResult.cases.None.make({})
  return ModelQueryResult.cases.Ambiguous.make({ candidates })
}
