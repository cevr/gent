import { Effect } from "effect"
import { extension, type SystemPromptInput } from "../api.js"
import { Skills, formatSkillsForPrompt } from "../../domain/skills.js"
import type { Interceptor } from "../../domain/extension.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"

// The prompt.system interceptor type requires R=never, but Skills is available
// in the runtime context via ServiceMap. Cast is safe — Skills.Live is provided
// in dependencies.ts before the agent loop runs.
const skillsPromptInterceptor = ((
  input: SystemPromptInput,
  next: (i: SystemPromptInput) => Effect.Effect<string>,
) =>
  Effect.gen(function* () {
    const skills = yield* Skills
    const allSkills = yield* skills.list()
    const prompt = yield* next(input)
    if (allSkills.length === 0) return prompt
    const skillsBlock = formatSkillsForPrompt(allSkills)
    return `${prompt}\n\n${skillsBlock}`
  })) as unknown as Interceptor<SystemPromptInput, string>

export const SkillsExtension = extension("@gent/skills", (ext) => {
  ext.tool(SkillsTool)
  ext.tool(SearchSkillsTool)
  ext.on("prompt.system", skillsPromptInterceptor)
})
