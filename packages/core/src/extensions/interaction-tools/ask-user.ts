import { Effect, Schema } from "effect"
import { defineTool } from "../../domain/tool.js"
import { type Question, QuestionSchema, QuestionOptionSchema } from "../../domain/event.js"

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

// AskUser Tool — uses ctx.approve() with structured question metadata

const formatQuestionsText = (questions: ReadonlyArray<Question>): string =>
  questions
    .map((q, i) => {
      const header = q.header !== undefined ? `[${q.header}] ` : ""
      const options =
        q.options !== undefined ? `\nOptions: ${q.options.map((o) => o.label).join(", ")}` : ""
      return `${i + 1}. ${header}${q.question}${options}`
    })
    .join("\n")

export const AskUserTool = defineTool({
  name: "ask_user",
  action: "interact",
  concurrency: "serial",
  interactive: true,
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  promptSnippet: "Ask the user questions with optional predefined options",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params, ctx) {
    const decision = yield* ctx.approve({
      text: formatQuestionsText(params.questions),
      metadata: { type: "ask-user", questions: params.questions },
    })
    if (!decision.approved) {
      return { answers: [], cancelled: true }
    }
    // Parse structured answers from notes (JSON-encoded string[][])
    let answers: string[][] = [[]]
    if (decision.notes !== undefined) {
      try {
        const parsed = JSON.parse(decision.notes) as unknown
        if (Array.isArray(parsed) && parsed.every(Array.isArray)) {
          answers = parsed as string[][]
        } else {
          answers = [[decision.notes]]
        }
      } catch {
        answers = [[decision.notes]]
      }
    }
    return { answers }
  }),
})
