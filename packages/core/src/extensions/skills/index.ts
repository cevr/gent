import { Effect } from "effect"
import { extension } from "../api.js"
import { Skills, formatSkillsForPrompt } from "../../domain/skills.js"
import { SkillsTool } from "./skills-tool.js"
import { SearchSkillsTool } from "./search-skills.js"

export const SkillsExtension = extension("@gent/skills", ({ ext }) =>
  ext
    .tools(SkillsTool, SearchSkillsTool)
    // Skills is provided as a core layer in dependencies.ts — available in the
    // ServiceMap when resolve runs. Cast narrows R from Skills to never.
    .promptSections({
      id: "skills",
      priority: 80,
      resolve: Effect.gen(function* () {
        const skills = yield* Skills
        const allSkills = yield* skills.list()
        return formatSkillsForPrompt(allSkills)
      }) as Effect.Effect<string>,
    }),
)
