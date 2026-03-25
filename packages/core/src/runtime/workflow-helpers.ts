/**
 * Shared workflow helpers — used by plan, review, and audit workflows.
 */

import { Effect, Schema } from "effect"
import type { ModelId } from "../domain/model.js"
import { SubagentError } from "../domain/agent.js"
import type { AgentDefinition, SubagentResult, SubagentRunner } from "../domain/agent.js"
import { EventStore, WorkflowPhaseStarted, type EventEnvelope } from "../domain/event.js"
import type { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import type { LoopVerdict } from "../runtime/loop.js"

type LoopExitReason = "done" | "error" | "max_reached"
type WorkflowResult = "success" | "rejected" | "error" | "max_iterations"

// ── Shell Command Runner ──

/** Run a shell command, returning stdout. Returns empty string on failure. */
export const runCommand = (cmd: string[]): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const proc = Bun.spawn(cmd, {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(stderr || `Command failed: ${cmd.join(" ")}`)
    }
    return stdout
  }).pipe(Effect.orElseSucceed(() => ""))

// ── Adversarial Pair Runner ──

export interface WorkflowRunContext {
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
}

/** Spawn same prompt with both models in parallel */
export const runAdversarialPair = (
  runner: SubagentRunner,
  agent: AgentDefinition,
  prompt: string,
  modelA: ModelId,
  modelB: ModelId,
  ctx: WorkflowRunContext,
): Effect.Effect<readonly [SubagentResult, SubagentResult], SubagentError> =>
  Effect.all(
    [
      runner.run({ agent, prompt, ...ctx, overrides: { modelId: modelA } }),
      runner.run({ agent, prompt, ...ctx, overrides: { modelId: modelB } }),
    ] as const,
    { concurrency: 2 },
  )

// ── Verdict Extraction ──

export interface ExtractedLoopEvaluation {
  readonly verdict: LoopVerdict
  readonly feedback?: string
}

/**
 * Extract loop evaluation from subagent events.
 * Trusts only a successfully completed loop_evaluation tool call.
 */
export const extractLoopEvaluation = (
  envelopes: ReadonlyArray<EventEnvelope>,
  _resultText: string,
): ExtractedLoopEvaluation => {
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
      if (input["verdict"] === "done" || input["verdict"] === "continue") {
        return {
          verdict: input["verdict"],
          feedback: typeof input["summary"] === "string" ? input["summary"] : undefined,
        }
      }
    }
  }

  return { verdict: "continue" }
}

export const extractLoopVerdict = (
  envelopes: ReadonlyArray<EventEnvelope>,
  resultText: string,
): LoopVerdict => extractLoopEvaluation(envelopes, resultText).verdict

export const workflowResultFromLoopReason = (reason: LoopExitReason): WorkflowResult => {
  if (reason === "done") return "success"
  if (reason === "error") return "error"
  return "max_iterations"
}

// ── Phase Emitter ──

/** Emit a workflow phase event, swallowing errors */
export const emitPhase = (
  workflowName: string,
  sessionId: SessionId,
  branchId: BranchId,
  phase: string,
  iteration?: number,
  maxIterations?: number,
): Effect.Effect<void, never, EventStore> =>
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    yield* eventStore
      .publish(
        new WorkflowPhaseStarted({
          sessionId,
          branchId,
          workflowName,
          phase,
          ...(iteration !== undefined ? { iteration, maxIterations } : {}),
        }),
      )
      .pipe(Effect.catchEager(() => Effect.void))
  })

// ── Require Text ──

/** Extract text from SubagentResult or fail with descriptive error */
export const requireText = (
  result: SubagentResult,
  label: string,
): Effect.Effect<string, SubagentError> => {
  if (result._tag === "error") {
    return Effect.fail(
      new SubagentError({
        message: `${label} failed: ${result.error}`,
      }),
    )
  }
  return Effect.succeed(result.text)
}

// ── Batch Schema ──

export const BatchFinding = Schema.Struct({
  file: Schema.String,
  description: Schema.String,
  severity: Schema.Literals(["critical", "warning", "suggestion"]),
})
export type BatchFinding = typeof BatchFinding.Type

export const ExecutionBatch = Schema.Struct({
  title: Schema.String,
  files: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.String),
  findings: Schema.Array(BatchFinding),
})
export type ExecutionBatch = typeof ExecutionBatch.Type

export const BatchedPlan = Schema.Array(ExecutionBatch)
export type BatchedPlan = typeof BatchedPlan.Type

/** Parse batched plan from JSON string, returning empty array on failure */
export const parseBatchedPlan = (text: string): Effect.Effect<BatchedPlan> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(BatchedPlan))(text).pipe(
    Effect.catchEager(() => Effect.succeed([])),
  )
