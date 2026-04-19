/**
 * Memory extension projections.
 *
 * Two surfaces:
 *
 *   1. `MemoryVaultProjection` (this module's exported contribution) —
 *      a `ProjectionContribution` that queries `MemoryVault` directly
 *      from disk for both:
 *        - prompt: vault entries grouped by scope (project/global)
 *        - ui:     counts + summaries
 *      No actor, no mirror. `derive-do-not-create-states`: disk is truth.
 *
 *   2. Session-memory helpers (`projectSessionMemoryTurn`,
 *      `projectSessionMemorySnapshot`) — used by the still-actor-based
 *      session memory state to build its own `turn`/`snapshot` projection.
 *      Session memories are volatile and genuinely live in the actor.
 */

import { Effect, Schema } from "effect"
import {
  type ProjectionContribution,
  ProjectionError,
  type PromptSection,
  type ReadOnly,
} from "@gent/core/extensions/api"
import {
  MemoryVaultReadOnly,
  projectDisplayName,
  projectKey as projectKeyOf,
  type MemoryEntry,
} from "./vault.js"

const MAX_PROMPT_ENTRIES = 8
const RECALL_HINT = "Use memory_recall to read full memory details or search for specific topics."

// ── Vault projection (from disk) ──

const buildVaultPromptSection = (
  entries: ReadonlyArray<MemoryEntry>,
  projectKey: string | undefined,
): PromptSection | undefined => {
  const lines: string[] = []

  if (projectKey !== undefined) {
    const projectEntries = entries.filter((e) => e.path.startsWith(`project/${projectKey}/`))
    if (projectEntries.length > 0) {
      lines.push(`### Project: ${projectDisplayName(projectKey)}`)
      const budget = MAX_PROMPT_ENTRIES - lines.length
      for (const e of projectEntries.slice(0, Math.max(2, budget))) {
        lines.push(`- **${e.title}** — ${e.summary}`)
      }
    }
  }

  const globalEntries = entries.filter((e) => e.path.startsWith("global/"))
  if (globalEntries.length > 0) {
    const budget = MAX_PROMPT_ENTRIES - lines.length
    if (budget > 0) {
      lines.push("### Global")
      for (const e of globalEntries.slice(0, budget)) {
        lines.push(`- **${e.title}** — ${e.summary}`)
      }
    }
  }

  if (lines.length === 0) return undefined

  return {
    id: "memory-vault",
    content: `## Memory\n\n${lines.join("\n")}\n\n${RECALL_HINT}`,
    priority: 50,
  }
}

/** UI snapshot model for the vault portion (counts + summaries). */
export const MemoryVaultUiModel = Schema.Struct({
  vaultCount: Schema.Number,
  projectKey: Schema.optional(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      scope: Schema.Literals(["project", "global"]),
      summary: Schema.String,
    }),
  ),
})
export type MemoryVaultUiModel = typeof MemoryVaultUiModel.Type

interface VaultProjectionValue {
  readonly entries: ReadonlyArray<MemoryEntry>
  readonly projectKey: string | undefined
}

/**
 * Reads the on-disk vault index per evaluation, derives prompt + ui from it.
 * `query` yields `MemoryVaultReadOnly`, the branded read-only Tag — the
 * `ProjectionContribution<A, R extends ReadOnlyTag>` fence blocks
 * `ensureDirs` / `write` / `remove` / `rebuildIndex` access at the type
 * level (B11.4).
 *
 * Performance: scopes the disk walk to the relevant slice (global + the
 * derived project key only) rather than scanning every project under
 * `~/.gent/memory/project/`. Cheap O(N) where N = entries in the active
 * session's project + global, not all projects across the user's history.
 */
export const MemoryVaultProjection: ProjectionContribution<
  VaultProjectionValue,
  ReadOnly<MemoryVaultReadOnly>
> = {
  id: "memory-vault",
  query: (ctx) =>
    Effect.gen(function* () {
      const vault = yield* MemoryVaultReadOnly
      const key = ctx.cwd !== undefined ? projectKeyOf(ctx.cwd) : undefined
      const failed = (e: unknown): ProjectionError =>
        new ProjectionError({
          projectionId: "memory-vault",
          reason: `MemoryVault.list failed: ${String(e)}`,
        })
      const globalEntries = yield* vault
        .list("global")
        .pipe(Effect.catchEager((e) => Effect.fail(failed(e))))
      const projectEntries =
        key !== undefined
          ? yield* vault.list("project", key).pipe(Effect.catchEager((e) => Effect.fail(failed(e))))
          : []
      return { entries: [...globalEntries, ...projectEntries], projectKey: key }
    }),
  prompt: (value) => {
    const section = buildVaultPromptSection(value.entries, value.projectKey)
    return section !== undefined ? [section] : []
  },
}
