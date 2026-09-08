import { Schema } from "effect"
import { ExtensionId } from "@gent/core/extensions/api"

export const BTW_EXTENSION_ID = ExtensionId.make("@gent/btw")

export const MAXIMUM_SIDE_QUESTION_CHARS = 8000

/** One completed exchange in a side conversation; replayed on follow-ups. */
export const SideTurn = Schema.Struct({
  question: Schema.String,
  answer: Schema.String,
})
export type SideTurn = typeof SideTurn.Type

export const SideQuestionInput = Schema.Struct({
  question: Schema.String,
  previous: Schema.Array(SideTurn),
})
export type SideQuestionInput = typeof SideQuestionInput.Type

export const SideQuestionOutput = Schema.Struct({
  answer: Schema.String,
})
export type SideQuestionOutput = typeof SideQuestionOutput.Type
