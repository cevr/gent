/**
 * What the turn now running has spent.
 *
 * A turn's token totals, tool-call count and step count accumulate across its
 * model steps and are read once, at the end, to fill `TurnCompleted`. The
 * accumulator therefore outlives no turn: the next one starts from zero.
 *
 * A bare `Ref<TurnMetrics>` at loop scope left that fact to a hand-written
 * `Ref.set(..., emptyTurnMetrics())` at the top of `runTurn`, and the fold —
 * which totals to add, which counts make the total unreportable — sat inline
 * at the one call site that knew it. Naming the operations keeps both in one
 * place, the way `turn-interruption.ts` does for the interrupt latch:
 * `beginTurn` is the reset, and a writer says what its step observed rather
 * than how to merge it.
 *
 * @module
 */

import { Effect, Option, Ref } from "effect"
import type { AgentName as AgentNameType, ModelId as ModelIdType } from "../../domain/agent.js"
import type { Usage } from "../../domain/event.js"
import { emptyTurnMetrics, type TurnMetrics } from "./turn-response.js"

/**
 * A token count this turn can report. A provider that returns a negative,
 * fractional or oversized number has told us nothing usable, and one
 * unusable step makes the turn's total unreportable rather than wrong.
 */
const reportable = (count: number) => Number.isSafeInteger(count) && count >= 0

export interface TurnLedger {
  /** A fresh turn begins, so it has spent nothing. */
  readonly beginTurn: Effect.Effect<void>
  /** Which agent and model this turn runs as. Known before its first step. */
  readonly noteModel: (params: {
    readonly agent: AgentNameType
    readonly model: ModelIdType
  }) => Effect.Effect<void>
  /**
   * One model step finished. `usage` is absent when the provider reported
   * none, which makes this turn's total unreportable.
   */
  readonly noteStep: (params: {
    readonly agent: AgentNameType
    readonly model: ModelIdType
    readonly usage: Option.Option<Usage>
    readonly toolCallCount: number
  }) => Effect.Effect<void>
  /** What this turn spent, as `TurnCompleted` reports it. */
  readonly total: Effect.Effect<TurnMetrics>
}

export const makeTurnLedger: Effect.Effect<TurnLedger> = Effect.gen(function* () {
  const metrics = yield* Ref.make(emptyTurnMetrics())
  return {
    beginTurn: Ref.set(metrics, emptyTurnMetrics()),
    noteModel: (params) =>
      Ref.update(metrics, (m) => ({ ...m, agent: params.agent, model: params.model })),
    noteStep: (params) =>
      Ref.update(metrics, (m) => {
        const step = Option.getOrElse(params.usage, () => ({ inputTokens: 0, outputTokens: 0 }))
        const inputTokens = m.inputTokens + step.inputTokens
        const outputTokens = m.outputTokens + step.outputTokens
        return {
          agent: params.agent,
          model: params.model,
          inputTokens,
          outputTokens,
          toolCallCount: m.toolCallCount + params.toolCallCount,
          steps: m.steps + 1,
          usageKnown:
            m.usageKnown &&
            Option.isSome(params.usage) &&
            reportable(step.inputTokens) &&
            reportable(step.outputTokens) &&
            reportable(inputTokens) &&
            reportable(outputTokens),
        }
      }),
    total: Ref.get(metrics),
  }
})
