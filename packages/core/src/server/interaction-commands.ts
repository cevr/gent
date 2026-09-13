import { Predicate, Effect } from "effect"
import { ApprovalService } from "../runtime/approval-service.js"
import { InteractionResolved } from "../domain/event.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { InteractionRequestMismatchError } from "../domain/interaction-request.js"
import { SessionRuntime } from "../runtime/session-runtime.js"
import type { RespondInteractionInput } from "./transport-contract.js"
import { resolveExistingSessionBranch } from "../runtime/session-runtime-context.js"
import { omitUndefined } from "../domain/guards.js"

/** Resolve the pending interaction on a branch and wake its loop. */
export const respondInteraction = Effect.fn("InteractionCommands.respond")(function* (
  input: RespondInteractionInput,
) {
  const approvalService = yield* ApprovalService
  const sessionRuntime = yield* SessionRuntime
  const eventPublisher = yield* EventPublisher
  yield* resolveExistingSessionBranch({
    sessionId: input.sessionId,
    branchId: input.branchId,
  })

  const pendingRequestId = yield* approvalService.pendingRequestId(input)
  if (pendingRequestId !== input.requestId) {
    let message = "Interaction response requestId does not match the pending request"
    if (Predicate.isUndefined(pendingRequestId)) {
      message = "No pending interaction request exists for this session branch"
    }
    return yield* new InteractionRequestMismatchError({
      message,
      expectedRequestId: pendingRequestId,
      actualRequestId: input.requestId,
      sessionId: input.sessionId,
      branchId: input.branchId,
    })
  }

  const decision = {
    approved: input.approved,
    notes: input.notes,
    ...omitUndefined({ editedContent: input.editedContent }),
  }
  // 1. Store resolution durably so re-entering present() finds it
  yield* approvalService.storeResolution(input.requestId, decision)
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
        ...decision,
      }),
    )
    .pipe(Effect.catchEager(() => Effect.void))
})
