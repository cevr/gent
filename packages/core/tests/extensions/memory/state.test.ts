import { describe, test, expect } from "bun:test"
import { toSlug, memoryPath, newFrontmatter } from "@gent/extensions/memory/state"

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
