import { Effect, Schema } from "effect"
import { Skills } from "./skills.js"
import { defineTool } from "../../domain/tool.js"

export class SearchSkillsError extends Schema.TaggedErrorClass<SearchSkillsError>()(
  "SearchSkillsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const SearchSkillsParams = Schema.Struct({
  query: Schema.String.annotate({ description: "Search term" }),
  includeContent: Schema.optional(
    Schema.Boolean.annotate({
      description: "Include full skill content in results (default false)",
    }),
  ),
})

export const SearchSkillsTool = defineTool({
  name: "search_skills",
  action: "state",
  concurrency: "parallel",
  idempotent: true,
  description:
    "Search loaded skills by name or description. Optionally include the full skill content.",
  params: SearchSkillsParams,
  execute: Effect.fn("SearchSkillsTool.execute")(function* (params) {
    const skills = yield* Skills
    const allSkills = yield* skills.list()
    const query = params.query.trim().toLowerCase()

    if (query === "") {
      return yield* new SearchSkillsError({
        message: "query must not be empty",
      })
    }

    const matches = allSkills.filter((skill) => {
      const haystack = `${skill.name}\n${skill.description}\n${skill.filePath}`.toLowerCase()
      return haystack.includes(query)
    })

    return {
      query: params.query,
      count: matches.length,
      results: matches.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        level: skill.level,
        ...(params.includeContent === true ? { content: skill.content } : {}),
      })),
    }
  }),
})
