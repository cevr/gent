import { Effect, Layer, Context } from "effect"
import { ApprovalService } from "../runtime/approval-service.js"
import { InteractionResolved } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { InteractionRequestMismatchError } from "../domain/interaction-request.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import type { BranchId, InteractionRequestId, SessionId } from "../domain/ids.js"
import type { AppServiceError } from "./errors.js"
import type { BranchStorage } from "../storage/branch-storage.js"
import type { SessionStorage } from "../storage/session-storage.js"
import { resolveExistingSessionBranch } from "../runtime/session-runtime-context.js"

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
      const storageContext = yield* Effect.context<SessionStorage | BranchStorage>()

      return {
        respond: Effect.fn("InteractionCommands.respond")(function* (
          input: RespondInteractionInput,
        ) {
          yield* resolveExistingSessionBranch({
            sessionId: input.sessionId,
            branchId: input.branchId,
          }).pipe(Effect.provideContext(storageContext))

          const pendingRequestId = yield* approvalService.pendingRequestId(input)
          if (pendingRequestId !== input.requestId) {
            return yield* new InteractionRequestMismatchError({
              message:
                pendingRequestId === undefined
                  ? "No pending interaction request exists for this session branch"
                  : "Interaction response requestId does not match the pending request",
              expectedRequestId: pendingRequestId,
              actualRequestId: input.requestId,
              sessionId: input.sessionId,
              branchId: input.branchId,
            })
          }

          // 1. Store resolution durably so re-entering present() finds it
          yield* approvalService.storeResolution(input.requestId, {
            approved: input.approved,
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
          })
          // 2. Wake the machine. present() marks the row resolved only when the
          //    tool consumes the durable decision.
          yield* sessionRuntime.respondInteraction({
            sessionId: input.sessionId,
            branchId: input.branchId,
            requestId: input.requestId,
          })
          // 3. Publish resolution event
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
