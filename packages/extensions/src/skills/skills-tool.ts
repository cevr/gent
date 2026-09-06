import { Effect, Option, Schema } from "effect"
import { Skills, resolveSkillName } from "./skills.js"
import { tool } from "@gent/core/extensions/api"

export const SkillsParams = Schema.Struct({
  names: Schema.Union([Schema.Array(Schema.String), Schema.Literal("all")]).annotate({
    description:
      'Skill names to load, or "all". Supports $skill, $skill:local, $skill:global syntax.',
  }),
  level: Schema.optionalKey(
    Schema.Literals(["local", "global"]).annotate({
      description: "Filter by level. If omitted, resolves local-first.",
    }),
  ),
})

// Skills Result

export const SkillsResult = Schema.String

export const SkillsTool = tool({
  id: "skills",
  description:
    "Load skill content by name. Skills provide domain-specific patterns and guidelines.",
  promptSnippet: "Load skill content for domain-specific patterns",
  promptGuidelines: [
    "When you see `$skill-name` in the conversation, load it with the skills tool",
    "Use search_skills to discover skills by context when unsure which to load",
    "Use `$skill:local` or `$skill:global` to disambiguate when same name exists at both levels",
  ],
  params: SkillsParams,
  output: SkillsResult,
  execute: Effect.fn("SkillsTool.execute")(function* (params) {
    const skills = yield* Skills
    const allSkills = yield* skills.list
    const level = Option.fromNullishOr(params.level)

    if (params.names === "all") {
      let filtered = allSkills
      if (Option.isSome(level)) {
        filtered = allSkills.filter((skill) => skill.level === level.value)
      }
      if (filtered.length === 0) return "[No skills available]"
      return filtered.map((s) => `## ${s.name} (${s.level})\n\n${s.content}`).join("\n\n---\n\n")
    }

    const results: string[] = []
    const notFound: string[] = []

    for (const name of params.names) {
      const skill = resolveSkillName(allSkills, name, Option.fromNullishOr(params.level))
      if (Option.isSome(skill)) {
        results.push(`## ${skill.value.name} (${skill.value.level})\n\n${skill.value.content}`)
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
