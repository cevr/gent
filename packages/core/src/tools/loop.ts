import { Effect, Schema } from "effect"
import { AgentName, SubagentRunnerService, type SubagentResult } from "../domain/agent.js"
import { EventStore, WorkflowPhaseStarted, WorkflowCompleted } from "../domain/event.js"
import { defineWorkflow, type WorkflowContext } from "../domain/workflow.js"
import { runLoop, type LoopVerdict } from "../runtime/loop.js"

const LoopBody = Schema.Struct({
  agent: AgentName,
  prompt: Schema.String.annotate({ description: "Prompt for the body agent each iteration" }),
})

const LoopEvaluator = Schema.Struct({
  agent: AgentName,
  prompt: Schema.String.annotate({
    description:
      "Evaluator prompt. {output} is replaced with body output. " +
      'Agent must respond with a verdict line: "VERDICT: done" or "VERDICT: continue".',
  }),
})

export const LoopParams = Schema.Struct({
  body: LoopBody,
  evaluator: LoopEvaluator,
  maxIterations: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 10 })).annotate({
      description: "Maximum iterations (default 5)",
    }),
  ),
})

/**
 * Parse the evaluator agent's verdict from its response.
 *
 * The evaluator prompt instructs the agent to respond with a clear verdict line:
 *   VERDICT: done
 *   VERDICT: continue
 *
 * This structured-line approach avoids false positives from LLM negations
 * (e.g., "I should NOT stop" containing "done" elsewhere in free text).
 */
const parseEvaluatorVerdict = (result: SubagentResult): LoopVerdict => {
  if (result._tag === "error") return "done"

  const lines = result.text.split("\n")
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase()
    if (trimmed === "verdict: done" || trimmed === "verdict:done") return "done"
    if (trimmed === "verdict: continue" || trimmed === "verdict:continue") return "continue"
  }

  // Fallback: if no explicit verdict line, default to done (conservative — avoid infinite loops)
  return "done"
}

export const LoopTool = defineWorkflow({
  name: "loop",
  description:
    "Iterate: run body agent, evaluate condition, repeat until done or max iterations. " +
    "The evaluator agent decides whether to continue or stop.",
  command: "loop",
  phases: ["body", "evaluate"] as const,
  params: LoopParams,
  execute: Effect.fn("LoopTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const maxIterations = params.maxIterations ?? 5

    const result = yield* runLoop({
      maxIterations,

      body: (iteration, previousOutput) => {
        const prompt =
          iteration === 1
            ? params.body.prompt
            : `${params.body.prompt}\n\n## Previous Output\n${previousOutput}`

        return runner.run({
          agent: { name: params.body.agent } as Parameters<typeof runner.run>[0]["agent"],
          prompt,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: process.cwd(),
        })
      },

      evaluate: Effect.fn("LoopTool.evaluate")(function* (iteration, bodyOutput) {
        const prompt = params.evaluator.prompt.replace(/\{output\}/g, bodyOutput)

        const evalResult = yield* runner.run({
          agent: { name: params.evaluator.agent } as Parameters<typeof runner.run>[0]["agent"],
          prompt,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: process.cwd(),
        })

        return parseEvaluatorVerdict(evalResult)
      }),

      onIteration: Effect.fn("LoopTool.onIteration")(function* (iteration, phase) {
        yield* eventStore
          .publish(
            new WorkflowPhaseStarted({
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              workflowName: "loop",
              phase,
              iteration,
              maxIterations,
            }),
          )
          .pipe(Effect.catchEager(() => Effect.void))
      }),
    })

    yield* eventStore
      .publish(
        new WorkflowCompleted({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          workflowName: "loop",
          result:
            result.reason === "done"
              ? "success"
              : result.reason === "error"
                ? "error"
                : "max_iterations",
        }),
      )
      .pipe(Effect.catchEager(() => Effect.void))

    return {
      iterations: result.iterations,
      reason: result.reason,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }),
})
