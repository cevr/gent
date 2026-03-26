import { Effect, Schema } from "effect"
import { AgentName, SubagentRunnerService } from "../domain/agent.js"
import { type EventEnvelope } from "../domain/event.js"
import { RuntimePlatform } from "../runtime/runtime-platform.js"
import { Storage } from "../storage/sqlite-storage.js"
import { defineTool, type ToolContext } from "../domain/tool.js"
import { runLoop } from "../runtime/loop.js"
import { extractLoopEvaluation } from "../runtime/workflow-helpers.js"

const LoopBody = Schema.Struct({
  agent: AgentName,
  prompt: Schema.String.annotate({ description: "Prompt for the body agent each iteration" }),
})

const LoopEvaluator = Schema.Struct({
  agent: AgentName,
  prompt: Schema.String.annotate({
    description:
      "Evaluator prompt. {output} is replaced with body output. " +
      "Agent must call the loop_evaluation tool with its verdict.",
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
 * Signal tool for loop evaluation. Injected into the evaluator subagent's
 * tool set via additionalTools override. The evaluator agent calls this tool
 * to indicate whether the loop should continue or stop.
 */
export const LoopEvaluationTool = defineTool({
  name: "loop_evaluation",
  action: "state",
  concurrency: "serial",
  description:
    "Report your evaluation verdict. Call with verdict 'done' when the objective is met " +
    "or 'continue' when more iterations are needed. You MUST call this tool.",
  params: Schema.Struct({
    verdict: Schema.Literals(["continue", "done"]).annotate({
      description: "Whether to continue iterating or stop",
    }),
    summary: Schema.String.annotate({
      description: "Brief summary of why this verdict was chosen",
    }),
  }),
  execute: (params) => Effect.succeed(params),
})

export const LoopTool = defineTool({
  name: "loop",
  action: "delegate" as const,
  concurrency: "serial" as const,
  description:
    "Iterate: run body agent, evaluate condition, repeat until done or max iterations. " +
    "The evaluator agent calls the loop_evaluation tool to report its verdict.",
  params: LoopParams,
  execute: Effect.fn("LoopTool.execute")(function* (params, ctx: ToolContext) {
    const runner = yield* SubagentRunnerService
    const storage = yield* Storage
    const platform = yield* RuntimePlatform
    const maxIterations = params.maxIterations ?? 5

    const result = yield* runLoop({
      maxIterations,

      body: (iteration, previousOutput, evaluatorFeedback) => {
        const prompt =
          iteration === 1
            ? params.body.prompt
            : [
                params.body.prompt,
                "## Previous Output",
                previousOutput,
                ...(evaluatorFeedback !== undefined && evaluatorFeedback !== ""
                  ? ["## Evaluator Feedback", evaluatorFeedback]
                  : []),
              ].join("\n\n")

        return runner.run({
          agent: { name: params.body.agent } as Parameters<typeof runner.run>[0]["agent"],
          prompt,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: platform.cwd,
        })
      },

      evaluate: Effect.fn("LoopTool.evaluate")(function* (_iteration, bodyOutput) {
        const prompt = params.evaluator.prompt.replace(/\{output\}/g, bodyOutput)

        const evalResult = yield* runner.run({
          agent: { name: params.evaluator.agent } as Parameters<typeof runner.run>[0]["agent"],
          prompt,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: platform.cwd,
          overrides: {
            tags: ["loop-evaluation"],
          },
        })

        if (evalResult._tag === "error") return { verdict: "done" as const }

        const envelopes = yield* storage
          .listEvents({ sessionId: evalResult.sessionId })
          .pipe(Effect.catchEager(() => Effect.succeed([] as ReadonlyArray<EventEnvelope>)))

        return extractLoopEvaluation(envelopes, evalResult.text)
      }),
    })

    return {
      iterations: result.iterations,
      reason: result.reason,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }),
})
