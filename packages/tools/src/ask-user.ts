import { Context, Deferred, Effect, Layer, Schema } from "effect"
import {
  defineTool,
  EventBus,
  QuestionsAsked,
  type Question,
  type ToolContext,
} from "@gent/core"

// AskUser Tool Params

const QuestionOptionParamsSchema = Schema.Struct({
  label: Schema.String.annotations({ description: "Option label shown to user" }),
  description: Schema.optional(
    Schema.String.annotations({ description: "Optional description" }),
  ),
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
  readonly ask: (params: Question, ctx: ToolContext) => Effect.Effect<string>
  /** Multiple questions - uses ToolContext */
  readonly askMany: (
    questions: ReadonlyArray<Question>,
    ctx: ToolContext,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  /** Respond to pending request */
  readonly respond: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<void>
}

export class AskUserHandler extends Context.Tag("AskUserHandler")<
  AskUserHandler,
  AskUserHandlerService
>() {
  static Live: Layer.Layer<AskUserHandler, never, EventBus> = Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const eventBus = yield* EventBus
      // Global pending map keyed by requestId
      const pending = new Map<
        string,
        Deferred.Deferred<ReadonlyArray<ReadonlyArray<string>>>
      >()

      const askMany = Effect.fn("AskUserHandler.askMany")(function* (
        questions: ReadonlyArray<Question>,
        ctx: ToolContext,
      ) {
        const requestId = Bun.randomUUIDv7()
        const deferred = yield* Deferred.make<ReadonlyArray<ReadonlyArray<string>>>()
        pending.set(requestId, deferred)
        yield* eventBus.publish(
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
            if (deferred) yield* Deferred.succeed(deferred, answers)
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
