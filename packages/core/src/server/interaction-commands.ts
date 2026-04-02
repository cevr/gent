import { Effect, Layer, ServiceMap } from "effect"
import { HandoffHandler, PromptHandler } from "../domain/interaction-handlers.js"
import { AskUserHandler } from "../tools/ask-user.js"
import { AgentLoop } from "../runtime/agent/agent-loop.js"
import { SessionCommands } from "./session-commands.js"
import { SessionQueries } from "./session-queries.js"
import { type AppServiceError } from "./errors.js"
import type {
  RespondHandoffInput,
  RespondHandoffResult,
  RespondPromptInput,
  RespondQuestionsInput,
} from "./transport-contract.js"

export interface InteractionCommandsService {
  readonly respondPrompt: (input: RespondPromptInput) => Effect.Effect<void, AppServiceError>
  readonly respondHandoff: (
    input: RespondHandoffInput,
  ) => Effect.Effect<RespondHandoffResult, AppServiceError>
  readonly respondQuestions: (input: RespondQuestionsInput) => Effect.Effect<void, AppServiceError>
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
      const askUserHandler = yield* AskUserHandler
      const agentLoop = yield* AgentLoop
      const queries = yield* SessionQueries
      const commands = yield* SessionCommands

      return {
        respondPrompt: Effect.fn("InteractionCommands.respondPrompt")(function* (
          input: RespondPromptInput,
        ) {
          // 1. Store resolution so re-entering present() finds it
          promptHandler.storeResolution(input.sessionId, input.branchId, input.decision)
          // 2. Wake the machine (before storage resolve — if we crash after
          //    resolve but before wake, the request is no longer pending and
          //    the in-memory resolution is lost, stranding the session)
          yield* agentLoop.respondInteraction({
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
          })
          // 3. Resolve in storage (best-effort cleanup after wake)
          yield* promptHandler.respond(input.requestId, input.decision, input.content)
        }),

        respondHandoff: Effect.fn("InteractionCommands.respondHandoff")(function* (
          input: RespondHandoffInput,
        ) {
          if (input.decision !== "confirm") {
            handoffHandler.storeResolution(input.sessionId, input.branchId, "reject")
            yield* agentLoop.respondInteraction({
              sessionId: input.sessionId,
              branchId: input.branchId,
              requestId: input.requestId,
            })
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

          handoffHandler.storeResolution(input.sessionId, input.branchId, "confirm")
          yield* agentLoop.respondInteraction({
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
          })
          yield* handoffHandler.respond(input.requestId, "confirm", result.sessionId)
          return { childSessionId: result.sessionId, childBranchId: result.branchId }
        }),

        respondQuestions: Effect.fn("InteractionCommands.respondQuestions")(function* (
          input: RespondQuestionsInput,
        ) {
          const decision =
            input.cancelled === true
              ? ({ _tag: "cancelled" } as const)
              : { _tag: "answered" as const, answers: [...input.answers] }
          askUserHandler.storeResolution(input.sessionId, input.branchId, decision)
          yield* agentLoop.respondInteraction({
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
          })
          yield* askUserHandler.respond(input.requestId, [...input.answers], input.cancelled)
        }),
      } satisfies InteractionCommandsService
    }),
  )
}
