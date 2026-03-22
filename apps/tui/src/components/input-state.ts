/**
 * Input state machine for unified input handling
 */

import type {
  QuestionsAsked,
  PermissionRequested,
  PromptPresented,
  HandoffPresented,
  Question,
} from "@gent/core/domain/event.js"

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
  readonly kind: PromptKind
  readonly questions: readonly Question[]
  readonly currentIndex: number
  readonly answers: readonly (readonly string[])[]
}

export type PromptKind = "questions" | "permission" | "prompt" | "handoff"

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
      kind: "questions",
      questions: event.questions,
      currentIndex: 0,
      answers: [],
    },
  }),
  fromPermission: (event: typeof PermissionRequested.Type): InputState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "permission",
      questions: [permissionQuestion(event)],
      currentIndex: 0,
      answers: [],
    },
  }),
  fromPrompt: (event: typeof PromptPresented.Type): InputState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "prompt",
      questions: [promptQuestion(event)],
      currentIndex: 0,
      answers: [],
    },
  }),
  fromHandoff: (event: typeof HandoffPresented.Type): InputState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "handoff",
      questions: [handoffQuestion(event)],
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
  | { readonly _tag: "PermissionRequested"; readonly event: typeof PermissionRequested.Type }
  | { readonly _tag: "PromptPresented"; readonly event: typeof PromptPresented.Type }
  | { readonly _tag: "HandoffPresented"; readonly event: typeof HandoffPresented.Type }
  | { readonly _tag: "SubmitAnswer"; readonly selections: readonly string[] }

// ============================================================================
// Input Effects (side effects to execute)
// ============================================================================

export type InputEffect =
  | { readonly _tag: "ClearInput" }
  | {
      readonly _tag: "RespondPrompt"
      readonly kind: PromptKind
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
          if (state.autocomplete !== null) {
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
        case "PermissionRequested":
          return { state: InputState.fromPermission(event.event) }
        case "PromptPresented":
          return { state: InputState.fromPrompt(event.event) }
        case "HandoffPresented":
          return { state: InputState.fromHandoff(event.event) }
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
        case "PermissionRequested":
          return { state: InputState.fromPermission(event.event) }
        case "PromptPresented":
          return { state: InputState.fromPrompt(event.event) }
        case "HandoffPresented":
          return { state: InputState.fromHandoff(event.event) }
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
                kind: prompt.kind,
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

const summarizeInput = (input: unknown): string => {
  if (input === null || input === undefined) return ""
  const raw = typeof input === "string" ? input : JSON.stringify(input)
  return raw.length > 120 ? raw.slice(0, 120) + "..." : raw
}

const permissionQuestion = (event: typeof PermissionRequested.Type): Question => {
  const summary = summarizeInput(event.input)
  const question =
    summary.length > 0 ? `Allow ${event.toolName} (${summary})?` : `Allow ${event.toolName}?`
  return {
    question,
    header: "Permission",
    options: [
      { label: "Allow" },
      { label: "Always Allow" },
      { label: "Deny" },
      { label: "Always Deny" },
    ],
    multiple: false,
  }
}

const handoffQuestion = (event: typeof HandoffPresented.Type): Question => {
  const reasonStr =
    event.reason !== undefined && event.reason.length > 0 ? ` (${event.reason})` : ""
  const summaryPreview =
    event.summary.length > 200 ? event.summary.slice(0, 200) + "..." : event.summary
  return {
    question: `Handoff to new session?${reasonStr}`,
    header: "Handoff",
    markdown: summaryPreview,
    options: [{ label: "Yes" }, { label: "No" }],
    multiple: false,
  }
}

const promptQuestion = (event: typeof PromptPresented.Type): Question => {
  const title = event.title ?? (event.path !== undefined ? `Review: ${event.path}` : "Review")
  const options =
    event.mode === "review"
      ? [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
      : [{ label: "Yes" }, { label: "No" }]
  return {
    question: title,
    header: "Prompt",
    ...(event.content !== undefined && event.content.length > 0 ? { markdown: event.content } : {}),
    options,
    multiple: false,
  }
}
