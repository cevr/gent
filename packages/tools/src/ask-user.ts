import { Context, Deferred, Effect, Layer, Schema } from "effect"
import {
  defineTool,
  EventStore,
  type EventStoreError,
  QuestionsAsked,
  type Question,
  type ToolContext,
} from "@gent/core"

// AskUser Tool Params

const QuestionOptionParamsSchema = Schema.Struct({
  label: Schema.String.annotations({ description: "Option label shown to user" }),
  description: Schema.optional(Schema.String.annotations({ description: "Optional description" })),
})

export const AskUserParams = Schema.Struct({
  question: Schema.String.annotations({
    description: "Question to ask the user",
  }),
  header: Schema.optional(
    Schema.String.annotations({
      description: "Short header label (max 12 chars)",
    }),
  ),
  options: Schema.optional(
    Schema.Array(QuestionOptionParamsSchema).annotations({
      description: "Options for user to choose from (label + optional description)",
    }),
  ),
  multiple: Schema.optional(
    Schema.Boolean.annotations({
      description: "Allow multiple selections (checkbox) vs single (radio)",
    }),
  ),
})

// AskUser Tool Result

export const AskUserResult = Schema.Struct({
  response: Schema.String,
})

// AskUser Handler Service

export interface AskUserHandlerService {
  /** Single question - uses ToolContext for sessionId/branchId */
  readonly ask: (params: Question, ctx: ToolContext) => Effect.Effect<string, EventStoreError>
  /** Multiple questions - uses ToolContext */
  readonly askMany: (
    questions: ReadonlyArray<Question>,
    ctx: ToolContext,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, EventStoreError>
  /** Respond to pending request */
  readonly respond: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void>
}

export class AskUserHandler extends Context.Tag("@gent/tools/src/ask-user/AskUserHandler")<
  AskUserHandler,
  AskUserHandlerService
>() {
  static Live: Layer.Layer<AskUserHandler, never, EventStore> = Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      // Global pending map keyed by requestId
      const pending = new Map<string, Deferred.Deferred<ReadonlyArray<ReadonlyArray<string>>>>()

      const askMany = Effect.fn("AskUserHandler.askMany")(function* (
        questions: ReadonlyArray<Question>,
        ctx: ToolContext,
      ) {
        const requestId = Bun.randomUUIDv7()
        const deferred = yield* Deferred.make<ReadonlyArray<ReadonlyArray<string>>>()
        pending.set(requestId, deferred)
        yield* eventStore.publish(
          new QuestionsAsked({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            requestId,
            questions: [...questions],
          }),
        )
        const answers = yield* Deferred.await(deferred)
        pending.delete(requestId)
        return answers
      })

      return {
        ask: Effect.fn("AskUserHandler.ask")(function* (params: Question, ctx: ToolContext) {
          const answers = yield* askMany([params], ctx)
          return answers[0]?.join(", ") ?? ""
        }),
        askMany,
        respond: (requestId, answers) =>
          Effect.gen(function* () {
            const deferred = pending.get(requestId)
            if (deferred !== undefined) {
              yield* Deferred.succeed(deferred, answers)
            }
          }),
      }
    }),
  )

  static Test = (responses: ReadonlyArray<string>): Layer.Layer<AskUserHandler> => {
    let index = 0
    return Layer.succeed(AskUserHandler, {
      ask: (_params, _ctx) => Effect.succeed(responses[index++] ?? ""),
      askMany: (_questions, _ctx) => Effect.succeed([]),
      respond: (_requestId, _answers) => Effect.void,
    })
  }
}

// AskUser Tool

export const AskUserTool = defineTool({
  name: "ask_user",
  concurrency: "serial",
  description:
    "Ask user for clarification. Use frequently to validate assumptions and get preferences.",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params, ctx) {
    const handler = yield* AskUserHandler
    const response = yield* handler.ask(
      {
        question: params.question,
        header: params.header,
        options: params.options,
        multiple: params.multiple,
      },
      ctx,
    )
    return { response }
  }),
})

// ============================================================================
// Question tool (structured multi-question)
// ============================================================================

const QuestionOption = Schema.Struct({
  label: Schema.String.annotations({
    description: "Short display text for the option",
  }),
  description: Schema.String.annotations({
    description: "Explanation of what this option means",
  }),
})

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

export interface QuestionHandlerService {
  readonly ask: (
    questions: ReadonlyArray<Question>,
    ctx: ToolContext,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, EventStoreError>
}

export class QuestionHandler extends Context.Tag("@gent/tools/src/ask-user/QuestionHandler")<
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

export const QuestionTool = defineTool({
  name: "question",
  concurrency: "serial",
  description:
    "Ask user structured questions with predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or making implementation choices.",
  params: QuestionParams,
  execute: Effect.fn("QuestionTool.execute")(function* (params, ctx) {
    const handler = yield* QuestionHandler
    const answers = yield* handler.ask(params.questions, ctx)
    return { answers }
  }),
})
