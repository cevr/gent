import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"

import { SkillsTool } from "../../src/skills/skills-tool.js"
import { SearchSkillsTool } from "../../src/skills/search-skills.js"
import { Skill, Skills } from "../../src/skills/skills.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

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
      runToolWithCtx(SkillsTool, { names: ["react"] }, ctx).pipe(
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
      runToolWithCtx(SkillsTool, { names: ["effect-v4"] }, ctx).pipe(
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
      runToolWithCtx(SkillsTool, { names: ["$effect-v4:global"] }, ctx).pipe(
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
      runToolWithCtx(SkillsTool, { names: ["nonexistent"] }, ctx).pipe(
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
      runToolWithCtx(SkillsTool, { names: "all" }, ctx).pipe(
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
      runToolWithCtx(SkillsTool, { names: "all", level: "global" }, ctx).pipe(
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
      runToolWithCtx(SearchSkillsTool, { query: "effect" }, ctx).pipe(
        Effect.map((result) => {
          const r = result as { count: number; results: ReadonlyArray<{ name: string }> }
          expect(r.count).toBe(2)
          expect(r.results.every((s) => s.name === "effect-v4")).toBe(true)
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )

  it.live("includes level in results", () =>
    narrowR(
      runToolWithCtx(SearchSkillsTool, { query: "react" }, ctx).pipe(
        Effect.map((result) => {
          const r = result as { results: ReadonlyArray<{ level: string }> }
          expect(r.results[0]?.level).toBe("global")
        }),
        Effect.provide(skillsLayer),
      ),
    ),
  )
})
