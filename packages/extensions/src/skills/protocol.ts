import { Schema } from "effect"
import { ExtensionMessage } from "@gent/core/extensions/api"
import { SkillLevel } from "./skills.js"

export const SKILLS_EXTENSION_ID = "@gent/skills"

export const SkillEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  level: SkillLevel,
  filePath: Schema.String,
  content: Schema.String,
})
export type SkillEntry = typeof SkillEntry.Type

export const SkillsProtocol = {
  ListSkills: ExtensionMessage.reply(
    SKILLS_EXTENSION_ID,
    "ListSkills",
    {},
    Schema.Array(SkillEntry),
  ),
  GetSkillContent: ExtensionMessage.reply(
    SKILLS_EXTENSION_ID,
    "GetSkillContent",
    { name: Schema.String },
    Schema.NullOr(SkillEntry),
  ),
}
