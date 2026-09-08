import { describe, test, expect } from "bun:test"
import { Option } from "effect"
import {
  Skill,
  resolveSkillName,
  formatSkillsForPrompt,
  parseSkillFile,
} from "../../src/skills/skills.js"

const makeSkill = (name: string, level: "local" | "global", description = `${name} skill`) =>
  new Skill({
    name,
    description,
    filePath: `/test/${level}/${name}.md`,
    content: `Content for ${name}`,
    level,
  })

describe("resolveSkillName", () => {
  const skills = [
    makeSkill("effect-v4", "local"),
    makeSkill("effect-v4", "global"),
    makeSkill("react", "global"),
    makeSkill("bun", "local"),
  ]

  test("plain name resolves local first", () => {
    const result = resolveSkillName(skills, "effect-v4", Option.none())
    expect(Option.getOrThrow(result).level).toBe("local")
  })

  test("plain name falls back to global", () => {
    const result = resolveSkillName(skills, "react", Option.none())
    expect(Option.getOrThrow(result).level).toBe("global")
  })

  test("$skill:local resolves to local", () => {
    const result = resolveSkillName(skills, "$effect-v4:local", Option.none())
    expect(Option.getOrThrow(result).level).toBe("local")
  })

  test("$skill:global resolves to global", () => {
    const result = resolveSkillName(skills, "$effect-v4:global", Option.none())
    expect(Option.getOrThrow(result).level).toBe("global")
  })

  test("strips $ prefix", () => {
    const result = Option.getOrThrow(resolveSkillName(skills, "$bun", Option.none()))
    expect(result.name).toBe("bun")
    expect(result.level).toBe("local")
  })

  test("explicit level parameter overrides", () => {
    const result = resolveSkillName(skills, "effect-v4", Option.some("global"))
    expect(Option.getOrThrow(result).level).toBe("global")
  })

  test("returns undefined for unknown skill", () => {
    const result = resolveSkillName(skills, "unknown", Option.none())
    expect(Option.isNone(result)).toBe(true)
  })

  test("colon in name without level suffix treated as part of name", () => {
    const result = resolveSkillName(skills, "effect:v4", Option.none())
    expect(Option.isNone(result)).toBe(true)
  })
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
