import { Effect, Schema } from "effect"
import { AgentName, SubagentRunnerService } from "../domain/agent.js"
import {
  EventStore,
  WorkflowPhaseStarted,
  WorkflowCompleted,
  type EventEnvelope,
} from "../domain/event.js"
import { Storage } from "../storage/sqlite-storage.js"
import { defineTool } from "../domain/tool.js"
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

/**
 * Extract verdict from evaluator subagent events.
 * Searches for loop_evaluation tool call, falls back to text parsing.
 */
const extractVerdictFromEvents = (
  envelopes: ReadonlyArray<EventEnvelope>,
  resultText: string,
): LoopVerdict => {
  // Primary: search for a successfully completed loop_evaluation tool call
  const succeededCallIds = new Set<string>()
  for (const envelope of envelopes) {
    if (
      (envelope.event._tag === "ToolCallSucceeded" ||
        envelope.event._tag === "ToolCallCompleted") &&
      envelope.event.toolName === "loop_evaluation"
    ) {
      succeededCallIds.add(envelope.event.toolCallId)
    }
  }
  // Only trust input from tool calls that completed successfully
  for (const envelope of envelopes) {
    if (
      envelope.event._tag === "ToolCallStarted" &&
      envelope.event.toolName === "loop_evaluation" &&
      envelope.event.input !== undefined &&
      succeededCallIds.has(envelope.event.toolCallId)
    ) {
      const input = envelope.event.input as Record<string, unknown>
      if (input["verdict"] === "done") return "done"
      if (input["verdict"] === "continue") return "continue"
    }
  }

  // Fallback: check text for verdict lines
  for (const line of resultText.split("\n")) {
    const trimmed = line.trim().toLowerCase()
    if (trimmed === "verdict: done" || trimmed === "verdict:done") return "done"
    if (trimmed === "verdict: continue" || trimmed === "verdict:continue") return "continue"
  }

  return "continue"
}

export const LoopTool = defineWorkflow({
  name: "loop",
  description:
    "Iterate: run body agent, evaluate condition, repeat until done or max iterations. " +
    "The evaluator agent calls the loop_evaluation tool to report its verdict.",
  command: "loop",
  phases: ["body", "evaluate"] as const,
  params: LoopParams,
  execute: Effect.fn("LoopTool.execute")(function* (params, ctx: WorkflowContext) {
    const runner = yield* SubagentRunnerService
    const eventStore = yield* EventStore
    const storage = yield* Storage
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

      evaluate: Effect.fn("LoopTool.evaluate")(function* (_iteration, bodyOutput) {
        const prompt = params.evaluator.prompt.replace(/\{output\}/g, bodyOutput)

        const evalResult = yield* runner.run({
          agent: { name: params.evaluator.agent } as Parameters<typeof runner.run>[0]["agent"],
          prompt,
          parentSessionId: ctx.sessionId,
          parentBranchId: ctx.branchId,
          toolCallId: ctx.toolCallId,
          cwd: process.cwd(),
          overrides: {
            additionalTools: [LoopEvaluationTool],
          },
        })

        if (evalResult._tag === "error") return "done" as LoopVerdict

        const envelopes = yield* storage
          .listEvents({ sessionId: evalResult.sessionId })
          .pipe(Effect.catchEager(() => Effect.succeed([] as ReadonlyArray<EventEnvelope>)))

        return extractVerdictFromEvents(envelopes, evalResult.text)
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
