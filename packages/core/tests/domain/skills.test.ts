import { describe, it, test, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Skills, Skill, formatSkillsForPrompt } from "@gent/core/domain/skills"

describe("Skills System", () => {
  it.live("Skills.Test provides test skills", () => {
    const testSkills = [
      new Skill({
        name: "test-skill",
        description: "A test skill",
        filePath: "/test/skill.md",
        content: "# Test Skill\n\nContent here",
        scope: "global",
      }),
    ]

    return Effect.gen(function* () {
      const skills = yield* Skills
      const result = yield* skills.list()
      expect(result.length).toBe(1)
      expect(result[0]?.name).toBe("test-skill")
    }).pipe(Effect.provide(Skills.Test(testSkills)))
  })

  test("formatSkillsForPrompt formats skills correctly", () => {
    const skills = [
      new Skill({
        name: "skill1",
        description: "First skill",
        filePath: "/s1.md",
        content: "",
        scope: "global",
      }),
      new Skill({
        name: "skill2",
        description: "Second skill",
        filePath: "/s2.md",
        content: "",
        scope: "project",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("<available_skills>")
    expect(formatted).toContain("**skill1**")
    expect(formatted).toContain("**skill2**")
  })

  test("formatSkillsForPrompt qualifies names on collision", () => {
    const skills = [
      new Skill({
        name: "deploy",
        description: "Project deploy",
        filePath: "/proj/.gent/skills/deploy.md",
        content: "",
        scope: "project",
      }),
      new Skill({
        name: "deploy",
        description: "Global deploy",
        filePath: "/home/.gent/skills/deploy.md",
        content: "",
        scope: "global",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("**deploy (project)**")
    expect(formatted).toContain("**deploy (global)**")
  })

  test("formatSkillsForPrompt returns empty for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })
})
