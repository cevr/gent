/**
 * Shared helpers — used by plan, review, and audit tools.
 */

import { Effect, Schema } from "effect"
import type { ModelId } from "../domain/model.js"
import { SubagentError } from "../domain/agent.js"
import type { AgentDefinition, SubagentResult, SubagentRunner } from "../domain/agent.js"
import type { BranchId, SessionId, ToolCallId } from "../domain/ids.js"
import { RuntimePlatform } from "./runtime-platform.js"

// ── Shell Command Runner ──

class CommandError extends Schema.TaggedErrorClass<CommandError>()("CommandError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Run a shell command, returning stdout. Returns empty string on failure. */
export const runCommand = (cmd: string[]): Effect.Effect<string, never, RuntimePlatform> =>
  Effect.gen(function* () {
    const platform = yield* RuntimePlatform
    return yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(cmd, {
          cwd: platform.cwd,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (exitCode !== 0) {
          throw new CommandError({ message: stderr || `Command failed: ${cmd.join(" ")}` })
        }
        return stdout
      },
      catch: (e) => new CommandError({ message: String(e), cause: e }),
    }).pipe(Effect.orElseSucceed(() => ""))
  })

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
