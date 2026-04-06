/**
 * Shared helpers — used by plan, review, and audit tools.
 */

import { Effect, Schema } from "effect"
import { AgentRunError } from "../domain/agent.js"
import type { AgentRunResult } from "../domain/agent.js"

// ── Shell Command Runner ──

class CommandError extends Schema.TaggedErrorClass<CommandError>()("CommandError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** Run a shell command in a given cwd, returning stdout. Returns empty string on failure. */
export const runCommand = (cmd: string[], cwd: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(cmd, {
        cwd,
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

// ── Require Text ──

/** Extract text from AgentRunResult or fail with descriptive error */
export const requireText = (
  result: AgentRunResult,
  label: string,
): Effect.Effect<string, AgentRunError> => {
  if (result._tag === "error") {
    return Effect.fail(
      new AgentRunError({
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
