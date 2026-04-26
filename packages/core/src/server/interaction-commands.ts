import { Effect, Layer, Context } from "effect"
import { ApprovalService } from "../runtime/approval-service.js"
import { InteractionResolved } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { SessionRuntime, respondInteractionCommand } from "../runtime/session-runtime.js"
import type { BranchId, InteractionRequestId, SessionId } from "../domain/ids.js"
import type { AppServiceError } from "./errors.js"

export interface RespondInteractionInput {
  readonly requestId: InteractionRequestId
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly approved: boolean
  readonly notes?: string
}

export interface InteractionCommandsService {
  readonly respond: (input: RespondInteractionInput) => Effect.Effect<void, AppServiceError>
}

export class InteractionCommands extends Context.Service<
  InteractionCommands,
  InteractionCommandsService
>()("@gent/core/src/server/interaction-commands/InteractionCommands") {
  static Live = Layer.effect(
    InteractionCommands,
    Effect.gen(function* () {
      const approvalService = yield* ApprovalService
      const sessionRuntime = yield* SessionRuntime
      const eventPublisher = yield* EventPublisher

      return {
        respond: Effect.fn("InteractionCommands.respond")(function* (
          input: RespondInteractionInput,
        ) {
          // 1. Store resolution so re-entering present() finds it
          approvalService.storeResolution(input.requestId, {
            approved: input.approved,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          })
          // 2. Wake the machine (before storage resolve — if we crash after
          //    resolve but before wake, the request is no longer pending and
          //    the in-memory resolution is lost, stranding the session)
          yield* sessionRuntime.dispatch(
            respondInteractionCommand({
              sessionId: input.sessionId,
              branchId: input.branchId,
              requestId: input.requestId,
            }),
          )
          // 3. Resolve in storage (best-effort cleanup after wake)
          yield* approvalService.respond(input.requestId)
          // 4. Publish resolution event
          yield* eventPublisher
            .publish(
              InteractionResolved.make({
                sessionId: input.sessionId,
                branchId: input.branchId,
                requestId: input.requestId,
                approved: input.approved,
                ...(input.notes !== undefined ? { notes: input.notes } : {}),
              }),
            )
            .pipe(Effect.catchEager(() => Effect.void))
        }),
      } satisfies InteractionCommandsService
    }),
  )
}
