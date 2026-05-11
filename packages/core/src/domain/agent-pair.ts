/**
 * Pure helper that resolves the primary + reviewer model pair used by
 * dual-model workflows (plan/review/research/counsel/audit tools and the
 * auth-guard required-provider check).
 *
 * Algorithm: name-based (`cowork` + `deepwork`) first, then positional
 * fallback to the first two modeled agents, then single-agent self-pair,
 * then fail.
 *
 * Plain function over an already-resolved agent list — no service Tag,
 * no privileged registry access required.
 */

import { Effect, Schema } from "effect"
import type { ModelId } from "./model.js"
import { resolveAgentModel, type AgentDefinition } from "./agent.js"

export class NoModeledAgentsError extends Schema.TaggedErrorClass<NoModeledAgentsError>()(
  "NoModeledAgentsError",
  {
    message: Schema.String,
  },
) {}

export const resolveDualModelPair = (
  agents: ReadonlyArray<AgentDefinition>,
): Effect.Effect<readonly [ModelId, ModelId], NoModeledAgentsError> =>
  Effect.gen(function* () {
    // 1. Name-based: cowork + deepwork (the standard dual-model pair)
    const cowork = agents.find((a) => a.name === "cowork")
    const deepwork = agents.find((a) => a.name === "deepwork")
    if (cowork !== undefined && deepwork !== undefined) {
      return [resolveAgentModel(cowork), resolveAgentModel(deepwork)] as const
    }
    // 2. Position-based fallback: first two modeled agents
    const [first, second] = agents.filter((agent) => agent.model !== undefined)
    if (first !== undefined && second !== undefined) {
      return [resolveAgentModel(first), resolveAgentModel(second)] as const
    }
    if (first !== undefined) {
      return [resolveAgentModel(first), resolveAgentModel(first)] as const
    }
    return yield* new NoModeledAgentsError({
      message:
        "No modeled agents registered — dual-model workflows require at least one agent with a model",
    })
  })
