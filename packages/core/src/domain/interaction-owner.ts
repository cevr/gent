/**
 * Who owns the interaction being presented right now.
 *
 * A tool that dispatches other tools inside itself owns their interactions: an
 * approval raised by an inner call belongs to the dispatcher's receipt, not to
 * the branch's native replay, and must be persisted and resumed through it.
 *
 * Core does not know which tools dispatch, so it does not try to answer that
 * question. A dispatcher provides this service for the duration of an inner
 * call; when it is absent — the common case — interactions take the native
 * branch path.
 */

import { Context, type Effect, type Option } from "effect"
import type { EventStoreError } from "./event.js"
import type { BranchId, InteractionRequestId, SessionId } from "./ids.js"
import type { InteractionRequestRecord } from "./interaction-request.js"

export interface InteractionOwnership {
  /** The session and branch the owning call belongs to. */
  readonly sessionId: SessionId
  readonly branchId: BranchId
  /**
   * Persist a request against the owner's receipt instead of the branch store.
   */
  readonly persist: (record: InteractionRequestRecord) => Effect.Effect<void, EventStoreError>
  /**
   * The request id to resume, for an owner that is mid-approval.
   *
   * `None` starts a fresh interaction. A failure means the owner is not in a
   * state that can take one.
   */
  readonly resumeRequestId: Effect.Effect<Option.Option<InteractionRequestId>, EventStoreError>
}

export class CurrentInteractionOwner extends Context.Service<
  CurrentInteractionOwner,
  InteractionOwnership
>()("@gent/core/src/domain/interaction-owner/CurrentInteractionOwner") {}
