import { Effect, Schema } from "effect"
import {
  tool,
  QuestionSchema,
  QuestionOptionSchema,
  type Question,
} from "@gent/core/extensions/api"

const parseAnswers = (notes: string): string[][] => {
  try {
    const parsed = JSON.parse(notes) as unknown
    if (Array.isArray(parsed) && parsed.every(Array.isArray)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
      return parsed as string[][]
    }
    return [[notes]]
  } catch {
    return [[notes]]
  }
}

// AskUser Params — canonical questions[] input
// Reuses QuestionSchema from event.ts with tool-specific length constraints.

const AskUserQuestionSchema = Schema.Struct({
  ...QuestionSchema.fields,
  header: Schema.optional(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  options: Schema.optional(
    Schema.Array(QuestionOptionSchema)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for user to choose from" }),
  ),
})

export const AskUserParams = Schema.Struct({
  questions: Schema.Array(AskUserQuestionSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(5))
    .annotate({ description: "1-5 questions to ask the user" }),
})

// AskUser Result — canonical answers[][] output

export const AskUserResult = Schema.Struct({
  answers: Schema.Array(Schema.Array(Schema.String)).annotate({
    description: "Selected labels for each question",
  }),
  cancelled: Schema.optional(Schema.Boolean).annotate({
    description: "True when the user cancelled the interaction",
  }),
})

// AskUser Tool — uses ctx.interaction.approve() with structured question metadata

const formatQuestionsText = (questions: ReadonlyArray<Question>): string =>
  questions
    .map((q, i) => {
      const header = q.header !== undefined ? `[${q.header}] ` : ""
      const options =
        q.options !== undefined ? `\nOptions: ${q.options.map((o) => o.label).join(", ")}` : ""
      return `${i + 1}. ${header}${q.question}${options}`
    })
    .join("\n")

export const AskUserTool = tool({
  id: "ask_user",
  resources: ["ask_user"],
  interactive: true,
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  promptSnippet: "Ask the user questions with optional predefined options",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params, ctx) {
    const decision = yield* ctx.interaction.approve({
      text: formatQuestionsText(params.questions),
      metadata: { type: "ask-user", questions: params.questions },
    })
    if (!decision.approved) {
      return { answers: [], cancelled: true }
    }
    // Parse structured answers from notes (JSON-encoded string[][])
    let answers: string[][] = [[]]
    if (decision.notes !== undefined) {
      answers = parseAnswers(decision.notes)
    }
    return { answers }
  }),
})
