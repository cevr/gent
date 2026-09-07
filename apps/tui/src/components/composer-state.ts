/**
 * Composer state — raw interaction events, no normalization.
 *
 * Shell mode, autocomplete, and history are local controller concerns.
 * This state handles server-driven interaction flows (questions, permissions, prompts, handoffs).
 */

import { Schema } from "effect"
import {
  InteractionPresented,
  type ActiveInteraction,
  type ApprovalResult,
} from "@gent/core-internal/domain/event.js"

const ApprovalResultSchema = Schema.Struct({
  approved: Schema.Boolean,
  notes: Schema.optional(Schema.String),
  editedContent: Schema.optional(Schema.String),
})

export type ComposerState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "interaction"; readonly interaction: ActiveInteraction }

export const ComposerState = {
  idle: (): ComposerState => ({ _tag: "idle" }),
}

export const ComposerEvent = Schema.TaggedUnion({
  EnterInteraction: { interaction: InteractionPresented },
  ResolveInteraction: { result: ApprovalResultSchema },
  CancelInteraction: {},
  DismissInteraction: { requestId: Schema.String },
})
export type ComposerEvent = Schema.Schema.Type<typeof ComposerEvent>

export type ComposerEffect = {
  readonly _tag: "DispatchInteractionResult"
  readonly interaction: ActiveInteraction
  readonly result: ApprovalResult
}

export interface TransitionResult {
  readonly state: ComposerState
  readonly effect?: ComposerEffect
}

export function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  if (event._tag === "EnterInteraction") {
    return { state: { _tag: "interaction", interaction: event.interaction } }
  }

  if (event._tag === "ResolveInteraction") {
    if (state._tag !== "interaction") return { state }
    return {
      state: ComposerState.idle(),
      effect: {
        _tag: "DispatchInteractionResult",
        interaction: state.interaction,
        result: event.result,
      },
    }
  }

  if (event._tag === "CancelInteraction") {
    if (state._tag !== "interaction") return { state }
    return cancelInteraction(state.interaction)
  }

  if (state._tag !== "interaction") return { state }
  if (!("requestId" in state.interaction) || state.interaction.requestId !== event.requestId) {
    return { state }
  }
  return { state: ComposerState.idle() }
}

function cancelInteraction(interaction: ActiveInteraction): TransitionResult {
  return {
    state: ComposerState.idle(),
    effect: {
      _tag: "DispatchInteractionResult",
      interaction,
      result: { approved: false },
    },
  }
}
