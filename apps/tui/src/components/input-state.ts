/**
 * Input state machine for unified input handling
 */

import type { QuestionsAsked } from "@gent/core"

// ============================================================================
// Autocomplete Overlay
// ============================================================================

export interface AutocompleteOverlay {
  readonly type: "$" | "@" | "/"
  readonly filter: string
  readonly triggerPos: number
}

// ============================================================================
// Prompt State (for agent questions)
// ============================================================================

export interface PromptState {
  readonly requestId: string
  readonly questions: typeof QuestionsAsked.Type["questions"]
  readonly currentIndex: number
  readonly answers: readonly (readonly string[])[]
}

// ============================================================================
// Input State Union
// ============================================================================

export type InputState =
  | { readonly _tag: "normal"; readonly autocomplete: AutocompleteOverlay | null }
  | { readonly _tag: "shell" }
  | { readonly _tag: "prompt"; readonly prompt: PromptState }

// ============================================================================
// Constructors
// ============================================================================

export const InputState = {
  normal: (autocomplete: AutocompleteOverlay | null = null): InputState => ({
    _tag: "normal",
    autocomplete,
  }),
  shell: (): InputState => ({ _tag: "shell" }),
  fromQuestions: (event: typeof QuestionsAsked.Type): InputState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      questions: event.questions,
      currentIndex: 0,
      answers: [],
    },
  }),
} as const

// ============================================================================
// Input Events
// ============================================================================

export type InputEvent =
  | { readonly _tag: "TypeExclaim" }
  | { readonly _tag: "Escape" }
  | { readonly _tag: "BackspaceAtStart" }
  | {
      readonly _tag: "TriggerAutocomplete"
      readonly type: "$" | "@" | "/"
      readonly filter: string
      readonly triggerPos: number
    }
  | { readonly _tag: "CloseAutocomplete" }
  | { readonly _tag: "QuestionsAsked"; readonly event: typeof QuestionsAsked.Type }
  | { readonly _tag: "SubmitAnswer"; readonly selections: readonly string[] }

// ============================================================================
// Input Effects (side effects to execute)
// ============================================================================

export type InputEffect =
  | { readonly _tag: "ClearInput" }
  | {
      readonly _tag: "RespondPrompt"
      readonly requestId: string
      readonly answers: readonly (readonly string[])[]
    }

// ============================================================================
// Transition Function
// ============================================================================

export interface TransitionResult {
  readonly state: InputState
  readonly effect?: InputEffect
}

export function transition(state: InputState, event: InputEvent): TransitionResult {
  switch (state._tag) {
    case "normal": {
      switch (event._tag) {
        case "TypeExclaim":
          return { state: InputState.shell(), effect: { _tag: "ClearInput" } }
        case "Escape":
          if (state.autocomplete) {
            return { state: InputState.normal(null) }
          }
          return { state }
        case "TriggerAutocomplete":
          return {
            state: InputState.normal({
              type: event.type,
              filter: event.filter,
              triggerPos: event.triggerPos,
            }),
          }
        case "CloseAutocomplete":
          return { state: InputState.normal(null) }
        case "QuestionsAsked":
          return { state: InputState.fromQuestions(event.event) }
        default:
          return { state }
      }
    }

    case "shell": {
      switch (event._tag) {
        case "Escape":
          return { state: InputState.normal(), effect: { _tag: "ClearInput" } }
        case "BackspaceAtStart":
          return { state: InputState.normal() }
        case "QuestionsAsked":
          return { state: InputState.fromQuestions(event.event) }
        default:
          return { state }
      }
    }

    case "prompt": {
      const { prompt } = state
      switch (event._tag) {
        case "Escape":
          // ESC cancels prompt, returns to normal
          return { state: InputState.normal(), effect: { _tag: "ClearInput" } }
        case "SubmitAnswer": {
          const newAnswers = [...prompt.answers, event.selections]
          const nextIndex = prompt.currentIndex + 1

          if (nextIndex >= prompt.questions.length) {
            // All questions answered
            return {
              state: InputState.normal(),
              effect: {
                _tag: "RespondPrompt",
                requestId: prompt.requestId,
                answers: newAnswers,
              },
            }
          }

          // More questions
          return {
            state: {
              _tag: "prompt",
              prompt: {
                ...prompt,
                currentIndex: nextIndex,
                answers: newAnswers,
              },
            },
          }
        }
        default:
          return { state }
      }
    }
  }
}
