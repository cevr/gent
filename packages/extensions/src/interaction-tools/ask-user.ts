import { Effect, Schema } from "effect"
import { ExtensionContext, tool, type Question } from "@gent/core/extensions/api"

const AnswersSchema = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String)))
const decodeAnswers = Schema.decodeUnknownEffect(AnswersSchema)

const parseAnswers = (notes: string): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>> =>
  decodeAnswers(notes).pipe(
    Effect.orElseSucceed(() => [[notes]] as ReadonlyArray<ReadonlyArray<string>>),
  )

// AskUser Params — canonical questions[] input
// Mirrors QuestionSchema with exact-optional fields for provider tool schemas.

const AskUserQuestionOptionSchema = Schema.Struct({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
})
const AskUserQuestionSchema = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  markdown: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(
    Schema.Array(AskUserQuestionOptionSchema)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for user to choose from" }),
  ),
  multiple: Schema.optionalKey(Schema.Boolean),
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

// AskUser Tool — uses ExtensionContext.Interaction.approve() with structured question metadata

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
  interactive: true,
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  promptSnippet: "Ask the user questions with optional predefined options",
  params: AskUserParams,
  output: AskUserResult,
  execute: Effect.fn("AskUserTool.execute")(function* (params: typeof AskUserParams.Type) {
    const ctx = yield* ExtensionContext
    const decision = yield* ctx.Interaction.approve({
      text: formatQuestionsText(params.questions),
      metadata: { type: "ask-user", questions: params.questions },
    })
    if (!decision.approved) {
      return { answers: [], cancelled: true }
    }
    const answers =
      decision.notes !== undefined ? yield* parseAnswers(decision.notes) : [[] as string[]]
    return { answers }
  }),
})
