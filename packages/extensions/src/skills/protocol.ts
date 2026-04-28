import { Effect, Schema } from "effect"
import { ExtensionId, request } from "@gent/core/extensions/api"
import { SkillLevel, Skills } from "./skills.js"

export const SKILLS_EXTENSION_ID = ExtensionId.make("@gent/skills")

export const SkillEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  level: SkillLevel,
  filePath: Schema.String,
  content: Schema.String,
})
export type SkillEntry = typeof SkillEntry.Type

export const SkillsRpc = {
  ListSkills: request({
    id: "skills-list",
    extensionId: SKILLS_EXTENSION_ID,
    intent: "read",
    description: "List loaded skills",
    input: Schema.Struct({}),
    output: Schema.Array(SkillEntry),
    execute: Effect.fn("SkillsRpc.ListSkills")(function* () {
      const skills = yield* Skills
      return yield* skills.list()
    }),
  }),
  GetSkillContent: request({
    id: "skills-get-content",
    extensionId: SKILLS_EXTENSION_ID,
    intent: "read",
    description: "Read one loaded skill by name",
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.NullOr(SkillEntry),
    execute: Effect.fn("SkillsRpc.GetSkillContent")(function* ({ name }) {
      const skills = yield* Skills
      return (yield* skills.get(name)) ?? null
    }),
  }),
}
