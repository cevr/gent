/**
 * Layer-scoped approval service.
 *
 * Wraps `makeInteractionService` with the fixed approval schema.
 * Long-lived — one instance per server scope, so storedResolutions
 * survive across tool re-executions for cold resume.
 *
 * Tools access this indirectly via `ctx.interaction.approve()` on ToolContext.
 */

import { ServiceMap, Effect, Layer } from "effect"
import { EventPublisher, type EventPublisherService } from "../domain/event-publisher.js"
import { InteractionPresented, type EventStoreError } from "../domain/event.js"
import type { BranchId, SessionId } from "../domain/ids.js"
import {
  makeInteractionService,
  type ApprovalDecision,
  type ApprovalRequest,
  type InteractionPendingError,
  type InteractionService,
  type InteractionStorageConfig,
} from "../domain/interaction-request.js"

export interface ApprovalServiceShape {
  /** Present an approval request to the user. Throws InteractionPendingError on first call (cold). */
  readonly present: (
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>
  /** Store a resolution for cold-mode resumption */
  readonly storeResolution: (requestId: string, decision: ApprovalDecision) => void
  /** Mark a request as resolved in storage */
  readonly respond: (requestId: string) => Effect.Effect<void, EventStoreError>
  /** Re-publish event for a persisted pending request (recovery after restart) */
  readonly rehydrate: (
    requestId: string,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<void, EventStoreError>
}

export class ApprovalService extends ServiceMap.Service<ApprovalService, ApprovalServiceShape>()(
  "@gent/core/runtime/approval-service/ApprovalService",
) {
  static Live: Layer.Layer<ApprovalService, never, EventPublisher> = Layer.effect(
    ApprovalService,
    Effect.gen(function* () {
      const eventPublisher = yield* EventPublisher
      const interaction = makeApprovalInteractionService(eventPublisher)
      return {
        present: interaction.present,
        storeResolution: interaction.storeResolution,
        respond: interaction.respond,
        rehydrate: interaction.rehydrate,
      }
    }),
  )

  static LiveWithStorage = (
    storage: InteractionStorageConfig,
  ): Layer.Layer<ApprovalService, never, EventPublisher> =>
    Layer.effect(
      ApprovalService,
      Effect.gen(function* () {
        const eventPublisher = yield* EventPublisher
        const interaction = makeApprovalInteractionService(eventPublisher, storage)
        return {
          present: interaction.present,
          storeResolution: interaction.storeResolution,
          respond: interaction.respond,
          rehydrate: interaction.rehydrate,
        }
      }),
    )

  /** Auto-resolves all approval requests without human interaction.
   *  - ask-user requests → cancelled (don't fabricate user answers)
   *  - all other requests (approval, confirm, review) → approved */
  static LiveAutoResolve: Layer.Layer<ApprovalService> = Layer.succeed(ApprovalService, {
    present: (params) => {
      const meta = params.metadata as { type?: string } | undefined
      const isAskUser = meta?.type === "ask-user"
      return Effect.succeed(isAskUser ? { approved: false } : { approved: true })
    },
    storeResolution: () => {},
    respond: () => Effect.void,
    rehydrate: () => Effect.void,
  })

  static Test = (decisions?: ReadonlyArray<ApprovalDecision>): Layer.Layer<ApprovalService> => {
    const queue = [...(decisions ?? [{ approved: true }])]
    return Layer.succeed(ApprovalService, {
      present: () => {
        const decision = queue.shift() ?? { approved: true }
        return Effect.succeed(decision)
      },
      storeResolution: () => {},
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
  }
}

const makeApprovalInteractionService = (
  eventPublisher: EventPublisherService,
  storage?: InteractionStorageConfig,
): InteractionService =>
  makeInteractionService({
    onPresent: (requestId, params, ctx) =>
      eventPublisher.publish(
        new InteractionPresented({
          sessionId: ctx.sessionId,
          branchId: ctx.branchId,
          requestId,
          text: params.text,
          metadata: params.metadata,
        }),
      ),
    storage,
  })
