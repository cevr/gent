import { describe, test, expect } from "bun:test"
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "@gent/server"

describe("buildSystemPrompt", () => {
  const base = {
    cwd: "/home/user/project",
    platform: "linux",
    isGitRepo: true,
  }

  test("includes default system prompt", () => {
    const result = buildSystemPrompt(base)
    expect(result).toContain(DEFAULT_SYSTEM_PROMPT)
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
    // formatSkillsForPrompt returns "" for empty array
    const withoutSkills = buildSystemPrompt(base)
    expect(result).toBe(withoutSkills)
  })

  test("includes date in ISO format", () => {
    const result = buildSystemPrompt(base)
    // Date format: YYYY-MM-DD
    expect(result).toMatch(/Date: \d{4}-\d{2}-\d{2}/)
  })
})
