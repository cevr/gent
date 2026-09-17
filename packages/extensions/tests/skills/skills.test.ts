import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import { Skill, formatSkillsForPrompt, parseSkillFile } from "../../src/skills/skills.js"

const makeSkill = (name: string, level: "local" | "global", description = `${name} skill`) =>
  new Skill({
    name,
    description,
    filePath: `/test/${level}/${name}.md`,
    content: `Content for ${name}`,
    level,
  })

describe("formatSkillsForPrompt", () => {
  test("empty array returns empty string", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })

  test("groups by level", () => {
    const skills = [makeSkill("bun", "local"), makeSkill("react", "global")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("## Local")
    expect(result).toContain("## Global")
    expect(result).toContain("**bun**")
    expect(result).toContain("**react**")
  })

  test("omits empty level sections", () => {
    const skills = [makeSkill("bun", "local")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("## Local")
    expect(result).not.toContain("## Global")
  })

  test("includes usage instructions", () => {
    const skills = [makeSkill("bun", "local")]
    const result = formatSkillsForPrompt(skills)
    expect(result).toContain("read tool")
    expect(result).toContain('File: "/test/local/bun.md"')
    expect(result).toContain("$bun:local")
    expect(result).toContain("$skill:local")
  })
})

describe("parseSkillFile", () => {
  test("parses YAML frontmatter", () => {
    const content = `---
name: effect-v4
description: Effect v4 patterns
---

Content here`
    const result = parseSkillFile(content, "effect-v4.md")
    expect(result).toEqual(
      Option.some({
        name: "effect-v4",
        description: "Effect v4 patterns",
        content: "Content here",
      }),
    )
  })

  test("falls back to filename for name", () => {
    const result = parseSkillFile("# My Skill\n\nSome content", "my-skill.md")
    expect(Option.getOrThrow(result).name).toBe("my-skill")
  })

  test("extracts description from first paragraph", () => {
    const result = parseSkillFile("# Title\nShort description\n\nMore content", "test.md")
    expect(Option.getOrThrow(result).description).toBe("Short description")
  })
})
