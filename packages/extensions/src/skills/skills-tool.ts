import { Effect, Schema } from "effect"
import { Skills, resolveSkillName } from "./skills.js"
import { defineTool } from "@gent/core/extensions/api"

export const SkillsParams = Schema.Struct({
  names: Schema.Union([Schema.Array(Schema.String), Schema.Literal("all")]).annotate({
    description:
      'Skill names to load, or "all". Supports $skill, $skill:local, $skill:global syntax.',
  }),
  level: Schema.optional(
    Schema.Literals(["local", "global"]).annotate({
      description: "Filter by level. If omitted, resolves local-first.",
    }),
  ),
})

export const SkillsTool = defineTool({
  name: "skills",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Load skill content by name. Skills provide domain-specific patterns and guidelines.",
  promptSnippet: "Load skill content for domain-specific patterns",
  promptGuidelines: [
    "When you see `$skill-name` in the conversation, load it with the skills tool",
    "Use search_skills to discover skills by context when unsure which to load",
    "Use `$skill:local` or `$skill:global` to disambiguate when same name exists at both levels",
  ],
  params: SkillsParams,
  execute: Effect.fn("SkillsTool.execute")(function* (params) {
    const skills = yield* Skills
    const allSkills = yield* skills.list()

    if (params.names === "all") {
      const filtered =
        params.level !== undefined ? allSkills.filter((s) => s.level === params.level) : allSkills
      if (filtered.length === 0) return "[No skills available]"
      return filtered.map((s) => `## ${s.name} (${s.level})\n\n${s.content}`).join("\n\n---\n\n")
    }

    const results: string[] = []
    const notFound: string[] = []

    for (const name of params.names) {
      const skill = resolveSkillName(allSkills, name, params.level)
      if (skill !== undefined) {
        results.push(`## ${skill.name} (${skill.level})\n\n${skill.content}`)
      } else {
        notFound.push(name)
      }
    }

    const output = results.join("\n\n---\n\n")
    if (notFound.length > 0) {
      const available = allSkills.map((s) => s.name)
      const unique = [...new Set(available)]
      return `${output}\n\n[Not found: ${notFound.join(", ")}. Available: ${unique.join(", ")}]`
    }
    return output
  }),
})
