import { describe, test, expect } from "bun:test"
import { deriveProjection } from "@gent/core/extensions/memory/projection"
import {
  initialMemoryState,
  addSessionMemory,
  updateVaultIndex,
  setProjectKey,
} from "@gent/core/extensions/memory/state"
import type { MemoryEntry } from "@gent/core/extensions/memory/vault"
import { AgentDefinition } from "@gent/core/domain/agent"

const deriveCtx = {
  agent: new AgentDefinition({ name: "test" as never, kind: "primary" as const }),
  allTools: [],
}

const makeEntry = (path: string, title: string, scope: "global" | "project"): MemoryEntry => ({
  path,
  title,
  summary: `Summary of ${title}`,
  frontmatter: {
    scope,
    tags: [],
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    source: "agent",
  },
})

describe("memory projection", () => {
  test("empty state produces no prompt sections", () => {
    const result = deriveProjection(initialMemoryState, deriveCtx)
    expect(result.promptSections ?? []).toEqual([])
  })

  test("session memories appear in prompt", () => {
    let state = addSessionMemory(initialMemoryState, {
      title: "API Style",
      content: "Use snake_case for all API endpoints",
      tags: [],
      created: "2026-01-01T00:00:00Z",
    })
    const result = deriveProjection(state, deriveCtx)
    const sections = result.promptSections ?? []
    expect(sections.length).toBe(1)
    expect(sections[0]!.content).toContain("API Style")
    expect(sections[0]!.content).toContain("memory_recall")
  })

  test("vault entries appear in prompt", () => {
    const entries = [
      makeEntry("global/pattern-a.md", "Pattern A", "global"),
      makeEntry("global/pattern-b.md", "Pattern B", "global"),
    ]
    const state = updateVaultIndex(initialMemoryState, entries)
    const result = deriveProjection(state, deriveCtx)
    const sections = result.promptSections ?? []
    expect(sections.length).toBe(1)
    expect(sections[0]!.content).toContain("Pattern A")
    expect(sections[0]!.content).toContain("Pattern B")
  })

  test("project entries appear under project heading", () => {
    const entries = [makeEntry("project/gent-abc123/gotcha.md", "SQLite Gotcha", "project")]
    let state = updateVaultIndex(initialMemoryState, entries)
    state = setProjectKey(state, "gent-abc123")
    const result = deriveProjection(state, deriveCtx)
    const sections = result.promptSections ?? []
    expect(sections.length).toBe(1)
    expect(sections[0]!.content).toContain("Project:")
    expect(sections[0]!.content).toContain("SQLite Gotcha")
  })

  test("caps at MAX_PROMPT_ENTRIES", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`global/entry-${i}.md`, `Entry ${i}`, "global"),
    )
    const state = updateVaultIndex(initialMemoryState, entries)
    const result = deriveProjection(state, deriveCtx)
    const sections = result.promptSections ?? []
    expect(sections.length).toBe(1)
    // Count bullet points — should be capped
    const bullets = sections[0]!.content.split("\n").filter((l) => l.startsWith("- "))
    expect(bullets.length).toBeLessThanOrEqual(8)
  })

  test("deriveUi returns counts and entries", () => {
    let state = addSessionMemory(initialMemoryState, {
      title: "Session Note",
      content: "Quick note",
      tags: [],
      created: "2026-01-01T00:00:00Z",
    })
    state = updateVaultIndex(state, [makeEntry("global/g.md", "Global", "global")])
    const result = deriveProjection(state, deriveCtx)
    const ui = result.uiModel as { sessionCount: number; vaultCount: number; entries: unknown[] }
    expect(ui.sessionCount).toBe(1)
    expect(ui.vaultCount).toBe(1)
    expect(ui.entries.length).toBe(2)
  })
})
