/**
 * Layer-scoped approval service.
 *
 * Wraps `makeInteractionService` with the fixed approval schema.
 * Long-lived — one instance per server scope, so storedResolutions
 * survive across tool re-executions for cold resume.
 *
 * Tools access this indirectly via `ctx.interaction.approve()` on ToolCapabilityContext.
 */

import { Context, Effect, Layer, Option } from "effect"
import { EventPublisher } from "../domain/event-publisher.js"
import { EventStoreError, InteractionPresented } from "../domain/event.js"
import { CurrentInteractionOwner } from "../domain/interaction-owner.js"
import type { InteractionRequestId } from "../domain/ids.js"
import {
  makeInteractionService,
  type ApprovalDecision,
  type InteractionService,
  type InteractionStorageConfig,
} from "../domain/interaction-request.js"
import type { GentPlatform } from "./gent-platform.js"

interface ApprovalServiceApi extends InteractionService {}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceApi>()(
  "@gent/core/src/runtime/approval-service/ApprovalService",
) {
  static Live: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> = Layer.effect(
    ApprovalService,
    makeApprovalInteractionService(),
  )

  static LiveWithStorage = (
    storage: InteractionStorageConfig,
  ): Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> =>
    Layer.effect(ApprovalService, makeApprovalInteractionService(storage))

  static Test = (decisions?: ReadonlyArray<ApprovalDecision>): Layer.Layer<ApprovalService> => {
    const queue = [...(decisions ?? [{ approved: true }])]
    return Layer.succeed(
      ApprovalService,
      ApprovalService.of({
        present: () => {
          const decision = Option.getOrElse(Option.fromUndefinedOr(queue.shift()), () => ({
            approved: true,
          }))
          return Effect.succeed(decision)
        },
        pendingRequestId: () =>
          Effect.sync(() => Option.getOrUndefined(Option.none<InteractionRequestId>())),
        storeResolution: () => Effect.void,
        respond: () => Effect.void,
        rehydrate: () => Effect.void,
      }),
    )
  }
}

function makeApprovalInteractionService(
  storage?: InteractionStorageConfig,
): Effect.Effect<InteractionService, never, EventPublisher | GentPlatform> {
  return Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    const service = yield* makeInteractionService({
      onPresent: (requestId, params, ctx) =>
        eventPublisher.publish(
          InteractionPresented.make({
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            requestId,
            text: params.text,
            metadata: params.metadata,
          }),
        ),
      storage,
    })
    return {
      ...service,
      present: Effect.fn("ApprovalService.present")(function* (params, ctx) {
        // An interaction raised inside a dispatching tool belongs to that
        // tool's receipt, not to the branch's native replay. Absent owner is
        // the common case: a direct tool call takes the native path.
        const owner = yield* Effect.serviceOption(CurrentInteractionOwner)
        if (Option.isNone(owner)) return yield* service.present(params, ctx)
        if (Option.isNone(Option.fromUndefinedOr(storage)))
          return yield* new EventStoreError({
            message: "An owned interaction requires durable interaction storage",
          })
        if (owner.value.sessionId !== ctx.sessionId || owner.value.branchId !== ctx.branchId)
          return yield* new EventStoreError({
            message: "The owning call belongs to another branch",
          })
        return yield* service.present(params, {
          ...ctx,
          resumeRequestId: yield* owner.value.resumeRequestId,
        })
      }),
    }
  })
}
