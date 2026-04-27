import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"

const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
import { SkillsTool } from "@gent/extensions/skills/skills-tool"
import { SearchSkillsTool } from "@gent/extensions/skills/search-skills"
import { Skill, Skills } from "@gent/extensions/skills/skills"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

const testSkills = [
  new Skill({
    name: "effect-v4",
    description: "Effect v4 patterns",
    filePath: "/global/effect-v4.md",
    content: "Use Effect.fn for tracing",
    level: "global",
  }),
  new Skill({
    name: "effect-v4",
    description: "Project-specific Effect patterns",
    filePath: "/local/effect-v4.md",
    content: "Custom service layer patterns",
    level: "local",
  }),
  new Skill({
    name: "react",
    description: "React component patterns",
    filePath: "/global/react.md",
    content: "Use function components",
    level: "global",
  }),
]

const skillsLayer = Skills.Test(testSkills)
const ctx = testToolContext()

describe("SkillsTool", () => {
  it.live("loads specific skill by name", () =>
    narrowR(
      SkillsTool.effect({ names: ["react"] }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("react")
          expect(result).toContain("Use function components")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("resolves local before global for ambiguous names", () =>
    narrowR(
      SkillsTool.effect({ names: ["effect-v4"] }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("Custom service layer patterns")
          expect(result).toContain("local")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("supports $skill:global syntax", () =>
    narrowR(
      SkillsTool.effect({ names: ["$effect-v4:global"] }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("Use Effect.fn for tracing")
          expect(result).toContain("global")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("reports not-found skills", () =>
    narrowR(
      SkillsTool.effect({ names: ["nonexistent"] }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("Not found: nonexistent")
          expect(result).toContain("Available:")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("loads all skills", () =>
    narrowR(
      SkillsTool.effect({ names: "all" }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("effect-v4")
          expect(result).toContain("react")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("filters all by level", () =>
    narrowR(
      SkillsTool.effect({ names: "all", level: "global" }, ctx).pipe(
        Effect.map((result) => {
          expect(result).toContain("Use Effect.fn for tracing")
          expect(result).toContain("react")
          expect(result).not.toContain("Custom service layer patterns")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )
})

describe("SearchSkillsTool", () => {
  it.live("finds skills by name", () =>
    narrowR(
      SearchSkillsTool.effect({ query: "effect" }, ctx).pipe(
        Effect.map((result) => {
          const r = result as { count: number; results: Array<{ name: string }> }
          expect(r.count).toBe(2)
          expect(r.results.every((s) => s.name === "effect-v4")).toBe(true)
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("includes level in results", () =>
    narrowR(
      SearchSkillsTool.effect({ query: "react" }, ctx).pipe(
        Effect.map((result) => {
          const r = result as { results: Array<{ level: string }> }
          expect(r.results[0]?.level).toBe("global")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )
})
