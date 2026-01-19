import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import {
  Skills,
  Skill,
  formatSkillsForPrompt,
  AuthStorage,
  calculateCost,
} from "@gent/core"

describe("Skills System", () => {
  test("Skills.Test provides test skills", async () => {
    const testSkills = [
      new Skill({
        name: "test-skill",
        description: "A test skill",
        filePath: "/test/skill.md",
        content: "# Test Skill\n\nContent here",
      }),
    ]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const skills = yield* Skills
        return yield* skills.list()
      }).pipe(Effect.provide(Skills.Test(testSkills)))
    )

    expect(result.length).toBe(1)
    expect(result[0]?.name).toBe("test-skill")
  })

  test("formatSkillsForPrompt formats skills correctly", () => {
    const skills = [
      new Skill({
        name: "skill1",
        description: "First skill",
        filePath: "/s1.md",
        content: "",
      }),
      new Skill({
        name: "skill2",
        description: "Second skill",
        filePath: "/s2.md",
        content: "",
      }),
    ]

    const formatted = formatSkillsForPrompt(skills)
    expect(formatted).toContain("<available_skills>")
    expect(formatted).toContain("**skill1**")
    expect(formatted).toContain("**skill2**")
  })

  test("formatSkillsForPrompt returns empty for no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("")
  })
})

describe("Auth Storage", () => {
  test("AuthStorage.Test stores and retrieves keys", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("anthropic", "test-key-123")
        return yield* auth.get("anthropic")
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toBe("test-key-123")
  })

  test("AuthStorage.Test deletes keys", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("openai", "key")
        yield* auth.delete("openai")
        return yield* auth.get("openai")
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toBeUndefined()
  })

  test("AuthStorage.Test lists providers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStorage
        yield* auth.set("anthropic", "k1")
        yield* auth.set("openai", "k2")
        return yield* auth.list()
      }).pipe(Effect.provide(AuthStorage.Test()))
    )

    expect(result).toContain("anthropic")
    expect(result).toContain("openai")
  })
})

describe("Cost Calculation", () => {
  test("calculateCost computes correctly", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    const pricing = { input: 3, output: 15 } // $3/1M input, $15/1M output

    const cost = calculateCost(usage, pricing)
    // (1000 / 1M) * 3 + (500 / 1M) * 15 = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6)
  })

  test("calculateCost returns 0 without pricing", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 }
    expect(calculateCost(usage, undefined)).toBe(0)
  })

  test("calculateCost handles large token counts", () => {
    const usage = { inputTokens: 100000, outputTokens: 50000 }
    const pricing = { input: 3, output: 15 }

    const cost = calculateCost(usage, pricing)
    // (100000 / 1M) * 3 + (50000 / 1M) * 15 = 0.3 + 0.75 = 1.05
    expect(cost).toBeCloseTo(1.05, 6)
  })
})
