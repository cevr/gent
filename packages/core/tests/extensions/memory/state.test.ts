import { describe, test, expect } from "bun:test"
import {
  initialMemoryState,
  addSessionMemory,
  removeSessionMemory,
  updateVaultIndex,
  setProjectKey,
  toSlug,
  memoryPath,
  newFrontmatter,
  type SessionMemory,
} from "@gent/extensions/memory/state"
import type { MemoryEntry } from "@gent/extensions/memory/vault"

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

const makeSessionMemory = (title: string): SessionMemory => ({
  title,
  content: `Content for ${title}`,
  tags: ["test"],
  created: "2026-01-01T00:00:00Z",
})

describe("MemoryState", () => {
  test("initial state is empty", () => {
    expect(initialMemoryState.sessionMemories).toEqual([])
    expect(initialMemoryState.vaultIndex).toEqual([])
    expect(initialMemoryState.projectKey).toBeUndefined()
  })

  test("addSessionMemory appends", () => {
    const m = makeSessionMemory("first")
    const s1 = addSessionMemory(initialMemoryState, m)
    expect(s1.sessionMemories.length).toBe(1)
    expect(s1.sessionMemories[0]!.title).toBe("first")

    const s2 = addSessionMemory(s1, makeSessionMemory("second"))
    expect(s2.sessionMemories.length).toBe(2)
  })

  test("removeSessionMemory filters by title", () => {
    let state = addSessionMemory(initialMemoryState, makeSessionMemory("keep"))
    state = addSessionMemory(state, makeSessionMemory("remove"))
    state = removeSessionMemory(state, "remove")
    expect(state.sessionMemories.length).toBe(1)
    expect(state.sessionMemories[0]!.title).toBe("keep")
  })

  test("updateVaultIndex replaces index", () => {
    const entries = [makeEntry("global/a.md", "A", "global")]
    const state = updateVaultIndex(initialMemoryState, entries)
    expect(state.vaultIndex.length).toBe(1)
    expect(state.vaultIndex[0]!.title).toBe("A")
  })

  test("setProjectKey sets key", () => {
    const state = setProjectKey(initialMemoryState, "gent-abc123")
    expect(state.projectKey).toBe("gent-abc123")
  })
})

describe("toSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(toSlug("My Cool Topic")).toBe("my-cool-topic")
  })

  test("strips special chars", () => {
    expect(toSlug("API Design (v2)")).toBe("api-design-v2")
  })

  test("truncates at 60 chars", () => {
    const long = "a".repeat(100)
    expect(toSlug(long).length).toBeLessThanOrEqual(60)
  })
})

describe("memoryPath", () => {
  test("global scope", () => {
    expect(memoryPath("global", "My Topic")).toBe("global/my-topic.md")
  })

  test("project scope with key", () => {
    expect(memoryPath("project", "My Topic", "gent-abc123")).toBe("project/gent-abc123/my-topic.md")
  })

  test("project scope without key falls back to global", () => {
    expect(memoryPath("project", "My Topic")).toBe("global/my-topic.md")
  })
})

describe("newFrontmatter", () => {
  test("creates frontmatter with timestamps", () => {
    const fm = newFrontmatter("global", ["test"], "agent")
    expect(fm.scope).toBe("global")
    expect(fm.tags).toEqual(["test"])
    expect(fm.source).toBe("agent")
    expect(fm.created).toBeDefined()
    expect(fm.updated).toBeDefined()
  })
})
