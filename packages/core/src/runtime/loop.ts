import { Effect } from "effect"
import type { SubagentError, SubagentResult } from "../domain/agent"

// Loop Runner — iterative subagent execution with evaluator-based condition

export type LoopVerdict = "continue" | "done"

/** Evaluator can return a plain verdict or verdict + feedback for next iteration */
export type EvaluateResult =
  | LoopVerdict
  | { readonly verdict: LoopVerdict; readonly feedback?: string }

const normalizeEvaluateResult = (
  result: EvaluateResult,
): { verdict: LoopVerdict; feedback?: string } =>
  typeof result === "string" ? { verdict: result } : result

export interface LoopResult {
  readonly iterations: number
  readonly output: string
  readonly reason: "done" | "max_reached" | "error"
  readonly error?: string
}

/**
 * Run an iterative loop: body → evaluate → repeat.
 *
 * - body: runs each iteration, receives previous output + optional evaluator feedback
 * - evaluate: determines whether to continue or stop, optionally with feedback
 * - onIteration: optional callback for phase events
 *
 * The evaluator should use a signal tool or structured output to indicate
 * the verdict. Text parsing is avoided to prevent false positives from
 * LLM negations (e.g., "I should NOT stop").
 */
export const runLoop = Effect.fn("runLoop")(function* (params: {
  body: (
    iteration: number,
    previousOutput: string,
    evaluatorFeedback?: string,
  ) => Effect.Effect<SubagentResult, SubagentError>
  evaluate: (iteration: number, bodyOutput: string) => Effect.Effect<EvaluateResult, SubagentError>
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
  let feedback: string | undefined

  for (let i = 1; i <= params.maxIterations; i++) {
    if (params.onIteration !== undefined) {
      yield* params.onIteration(i, "body")
    }

    const bodyResult = yield* params.body(i, output, feedback)
    if (bodyResult._tag === "error") {
      return { iterations: i, output, reason: "error" as const, error: bodyResult.error }
    }
    output = bodyResult.text

    if (params.onIteration !== undefined) {
      yield* params.onIteration(i, "evaluate")
    }

    const evalResult = normalizeEvaluateResult(yield* params.evaluate(i, output))
    feedback = evalResult.feedback
    if (evalResult.verdict === "done") {
      return { iterations: i, output, reason: "done" as const }
    }
  }

  return { iterations: params.maxIterations, output, reason: "max_reached" as const }
})
