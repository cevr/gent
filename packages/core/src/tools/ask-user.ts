import { ServiceMap, Effect, Layer, Schema } from "effect"
import { defineTool, type ToolContext } from "../domain/tool.js"
import { EventStore, type EventStoreError, QuestionsAsked, type Question } from "../domain/event.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import { makeInteractionService } from "../domain/interaction-request.js"

// Question option schema

const QuestionOption = Schema.Struct({
  label: Schema.String.annotate({ description: "Short display text for the option" }),
  description: Schema.optional(
    Schema.String.annotate({ description: "Explanation of what this option means" }),
  ),
})

// Question input schema

const QuestionInput = Schema.Struct({
  question: Schema.String.annotate({ description: "The question to ask" }),
  header: Schema.optional(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  options: Schema.optional(
    Schema.Array(QuestionOption)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for user to choose from" }),
  ),
  multiple: Schema.optional(
    Schema.Boolean.annotate({ description: "Allow selecting multiple options" }),
  ),
})

// AskUser Params — canonical questions[] input

export const AskUserParams = Schema.Struct({
  questions: Schema.Array(QuestionInput)
    .check(Schema.isMinLength(1), Schema.isMaxLength(5))
    .annotate({ description: "1-5 questions to ask the user" }),
})

// AskUser Result — canonical answers[][] output

export const AskUserResult = Schema.Struct({
  answers: Schema.Array(Schema.Array(Schema.String)).annotate({
    description: "Selected labels for each question",
  }),
})

// AskUser Handler Service

interface AskUserParams_ {
  questions: ReadonlyArray<Question>
  sessionId: SessionId
  branchId: BranchId
}

export interface AskUserHandlerService {
  readonly askMany: (
    questions: ReadonlyArray<Question>,
    ctx: ToolContext,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>, EventStoreError>
  readonly respond: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void, EventStoreError>
}

export class AskUserHandler extends ServiceMap.Service<AskUserHandler, AskUserHandlerService>()(
  "@gent/tools/src/ask-user/AskUserHandler",
) {
  static Live: Layer.Layer<AskUserHandler, never, EventStore> = Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore

      const interaction = makeInteractionService<
        AskUserParams_,
        ReadonlyArray<ReadonlyArray<string>>
      >({
        onPresent: (requestId, params) =>
          eventStore.publish(
            new QuestionsAsked({
              sessionId: params.sessionId,
              branchId: params.branchId,
              requestId,
              questions: [...params.questions],
            }),
          ),
        onRespond: () => Effect.void,
      })

      return {
        askMany: Effect.fn("AskUserHandler.askMany")(function* (
          questions: ReadonlyArray<Question>,
          ctx: ToolContext,
        ) {
          return yield* interaction.present({
            questions,
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
          })
        }),
        respond: (requestId, answers) =>
          interaction.respond(requestId, answers).pipe(Effect.asVoid),
      }
    }),
  )

  static Test = (responses: ReadonlyArray<ReadonlyArray<string>>): Layer.Layer<AskUserHandler> => {
    let callIndex = 0
    return Layer.succeed(AskUserHandler, {
      askMany: (questions, _ctx) =>
        Effect.succeed(
          questions.map((_, i) => responses[callIndex * questions.length + i] ?? [""]),
        ).pipe(Effect.tap(() => Effect.sync(() => callIndex++))),
      respond: (_requestId, _answers) => Effect.void,
    })
  }
}

// AskUser Tool

export const AskUserTool = defineTool({
  name: "ask_user",
  action: "interact",
  concurrency: "serial",
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params, ctx) {
    const handler = yield* AskUserHandler
    const answers = yield* handler.askMany(params.questions, ctx)
    return { answers }
  }),
})
