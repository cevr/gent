/**
 * Shared helpers — used by plan, review, and audit tools.
 */

import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { AgentRunError, runProcess, type AgentRunResult } from "@gent/core/extensions/api"

// ── Shell Command Runner ──

/** Run a shell command in a given cwd, returning stdout. Returns empty string on failure. */
export const runCommand = (cmd: string[], cwd: string): Effect.Effect<string> => {
  const [head, ...rest] = cmd
  if (head === undefined) return Effect.succeed("")
  return runProcess(head, rest, { cwd, stdout: "pipe", stderr: "pipe" }).pipe(
    Effect.flatMap((r) => Effect.succeed(r.exitCode === 0 ? r.stdout : "")),
    Effect.catchTag("ProcessError", () => Effect.succeed("")),
    Effect.provide(BunServices.layer),
  )
}

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
