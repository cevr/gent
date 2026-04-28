/**
 * Memory extension projections.
 *
 * Two surfaces:
 *
 *   1. `projectMemoryVaultTurn` — a turn projection reaction that queries
 *      `MemoryVault` directly from disk for prompt entries grouped by scope
 *      (project/global).
 *      No actor, no mirror. `derive-do-not-create-states`: disk is truth.
 *
 * Session memories were removed with the legacy state-holder; the vault is
 * the prompt source.
 */

import { Effect } from "effect"
import {
  ProjectionError,
  type ProjectionTurnContext,
  type PromptSection,
  type ReadOnly,
  type TurnProjection,
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

interface VaultProjectionValue {
  readonly entries: ReadonlyArray<MemoryEntry>
  readonly projectKey: string | undefined
}

/**
 * Reads the on-disk vault index per evaluation and derives prompt from it.
 * The reaction reads through `MemoryVaultReadOnly`, keeping `ensureDirs` /
 * `write` / `remove` / `rebuildIndex` out of the service surface.
 *
 * Performance: scopes the disk walk to the relevant slice (global + the
 * derived project key only) rather than scanning every project under
 * `~/.gent/memory/project/`. Cheap O(N) where N = entries in the active
 * session's project + global, not all projects across the user's history.
 */
const readVaultProjectionValue = (
  ctx: ProjectionTurnContext,
): Effect.Effect<VaultProjectionValue, ProjectionError, ReadOnly<MemoryVaultReadOnly>> =>
  Effect.gen(function* () {
    const vault = yield* MemoryVaultReadOnly
    const key = projectKeyOf(ctx.cwd)
    const failed = (e: unknown): ProjectionError =>
      new ProjectionError({
        projectionId: "memory-vault",
        reason: `MemoryVault.list failed: ${String(e)}`,
      })
    const globalEntries = yield* vault
      .list("global")
      .pipe(Effect.catchEager((e) => Effect.fail(failed(e))))
    const projectEntries = yield* vault
      .list("project", key)
      .pipe(Effect.catchEager((e) => Effect.fail(failed(e))))
    return { entries: [...globalEntries, ...projectEntries], projectKey: key }
  })

export const projectMemoryVaultTurn = (
  ctx: ProjectionTurnContext,
): Effect.Effect<TurnProjection, ProjectionError, ReadOnly<MemoryVaultReadOnly>> =>
  readVaultProjectionValue(ctx).pipe(
    Effect.map((value) => {
      const section = buildVaultPromptSection(value.entries, value.projectKey)
      return section !== undefined ? { promptSections: [section] } : {}
    }),
  )
