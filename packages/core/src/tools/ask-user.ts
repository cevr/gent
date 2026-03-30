import { ServiceMap, Effect, Layer, Schema } from "effect"
import { defineTool, type ToolContext } from "../domain/tool.js"
import {
  EventStore,
  type EventStoreError,
  QuestionsAsked,
  type Question,
  QuestionSchema,
  QuestionOptionSchema,
} from "../domain/event.js"
import type { SessionId, BranchId } from "../domain/ids.js"
import {
  makeInteractionService,
  type InteractionRequestRecord,
  type InteractionStorageConfig,
} from "../domain/interaction-request.js"
import { Storage } from "../storage/sqlite-storage.js"

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

// AskUser decision — discriminated so execute can tell cancelled from answered

export type AskUserDecision =
  | { readonly _tag: "answered"; readonly answers: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly _tag: "cancelled" }

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
  ) => Effect.Effect<AskUserDecision, EventStoreError>
  readonly respond: (
    requestId: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
    cancelled?: boolean,
  ) => Effect.Effect<void, EventStoreError>
  readonly rehydrate: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
}

export class AskUserHandler extends ServiceMap.Service<AskUserHandler, AskUserHandlerService>()(
  "@gent/core/src/tools/ask-user/AskUserHandler",
) {
  static Live: Layer.Layer<AskUserHandler, never, EventStore | Storage> = Layer.effect(
    AskUserHandler,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const storage = yield* Storage

      const storageCallbacks: InteractionStorageConfig = {
        persist: (record) =>
          storage.persistInteractionRequest(record).pipe(
            Effect.asVoid,
            Effect.catchEager(() => Effect.void),
          ),
        resolve: (requestId) =>
          storage.resolveInteractionRequest(requestId).pipe(Effect.catchEager(() => Effect.void)),
      }

      const interaction = makeInteractionService<AskUserParams_, AskUserDecision>({
        type: "ask-user",
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
        getContext: (params) => ({ sessionId: params.sessionId, branchId: params.branchId }),
        storage: storageCallbacks,
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
        respond: (requestId, answers, cancelled) =>
          interaction
            .respond(
              requestId,
              cancelled === true ? { _tag: "cancelled" } : { _tag: "answered", answers },
            )
            .pipe(Effect.asVoid),
        rehydrate: (record) =>
          interaction.rehydrate(record.requestId, JSON.parse(record.paramsJson) as AskUserParams_),
      }
    }),
  )

  static Test = (responses: ReadonlyArray<ReadonlyArray<string>>): Layer.Layer<AskUserHandler> => {
    let callIndex = 0
    return Layer.succeed(AskUserHandler, {
      askMany: (questions, _ctx) =>
        Effect.succeed<AskUserDecision>({
          _tag: "answered",
          answers: questions.map((_, i) => responses[callIndex * questions.length + i] ?? [""]),
        }).pipe(Effect.tap(() => Effect.sync(() => callIndex++))),
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
  }

  static TestCancelled = (): Layer.Layer<AskUserHandler> =>
    Layer.succeed(AskUserHandler, {
      askMany: () => Effect.succeed<AskUserDecision>({ _tag: "cancelled" }),
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
}

// AskUser Tool

export const AskUserTool = defineTool({
  name: "ask_user",
  action: "interact",
  concurrency: "serial",
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  promptSnippet: "Ask the user questions with optional predefined options",
  params: AskUserParams,
  execute: Effect.fn("AskUserTool.execute")(function* (params, ctx) {
    const handler = yield* AskUserHandler
    const decision = yield* handler.askMany(params.questions, ctx)
    if (decision._tag === "cancelled") {
      return { answers: [], cancelled: true }
    }
    return { answers: decision.answers }
  }),
})
