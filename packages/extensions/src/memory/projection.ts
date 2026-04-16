/**
 * Memory extension projections.
 */

import { type TurnProjection, type PromptSection } from "@gent/core/extensions/api"
import type { MemoryState } from "./state.js"
import { projectDisplayName } from "./vault.js"
import { Schema } from "effect"

const MAX_PROMPT_ENTRIES = 8
const RECALL_HINT = "Use memory_recall to read full memory details or search for specific topics."

const buildMemorySection = (state: MemoryState): PromptSection | undefined => {
  const lines: string[] = []

  // Session memories first
  if (state.sessionMemories.length > 0) {
    lines.push("### Session")
    for (const m of state.sessionMemories.slice(0, 3)) {
      lines.push(`- **${m.title}** — ${m.content.slice(0, 80)}`)
    }
  }

  // Project memories
  const projectKey = state.projectKey
  if (projectKey !== undefined) {
    const projectEntries = state.vaultIndex.filter((e) =>
      e.path.startsWith(`project/${projectKey}/`),
    )
    if (projectEntries.length > 0) {
      lines.push(`### Project: ${projectDisplayName(projectKey)}`)
      const budget = MAX_PROMPT_ENTRIES - lines.length
      for (const e of projectEntries.slice(0, Math.max(2, budget))) {
        lines.push(`- **${e.title}** — ${e.summary}`)
      }
    }
  }

  // Global memories (fill remaining budget)
  const globalEntries = state.vaultIndex.filter((e) => e.path.startsWith("global/"))
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
    id: "memory",
    content: `## Memory\n\n${lines.join("\n")}\n\n${RECALL_HINT}`,
    priority: 50,
  }
}

export const MemorySnapshot = Schema.Struct({
  sessionCount: Schema.Number,
  vaultCount: Schema.Number,
  entries: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      scope: Schema.Literals(["session", "project", "global"]),
      summary: Schema.String,
    }),
  ),
})
export type MemorySnapshot = typeof MemorySnapshot.Type

export const projectMemorySnapshot = (state: MemoryState): MemorySnapshot => ({
  sessionCount: state.sessionMemories.length,
  vaultCount: state.vaultIndex.length,
  entries: [
    ...state.sessionMemories.slice(0, 5).map((m) => ({
      title: m.title,
      scope: "session" as const,
      summary: m.content.slice(0, 80),
    })),
    ...state.vaultIndex.slice(0, 5).map((e) => ({
      title: e.title,
      scope: e.frontmatter.scope,
      summary: e.summary,
    })),
  ],
})

export const projectMemoryTurn = (state: MemoryState): TurnProjection => {
  const section = buildMemorySection(state)
  return {
    promptSections: section !== undefined ? [section] : [],
  }
}
