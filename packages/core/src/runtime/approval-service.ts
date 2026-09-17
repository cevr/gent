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
import { InteractionStorage } from "../storage/interaction-storage.js"

const makeApprovalInteractionService: Effect.Effect<
  InteractionService,
  never,
  EventPublisher | GentPlatform | InteractionStorage
> = Effect.gen(function* () {
  const store = yield* InteractionStorage
  const storage: InteractionStorageConfig = {
    persist: (record) =>
      Effect.gen(function* () {
        // A dispatching tool owns the interactions its inner calls raise, so
        // they are written to its receipt. Core does not know which tools
        // those are; an absent owner is a direct call.
        const owner = yield* Effect.serviceOption(CurrentInteractionOwner)
        if (Option.isSome(owner)) {
          yield* owner.value.persist(record)
        } else {
          yield* store.persist(record)
        }
      }).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new EventStoreError({ message: "Failed to persist interaction request", cause }),
        ),
      ),
    resolve: (requestId) => store.resolve(requestId).pipe(Effect.catchEager(() => Effect.void)),
    decide: (requestId, decisionJson) =>
      store
        .decide(requestId, decisionJson)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreError({ message: "Failed to persist interaction decision", cause }),
          ),
        ),
  }
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

interface ApprovalServiceApi extends InteractionService {}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceApi>()(
  "@gent/core/src/runtime/approval-service/ApprovalService",
) {
  static Live: Layer.Layer<
    ApprovalService,
    never,
    EventPublisher | GentPlatform | InteractionStorage
  > = Layer.effect(ApprovalService, makeApprovalInteractionService)

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
        rehydrate: () => Effect.void,
      }),
    )
  }
}
