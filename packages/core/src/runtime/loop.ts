import { Effect } from "effect"
import type { SubagentError, SubagentResult } from "../domain/agent"

// Loop Runner — iterative subagent execution with evaluator-based condition

export type LoopVerdict = "continue" | "done"

export interface LoopResult {
  readonly iterations: number
  readonly output: string
  readonly reason: "done" | "max_reached" | "error"
  readonly error?: string
}

/**
 * Run an iterative loop: body → evaluate → repeat.
 *
 * - body: runs each iteration, receives previous output
 * - evaluate: determines whether to continue or stop
 * - onIteration: optional callback for phase events
 *
 * The evaluator should use a signal tool or structured output to indicate
 * the verdict. Text parsing is avoided to prevent false positives from
 * LLM negations (e.g., "I should NOT stop").
 */
export const runLoop = Effect.fn("runLoop")(function* (params: {
  body: (iteration: number, previousOutput: string) => Effect.Effect<SubagentResult, SubagentError>
  evaluate: (iteration: number, bodyOutput: string) => Effect.Effect<LoopVerdict, SubagentError>
  maxIterations: number
  onIteration?: (
    iteration: number,
    phase: "body" | "evaluate",
  ) => Effect.Effect<void, SubagentError>
}): Generator<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  LoopResult,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
> {
  let output = ""

  for (let i = 1; i <= params.maxIterations; i++) {
    if (params.onIteration !== undefined) {
      yield* params.onIteration(i, "body")
    }

    const bodyResult = yield* params.body(i, output)
    if (bodyResult._tag === "error") {
      return { iterations: i, output, reason: "error" as const, error: bodyResult.error }
    }
    output = bodyResult.text

    if (params.onIteration !== undefined) {
      yield* params.onIteration(i, "evaluate")
    }

    const verdict: LoopVerdict = yield* params.evaluate(i, output)
    if (verdict === "done") {
      return { iterations: i, output, reason: "done" as const }
    }
  }

  return { iterations: params.maxIterations, output, reason: "max_reached" as const }
})
