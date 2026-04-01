/**
 * Memory extension projection — prompt injection + UI model.
 *
 * deriveTurn: injects compact memory summary as prompt section.
 * deriveUi: exposes memory counts + top entries for TUI.
 */

import type { ExtensionDeriveContext, ExtensionProjection } from "../../domain/extension.js"
import type { PromptSection } from "../../domain/prompt.js"
import type { MemoryState } from "./state.js"
import { projectDisplayName } from "./vault.js"

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

// ── Derive ──

export const deriveProjection = (
  state: MemoryState,
  _ctx?: ExtensionDeriveContext,
): ExtensionProjection => {
  const section = buildMemorySection(state)
  const uiModel = {
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
  }

  return {
    promptSections: section !== undefined ? [section] : [],
    uiModel,
  }
}
