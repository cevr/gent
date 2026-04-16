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
  type TurnProjection,
} from "@gent/core/extensions/api"
import {
  MemoryVault,
  projectDisplayName,
  projectKey as projectKeyOf,
  type MemoryEntry,
} from "./vault.js"
import type { MemoryState } from "./state.js"

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
 * `query` is read-only (lint-enforced).
 */
export const MemoryVaultProjection: ProjectionContribution<VaultProjectionValue, MemoryVault> = {
  id: "memory-vault",
  query: (ctx) =>
    Effect.gen(function* () {
      const vault = yield* MemoryVault
      yield* vault.ensureDirs()
      const entries = yield* vault.list().pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new ProjectionError({
              projectionId: "memory-vault",
              reason: `MemoryVault.list failed: ${String(e)}`,
            }),
          ),
        ),
      )
      const key = ctx.cwd !== undefined ? projectKeyOf(ctx.cwd) : undefined
      return { entries, projectKey: key }
    }),
  prompt: (value) => {
    const section = buildVaultPromptSection(value.entries, value.projectKey)
    return section !== undefined ? [section] : []
  },
  ui: {
    schema: MemoryVaultUiModel,
    project: (value) => ({
      vaultCount: value.entries.length,
      ...(value.projectKey !== undefined ? { projectKey: value.projectKey } : {}),
      entries: value.entries.slice(0, 5).map((e) => ({
        title: e.title,
        scope: e.frontmatter.scope,
        summary: e.summary,
      })),
    }),
  },
}

// ── Session-memory projection helpers (consumed by the actor's turn/snapshot) ──

const buildSessionPromptSection = (state: MemoryState): PromptSection | undefined => {
  if (state.sessionMemories.length === 0) return undefined
  const lines: string[] = ["### Session"]
  for (const m of state.sessionMemories.slice(0, 3)) {
    lines.push(`- **${m.title}** — ${m.content.slice(0, 80)}`)
  }
  return {
    id: "memory-session",
    content: `## Session Memory\n\n${lines.join("\n")}\n\n${RECALL_HINT}`,
    priority: 51,
  }
}

/**
 * UI snapshot model for the session-memory portion of the actor.
 * The vault portion has its own projection-emitted snapshot (`memory-vault`).
 */
export const MemorySessionUiModel = Schema.Struct({
  sessionCount: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      summary: Schema.String,
    }),
  ),
})
export type MemorySessionUiModel = typeof MemorySessionUiModel.Type

export const projectSessionMemorySnapshot = (state: MemoryState): MemorySessionUiModel => ({
  sessionCount: state.sessionMemories.length,
  entries: state.sessionMemories.slice(0, 5).map((m) => ({
    title: m.title,
    summary: m.content.slice(0, 80),
  })),
})

export const projectSessionMemoryTurn = (state: MemoryState): TurnProjection => {
  const section = buildSessionPromptSection(state)
  return { promptSections: section !== undefined ? [section] : [] }
}
