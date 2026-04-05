/**
 * Legacy handler service tags — kept temporarily for test layer wiring.
 *
 * These services are no longer used in production. Tools use ctx.approve()
 * which delegates to ApprovalService. These tags exist only so existing
 * test files that wire HandoffHandler.Test() / PromptHandler.Test() into
 * their layers continue to compile during the migration.
 *
 * Delete in Batch 7 when handler tags are fully removed.
 */

import { ServiceMap, Effect, Layer } from "effect"
import type { ApprovalDecision } from "./interaction-request"

// ============================================================================
// Prompt Handler (legacy tag — test stub only)
// ============================================================================

export interface PromptHandlerService {
  readonly present: () => Effect.Effect<ApprovalDecision>
  readonly respond: () => Effect.Effect<void>
  readonly storeResolution: () => void
  readonly rehydrate: () => Effect.Effect<void>
}

export class PromptHandler extends ServiceMap.Service<PromptHandler, PromptHandlerService>()(
  "@gent/core/src/domain/interaction-handlers/PromptHandler",
) {
  static Test = (_decisions?: ReadonlyArray<string>): Layer.Layer<PromptHandler> =>
    Layer.succeed(PromptHandler, {
      present: () => Effect.succeed({ approved: true }),
      respond: () => Effect.void,
      storeResolution: () => {},
      rehydrate: () => Effect.void,
    })
}

// ============================================================================
// Handoff Handler (legacy tag — test stub only)
// ============================================================================

export interface HandoffHandlerService {
  readonly present: () => Effect.Effect<ApprovalDecision>
  readonly respond: () => Effect.Effect<void>
  readonly storeResolution: () => void
  readonly rehydrate: () => Effect.Effect<void>
}

export class HandoffHandler extends ServiceMap.Service<HandoffHandler, HandoffHandlerService>()(
  "@gent/core/src/domain/interaction-handlers/HandoffHandler",
) {
  static Test = (_decisions?: ReadonlyArray<string>): Layer.Layer<HandoffHandler> =>
    Layer.succeed(HandoffHandler, {
      present: () => Effect.succeed({ approved: true }),
      respond: () => Effect.void,
      storeResolution: () => {},
      rehydrate: () => Effect.void,
    })
}
