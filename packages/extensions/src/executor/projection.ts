/**
 * Executor extension prompt projection.
 *
 * Replaces the actor-era `turn.project` path that was deleted in C2 — the
 * workflow no longer projects prompt/policy directly. The projection reads
 * the executor's current state via the typed `ExecutorProtocol.GetSnapshot`
 * reply (executed through `MachineExecute`) and returns:
 *   - executor-guidance prompt section (only when Ready and instructions present)
 *   - tool policy excluding `execute`/`resume` until Ready
 *
 * Read-only: reaches the workflow through `MachineExecute` — the read-only
 * call surface for projections. Writes (send/publish) live behind the
 * ResourceHost-internal `MachineEngine` and are unreachable from here.
 */

import { Effect } from "effect"
import {
  type ProjectionContribution,
  type ProjectionContext,
  ProjectionError,
  type PromptSection,
} from "@gent/core/extensions/api"
import { MachineExecute } from "../builtin-internal.js"
import { ExecutorProtocol, type ExecutorSnapshotReply } from "./protocol.js"

const PROJECTION_ID = "executor-state"

const buildExecutorPrompt = (instructions: string): string =>
  [
    "## Executor Runtime",
    "",
    "You have access to the `execute` tool which runs TypeScript in a sandboxed runtime with configured API tools.",
    "",
    "### Executor Instructions",
    instructions,
    "",
    "### Usage Tips",
    "- Use `tools.search({ query })` inside execute to discover available API tools.",
    "- Use `tools.describe.tool({ path })` to get TypeScript shapes before calling.",
    "- If execution pauses for approval, use the `resume` tool with the returned executionId.",
  ].join("\n")

const buildPromptSection = (snapshot: ExecutorSnapshotReply): PromptSection | undefined => {
  if (snapshot.status !== "ready") return undefined
  if (snapshot.executorPrompt === undefined || snapshot.executorPrompt.length === 0)
    return undefined
  return {
    id: "executor-guidance",
    content: buildExecutorPrompt(snapshot.executorPrompt),
    priority: 85,
  }
}

export const ExecutorProjection: ProjectionContribution<ExecutorSnapshotReply, MachineExecute> = {
  id: PROJECTION_ID,
  query: (ctx: ProjectionContext) =>
    Effect.gen(function* () {
      const machine = yield* MachineExecute
      const snapshot = yield* machine
        .execute(ctx.sessionId, ExecutorProtocol.GetSnapshot.make(), ctx.branchId)
        .pipe(
          Effect.catchEager((error) =>
            Effect.fail(
              new ProjectionError({
                projectionId: PROJECTION_ID,
                reason: `executor.GetSnapshot execute failed: ${String(error)}`,
              }),
            ),
          ),
        )
      return snapshot
    }),
  prompt: (snapshot) => {
    const section = buildPromptSection(snapshot)
    return section !== undefined ? [section] : []
  },
  policy: (snapshot) => (snapshot.status === "ready" ? {} : { exclude: ["execute", "resume"] }),
}
