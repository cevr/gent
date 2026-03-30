/**
 * Composer state — raw interaction events, no normalization.
 *
 * Shell mode, autocomplete, and history are local controller concerns.
 * This state handles server-driven interaction flows (questions, permissions, prompts, handoffs).
 */

import type {
  ActiveInteraction,
  InteractionEventTag,
  InteractionResolutionByTag,
} from "@gent/core/domain/event.js"

export type ComposerState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "interaction"; readonly interaction: ActiveInteraction }

export const ComposerState = {
  idle: (): ComposerState => ({ _tag: "idle" }),
} as const

export type ComposerEvent =
  | { readonly _tag: "EnterInteraction"; readonly interaction: ActiveInteraction }
  | {
      readonly _tag: "ResolveInteraction"
      readonly tag: InteractionEventTag
      readonly result: InteractionResolutionByTag[InteractionEventTag]
    }
  | { readonly _tag: "CancelInteraction" }
  | { readonly _tag: "DismissInteraction"; readonly requestId: string }

export type ComposerEffect = {
  readonly _tag: "DispatchInteractionResult"
  readonly interaction: ActiveInteraction
  readonly result: InteractionResolutionByTag[InteractionEventTag]
}

export interface TransitionResult {
  readonly state: ComposerState
  readonly effect?: ComposerEffect
}

export function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  switch (event._tag) {
    case "EnterInteraction":
      return { state: { _tag: "interaction", interaction: event.interaction } }

    case "ResolveInteraction":
      if (state._tag !== "interaction") return { state }
      return {
        state: ComposerState.idle(),
        effect: {
          _tag: "DispatchInteractionResult",
          interaction: state.interaction,
          result: event.result,
        },
      }

    case "CancelInteraction":
      if (state._tag !== "interaction") return { state }
      // Cancel resolves with the tag-specific cancel variant
      return cancelInteraction(state.interaction)

    case "DismissInteraction":
      if (state._tag !== "interaction") return { state }
      if (!("requestId" in state.interaction) || state.interaction.requestId !== event.requestId) {
        return { state }
      }
      return { state: ComposerState.idle() }
  }
}

function cancelInteraction(interaction: ActiveInteraction): TransitionResult {
  switch (interaction._tag) {
    case "QuestionsAsked":
      return {
        state: ComposerState.idle(),
        effect: {
          _tag: "DispatchInteractionResult",
          interaction,
          result: { _tag: "cancelled" },
        },
      }
    case "PermissionRequested":
      return {
        state: ComposerState.idle(),
        effect: {
          _tag: "DispatchInteractionResult",
          interaction,
          result: { _tag: "deny", persist: false },
        },
      }
    case "PromptPresented":
      return {
        state: ComposerState.idle(),
        effect: {
          _tag: "DispatchInteractionResult",
          interaction,
          result: { _tag: "no" },
        },
      }
    case "HandoffPresented":
      return {
        state: ComposerState.idle(),
        effect: {
          _tag: "DispatchInteractionResult",
          interaction,
          result: { _tag: "reject" },
        },
      }
  }
}
