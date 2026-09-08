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

/**
 * The side question most recently started on this branch. `text` grows while
 * the child streams; `done` flips once `answer` or `error` is final.
 */
export const SideQuestionRun = Schema.Struct({
  question: Schema.String,
  text: Schema.String,
  done: Schema.Boolean,
  answer: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type SideQuestionRun = typeof SideQuestionRun.Type

export const SideQuestionProgress = Schema.Struct({
  run: Schema.optional(SideQuestionRun),
})
export type SideQuestionProgress = typeof SideQuestionProgress.Type

/** Asking returns at once; the answer arrives through `btw.progress` on state pulses. */
export const SideQuestionOutput = Schema.Struct({
  started: Schema.Boolean,
})
export type SideQuestionOutput = typeof SideQuestionOutput.Type
