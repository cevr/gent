import { describe, test, expect } from "bun:test"
import {
  buildSystemPrompt,
  buildBasePromptSections,
  compileSystemPrompt,
} from "@gent/core/server/system-prompt"

describe("buildSystemPrompt", () => {
  const base = {
    cwd: "/home/user/project",
    platform: "linux",
    isGitRepo: true,
  }

  test("includes character section", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("# Character")
    expect(result).toContain("Finish what you start")
  })

  test("includes identity", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("You are Gent, a coding assistant.")
  })

  test("includes environment section", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain("Working directory: /home/user/project")
    expect(result).toContain("Platform: linux")
    expect(result).toContain("Git repository: yes")
  })

  test("isGitRepo false → 'no'", () => {
    const result = buildSystemPrompt({ ...base, isGitRepo: false })
    expect(result).toContain("Git repository: no")
  })

  test("includes custom instructions when provided", () => {
    const result = buildSystemPrompt({
      ...base,
      customInstructions: "Always use TypeScript strict mode",
    })
    expect(result).toContain("# Project Instructions")
    expect(result).toContain("Always use TypeScript strict mode")
  })

  test("omits custom instructions when empty", () => {
    const result = buildSystemPrompt({ ...base, customInstructions: "" })
    expect(result).not.toContain("# Project Instructions")
  })

  test("omits custom instructions when undefined", () => {
    const result = buildSystemPrompt(base)
    expect(result).not.toContain("# Project Instructions")
  })

  test("includes skills when provided", () => {
    const result = buildSystemPrompt({
      ...base,
      skills: [{ name: "effect-v4", path: "/skills/effect-v4.md", content: "Effect patterns" }],
    })
    expect(result).toContain("effect-v4")
  })

  test("omits skills section when empty array", () => {
    const result = buildSystemPrompt({ ...base, skills: [] })
    const withoutSkills = buildSystemPrompt(base)
    expect(result).toBe(withoutSkills)
  })

  test("includes date in ISO format", () => {
    const result = buildSystemPrompt(base)
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
  })
})

describe("buildBasePromptSections", () => {
  const base = {
    cwd: "/test",
    platform: "darwin",
    isGitRepo: false,
  }

  test("returns ordered sections", () => {
    const sections = buildBasePromptSections(base)
    expect(sections.length).toBeGreaterThanOrEqual(6)
    const ids = sections.map((s) => s.id)
    expect(ids).toContain("identity")
    expect(ids).toContain("character")
    expect(ids).toContain("tools")
    expect(ids).toContain("environment")
  })

  test("compileSystemPrompt sorts by priority", () => {
    const result = compileSystemPrompt([
      { id: "b", content: "second", priority: 20 },
      { id: "a", content: "first", priority: 10 },
    ])
    expect(result).toBe("first\n\nsecond")
  })
})
