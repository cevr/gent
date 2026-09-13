import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { compileSystemPrompt } from "@gent/core-internal/domain/prompt.js"
import { basePromptSections, main } from "../src/agents"

describe("agents extension", () => {
  it.effect("the persona is four sections ahead of the environment", () =>
    Effect.sync(() => {
      expect(basePromptSections.map((section) => section.id)).toEqual([
        "identity",
        "work",
        "communication",
        "boundaries",
      ])
      expect(basePromptSections.every((section) => section.priority < 60)).toBe(true)
      const compiled = compileSystemPrompt(basePromptSections)
      expect(compiled).toContain("You are Gent, a general purpose agent.")
      expect(compiled).toContain("A child inherits your agent and model")
      expect(compiled).toContain("Never revert changes you did not make.")
      expect(String(main.name)).toBe("main")
    }),
  )
})
