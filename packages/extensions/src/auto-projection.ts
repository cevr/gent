/**
 * Auto extension prompt projection.
 *
 * Replaces the `WorkflowContribution.turn` prompt-projection path that was
 * deleted in C2 (UI-as-server-concern subtraction). The workflow still owns
 * the state machine; this projection reads its current snapshot via the
 * typed `AutoProtocol.GetSnapshot` reply (asked through `WorkflowRuntime`)
 * and turns it into a `PromptSection` for the system prompt.
 *
 * Read-only: only reaches the workflow through the request protocol's
 * read-shaped reply path. No service writes.
 */

import { Effect } from "effect"
import {
  type ProjectionContribution,
  type ProjectionContext,
  ProjectionError,
  type PromptSection,
  WorkflowRuntime,
} from "@gent/core/extensions/api"
import { AUTO_EXTENSION_ID, AutoProtocol, type AutoSnapshotReply } from "./auto-protocol.js"

const PROJECTION_ID = "auto-loop"

const buildPromptSection = (snapshot: AutoSnapshotReply): PromptSection | undefined => {
  if (!snapshot.active) return undefined

  if (snapshot.phase === "awaiting-review") {
    return {
      id: "auto-loop-context",
      content: [
        `## Auto Loop — Peer Review Required`,
        "",
        `Iteration ${snapshot.iteration ?? 0}/${snapshot.maxIterations ?? 0} is complete.`,
        "",
        "You MUST call the `review` tool to run an adversarial review of this iteration before continuing.",
        "The loop cannot proceed until the review is done.",
      ].join("\n"),
      priority: 91,
    }
  }

  // working
  const parts: string[] = [
    `## Auto Loop — Iteration ${snapshot.iteration ?? 0}/${snapshot.maxIterations ?? 0}`,
    "",
    `**Goal**: ${snapshot.goal ?? ""}`,
  ]

  if (snapshot.learnings !== undefined && snapshot.learnings.length > 0) {
    parts.push("", "### Accumulated Learnings:")
    for (const l of snapshot.learnings) {
      parts.push(`- [Iteration ${l.iteration}] ${l.content}`)
    }
  }

  if (snapshot.lastSummary !== undefined) {
    parts.push("", `### Last iteration summary:`, snapshot.lastSummary)
  }

  if (snapshot.nextIdea !== undefined) {
    parts.push("", `### Suggested next step:`, snapshot.nextIdea)
  }

  parts.push(
    "",
    "Maintain a findings doc at `.gent/auto/findings.md` — update it with wins, dead ends, and open questions.",
    "",
    "When you have completed this iteration's work, call `auto_checkpoint` with your results.",
    `This is iteration ${snapshot.iteration ?? 0} of ${snapshot.maxIterations ?? 0}.`,
  )

  return {
    id: "auto-loop-context",
    content: parts.join("\n"),
    priority: 91,
  }
}

export const AutoProjection: ProjectionContribution<AutoSnapshotReply, WorkflowRuntime> = {
  id: PROJECTION_ID,
  query: (ctx: ProjectionContext) =>
    Effect.gen(function* () {
      const runtime = yield* WorkflowRuntime
      const snapshot = yield* runtime
        .ask(ctx.sessionId, AutoProtocol.GetSnapshot(), ctx.branchId)
        .pipe(
          Effect.catchEager((error) =>
            Effect.fail(
              new ProjectionError({
                projectionId: PROJECTION_ID,
                reason: `auto.GetSnapshot ask failed: ${String(error)}`,
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
  policy: (snapshot) => (snapshot.active ? {} : { exclude: ["auto_checkpoint"] }),
}

export { AUTO_EXTENSION_ID }
