import { Context, Effect, Layer, Schema } from "effect"
import { defineTool } from "@gent/core"

// AskUser Tool Params

export const AskUserParams = Schema.Struct({
  question: Schema.String.annotations({
    description: "Question to ask the user",
  }),
  options: Schema.optional(
    Schema.Array(Schema.String).annotations({
      description: "Optional list of choices",
    }),
  ),
})

// AskUser Tool Result

export const AskUserResult = Schema.Struct({
  response: Schema.String,
})

// AskUser Handler Service

export interface AskUserHandlerService {
  readonly ask: (question: string, options?: ReadonlyArray<string>) => Effect.Effect<string>
}

export class AskUserHandler extends Context.Tag("AskUserHandler")<
  AskUserHandler,
  AskUserHandlerService
>() {
  static Test = (responses: ReadonlyArray<string>): Layer.Layer<AskUserHandler> => {
    let index = 0
    return Layer.succeed(AskUserHandler, {
      ask: () => Effect.succeed(responses[index++] ?? ""),
    })
  }
}

// AskUser Tool

export const AskUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask user for clarification. Use frequently to validate assumptions and get preferences.",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params) {
    const handler = yield* AskUserHandler
    const response = yield* handler.ask(params.question, params.options)
    return { response }
  }),
})
