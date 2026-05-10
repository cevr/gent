/**
 * Layer-scoped approval service.
 *
 * Wraps `makeInteractionService` with the fixed approval schema.
 * Long-lived — one instance per server scope, so storedResolutions
 * survive across tool re-executions for cold resume.
 *
 * Tools access this indirectly via `ctx.interaction.approve()` on ToolCapabilityContext.
 */

import { Context, Effect, Layer } from "effect"
import { isRecord } from "../domain/guards.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { InteractionPresented, type EventStoreError } from "../domain/event.js"
import type { BranchId, InteractionRequestId, SessionId } from "../domain/ids.js"
import {
  makeInteractionService,
  type ApprovalDecision,
  type ApprovalRequest,
  type InteractionPendingError,
  type InteractionService,
  type InteractionStorageConfig,
} from "../domain/interaction-request.js"
import type { GentPlatform } from "./gent-platform.js"

export interface ApprovalServiceShape {
  /** Present an approval request to the user. Throws InteractionPendingError on first call (cold). */
  readonly present: (
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
  ) => Effect.Effect<ApprovalDecision, EventStoreError | InteractionPendingError>
  readonly pendingRequestId: (ctx: {
    sessionId: SessionId
    branchId: BranchId
  }) => Effect.Effect<InteractionRequestId | undefined>
  /** Store a resolution for cold-mode resumption */
  readonly storeResolution: (
    requestId: InteractionRequestId,
    decision: ApprovalDecision,
  ) => Effect.Effect<void, EventStoreError>
  /** Mark a request as resolved in storage */
  readonly respond: (requestId: InteractionRequestId) => Effect.Effect<void, EventStoreError>
  /** Re-publish event for a persisted pending request (recovery after restart) */
  readonly rehydrate: (
    requestId: InteractionRequestId,
    params: ApprovalRequest,
    ctx: { sessionId: SessionId; branchId: BranchId },
    decision?: ApprovalDecision,
  ) => Effect.Effect<void, EventStoreError>
}

export class ApprovalService extends Context.Service<ApprovalService, ApprovalServiceShape>()(
  "@gent/core/src/runtime/approval-service/ApprovalService",
) {
  static Live: Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> = Layer.effect(
    ApprovalService,
    Effect.gen(function* () {
      const interaction = yield* makeApprovalInteractionService()
      return {
        present: interaction.present,
        pendingRequestId: interaction.pendingRequestId,
        storeResolution: interaction.storeResolution,
        respond: interaction.respond,
        rehydrate: interaction.rehydrate,
      }
    }),
  )

  static LiveWithStorage = (
    storage: InteractionStorageConfig,
  ): Layer.Layer<ApprovalService, never, EventPublisher | GentPlatform> =>
    Layer.effect(
      ApprovalService,
      Effect.gen(function* () {
        const interaction = yield* makeApprovalInteractionService(storage)
        return {
          present: interaction.present,
          pendingRequestId: interaction.pendingRequestId,
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
      const meta = isRecord(params.metadata) ? params.metadata : undefined
      const isAskUser = meta?.["type"] === "ask-user"
      return Effect.succeed(isAskUser ? { approved: false } : { approved: true })
    },
    pendingRequestId: () => Effect.sync((): InteractionRequestId | undefined => undefined),
    storeResolution: () => Effect.void,
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
      pendingRequestId: () => Effect.sync((): InteractionRequestId | undefined => undefined),
      storeResolution: () => Effect.void,
      respond: () => Effect.void,
      rehydrate: () => Effect.void,
    })
  }
}

const makeApprovalInteractionService = (
  storage?: InteractionStorageConfig,
): Effect.Effect<InteractionService, never, EventPublisher | GentPlatform> =>
  Effect.gen(function* () {
    const eventPublisher = yield* EventPublisher
    return yield* makeInteractionService({
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
  })
