import { Context, Effect, Layer, Schema } from "effect"
import { defineTool, type Question, type ToolContext } from "@gent/core"
import { AskUserHandler } from "./ask-user"

// Option schema for structured choices

const QuestionOption = Schema.Struct({
  label: Schema.String.annotations({
    description: "Short display text for the option",
  }),
  description: Schema.String.annotations({
    description: "Explanation of what this option means",
  }),
})

// Single question schema

const QuestionInput = Schema.Struct({
  question: Schema.String.annotations({
    description: "The question to ask",
  }),
  header: Schema.String.pipe(Schema.maxLength(30)).annotations({
    description: "Short label for the question (max 30 chars)",
  }),
  options: Schema.Array(QuestionOption).pipe(Schema.minItems(2), Schema.maxItems(4)).annotations({
    description: "2-4 choices for the user",
  }),
  multiple: Schema.optional(Schema.Boolean).annotations({
    description: "Allow selecting multiple options",
  }),
})

// Question Handler Service

export interface QuestionHandlerService {
  readonly ask: (
    questions: ReadonlyArray<Question>,
    ctx: ToolContext,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
}

export class QuestionHandler extends Context.Tag("QuestionHandler")<
  QuestionHandler,
  QuestionHandlerService
>() {
  static Live: Layer.Layer<QuestionHandler, never, AskUserHandler> = Layer.effect(
    QuestionHandler,
    Effect.gen(function* () {
      const askUserHandler = yield* AskUserHandler
      return {
        ask: (questions, ctx) => askUserHandler.askMany(questions, ctx),
      }
    }),
  )

  static Test = (responses: ReadonlyArray<ReadonlyArray<string>>): Layer.Layer<QuestionHandler> => {
    let callIndex = 0
    return Layer.succeed(QuestionHandler, {
      ask: (questions, _ctx) =>
        Effect.succeed(
          questions.map((_, i) => responses[callIndex * questions.length + i] ?? [""]),
        ).pipe(Effect.tap(() => Effect.sync(() => callIndex++))),
    })
  }
}

// Question Params & Result

export const QuestionParams = Schema.Struct({
  questions: Schema.Array(QuestionInput).pipe(Schema.minItems(1), Schema.maxItems(5)).annotations({
    description: "1-5 questions to ask the user",
  }),
})

export const QuestionResult = Schema.Struct({
  answers: Schema.Array(Schema.Array(Schema.String)).annotations({
    description: "Selected labels for each question",
  }),
})

// Question Tool

export const QuestionTool = defineTool({
  name: "question",
  description:
    "Ask user structured questions with predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or making implementation choices.",
  params: QuestionParams,
  execute: Effect.fn("QuestionTool.execute")(function* (params, ctx) {
    const handler = yield* QuestionHandler
    const answers = yield* handler.ask(params.questions, ctx)
    return { answers }
  }),
})
