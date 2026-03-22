import { describe, test, expect } from "bun:test"
import { parseSkillTokens, expandSkillMentions } from "../src/utils/skill-expansion"

describe("parseSkillTokens", () => {
  test("finds single token", () => {
    const tokens = parseSkillTokens("use $effect-v4 for this")
    expect(tokens).toEqual([{ name: "effect-v4", start: 4, end: 14 }])
  })

  test("finds multiple tokens", () => {
    const tokens = parseSkillTokens("$react and $bun")
    expect(tokens).toHaveLength(2)
    expect(tokens[0]!.name).toBe("react")
    expect(tokens[1]!.name).toBe("bun")
  })

  test("ignores $$", () => {
    const tokens = parseSkillTokens("$$notaskill")
    expect(tokens).toHaveLength(0)
  })

  test("ignores escaped dollar", () => {
    const tokens = parseSkillTokens("\\$notaskill")
    expect(tokens).toHaveLength(0)
  })

  test("ignores mid-word dollar", () => {
    const tokens = parseSkillTokens("co$t")
    expect(tokens).toHaveLength(0)
  })

  test("matches at start of string", () => {
    const tokens = parseSkillTokens("$react is great")
    expect(tokens[0]!.name).toBe("react")
  })

  test("no tokens in plain text", () => {
    expect(parseSkillTokens("hello world")).toHaveLength(0)
  })

  test("requires lowercase start", () => {
    expect(parseSkillTokens("$React")).toHaveLength(0)
    expect(parseSkillTokens("$123")).toHaveLength(0)
  })
})

describe("expandSkillMentions", () => {
  const skills: Record<string, string> = {
    "effect-v4": "Effect v4 skill content",
    react: "React skill content",
  }
  const getContent = (name: string) => skills[name] ?? null

  test("expands single skill mention", () => {
    const result = expandSkillMentions("use $effect-v4", getContent)
    expect(result).toContain('<loaded_skill name="effect-v4">')
    expect(result).toContain("Effect v4 skill content")
    expect(result).toContain("use $effect-v4")
  })

  test("expands multiple skill mentions", () => {
    const result = expandSkillMentions("$effect-v4 and $react", getContent)
    expect(result).toContain('<loaded_skill name="effect-v4">')
    expect(result).toContain('<loaded_skill name="react">')
    expect(result).toContain("$effect-v4 and $react")
  })

  test("deduplicates same skill", () => {
    const result = expandSkillMentions("$react first $react second", getContent)
    const matches = result.match(/<loaded_skill/g)
    expect(matches).toHaveLength(1)
  })

  test("ignores unknown skills", () => {
    const result = expandSkillMentions("use $unknown-skill", getContent)
    expect(result).toBe("use $unknown-skill")
  })

  test("no expansion for plain text", () => {
    const result = expandSkillMentions("hello world", getContent)
    expect(result).toBe("hello world")
  })

  test("includes base_dir when filePath provided", () => {
    const result = expandSkillMentions("use $effect-v4", getContent, (name) =>
      name === "effect-v4" ? "/skills/effect-v4/SKILL.md" : null,
    )
    expect(result).toContain('base_dir="/skills/effect-v4"')
  })

  test("caps total expanded bytes", () => {
    const hugeContent: Record<string, string> = {
      big: "x".repeat(90_000),
      small: "y".repeat(20_000),
    }
    const result = expandSkillMentions("$big then $small", (name) => hugeContent[name] ?? null)
    // big fits (90K < 100K), small gets skipped (90K + 20K > 100K)
    expect(result).toContain('<loaded_skill name="big">')
    expect(result).not.toContain('<loaded_skill name="small">')
  })
})
