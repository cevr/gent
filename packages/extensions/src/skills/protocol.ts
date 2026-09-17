import { Effect, Schema } from "effect"
import { defineRequests, ExtensionId, request } from "@gent/core/extensions/api"
import { Skill, Skills } from "./skills.js"

export const SKILLS_EXTENSION_ID = ExtensionId.make("@gent/skills")

export const SkillEntry = Schema.Struct(Skill.fields)
export type SkillEntry = typeof SkillEntry.Type

export const SkillsRpc = defineRequests(SKILLS_EXTENSION_ID, {
  ListSkills: request({
    id: "skills-list",
    description: "List loaded skills",
    input: Schema.Struct({}),
    output: Schema.Array(SkillEntry),
    execute: Effect.fn("SkillsRpc.ListSkills")(function* () {
      const skills = yield* Skills
      return yield* skills.list
    }),
  }),
})
