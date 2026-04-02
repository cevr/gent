import { Effect, Layer, ServiceMap } from "effect"
import { HandoffHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"
import { type AppServiceError } from "./errors.js"
import type {
  RespondHandoffInput,
  RespondHandoffResult,
  RespondPromptInput,
} from "./transport-contract.js"

export interface InteractionCommandsService {
  readonly respondPrompt: (input: RespondPromptInput) => Effect.Effect<void, AppServiceError>
  readonly respondHandoff: (
    input: RespondHandoffInput,
  ) => Effect.Effect<RespondHandoffResult, AppServiceError>
}

export class InteractionCommands extends ServiceMap.Service<
  InteractionCommands,
  InteractionCommandsService
>()("@gent/core/src/server/interaction-commands/InteractionCommands") {
  static Live = Layer.effect(
    InteractionCommands,
    Effect.gen(function* () {
      const promptHandler = yield* PromptHandler
      const handoffHandler = yield* HandoffHandler
      const queries = yield* SessionQueries
      const commands = yield* SessionCommands

      return {
        respondPrompt: (input) =>
          promptHandler
            .respond(input.requestId, input.decision, input.content)
            .pipe(Effect.asVoid, Effect.withSpan("InteractionCommands.respondPrompt")),
        respondHandoff: Effect.fn("InteractionCommands.respondHandoff")(function* (
          input: RespondHandoffInput,
        ) {
          if (input.decision !== "confirm") {
            yield* handoffHandler.respond(input.requestId, "reject", undefined, input.reason)
            return { childSessionId: undefined, childBranchId: undefined }
          }

          const entry = yield* handoffHandler.claim(input.requestId)
          if (entry === undefined) {
            return { childSessionId: undefined, childBranchId: undefined }
          }

          const parentSession = yield* queries.getSession(entry.sessionId)
          const result = yield* commands.createSession({
            ...(parentSession?.cwd !== undefined ? { cwd: parentSession.cwd } : {}),
            parentSessionId: entry.sessionId,
            parentBranchId: entry.branchId,
            initialPrompt: `[Handoff]\n\n${entry.summary}`,
          })

          yield* handoffHandler.respond(input.requestId, "confirm", result.sessionId)
          return { childSessionId: result.sessionId, childBranchId: result.branchId }
        }),
      } satisfies InteractionCommandsService
    }),
  )
}
