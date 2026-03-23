/**
 * Composer state machine for unified composer handling.
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
// Composer State Union
// ============================================================================

export type ComposerState =
  | { readonly _tag: "normal"; readonly autocomplete: AutocompleteOverlay | null }
  | { readonly _tag: "shell" }
  | { readonly _tag: "prompt"; readonly prompt: PromptState }

// ============================================================================
// Constructors
// ============================================================================

export const ComposerState = {
  normal: (autocomplete: AutocompleteOverlay | null = null): ComposerState => ({
    _tag: "normal",
    autocomplete,
  }),
  shell: (): ComposerState => ({ _tag: "shell" }),
  fromQuestions: (event: typeof QuestionsAsked.Type): ComposerState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "questions",
      questions: event.questions,
      currentIndex: 0,
      answers: [],
    },
  }),
  fromPermission: (event: typeof PermissionRequested.Type): ComposerState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "permission",
      questions: [permissionQuestion(event)],
      currentIndex: 0,
      answers: [],
    },
  }),
  fromPrompt: (event: typeof PromptPresented.Type): ComposerState => ({
    _tag: "prompt",
    prompt: {
      requestId: event.requestId,
      kind: "prompt",
      questions: [promptQuestion(event)],
      currentIndex: 0,
      answers: [],
    },
  }),
  fromHandoff: (event: typeof HandoffPresented.Type): ComposerState => ({
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
// Composer Events
// ============================================================================

export type ComposerEvent =
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
// Composer Effects (side effects to execute)
// ============================================================================

export type ComposerEffect =
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
  readonly state: ComposerState
  readonly effect?: ComposerEffect
}

const transitionToPrompt = (event: ComposerEvent): TransitionResult | undefined => {
  switch (event._tag) {
    case "QuestionsAsked":
      return { state: ComposerState.fromQuestions(event.event) }
    case "PermissionRequested":
      return { state: ComposerState.fromPermission(event.event) }
    case "PromptPresented":
      return { state: ComposerState.fromPrompt(event.event) }
    case "HandoffPresented":
      return { state: ComposerState.fromHandoff(event.event) }
    default:
      return undefined
  }
}

const transitionNormal = (
  state: Extract<ComposerState, { _tag: "normal" }>,
  event: ComposerEvent,
): TransitionResult => {
  const promptTransition = transitionToPrompt(event)
  if (promptTransition !== undefined) return promptTransition

  switch (event._tag) {
    case "TypeExclaim":
      return { state: ComposerState.shell(), effect: { _tag: "ClearInput" } }
    case "Escape":
      return state.autocomplete !== null ? { state: ComposerState.normal(null) } : { state }
    case "TriggerAutocomplete":
      return {
        state: ComposerState.normal({
          type: event.type,
          filter: event.filter,
          triggerPos: event.triggerPos,
        }),
      }
    case "CloseAutocomplete":
      return { state: ComposerState.normal(null) }
    default:
      return { state }
  }
}

const transitionShell = (
  state: Extract<ComposerState, { _tag: "shell" }>,
  event: ComposerEvent,
): TransitionResult => {
  const promptTransition = transitionToPrompt(event)
  if (promptTransition !== undefined) return promptTransition

  switch (event._tag) {
    case "Escape":
      return { state: ComposerState.normal(), effect: { _tag: "ClearInput" } }
    case "BackspaceAtStart":
      return { state: ComposerState.normal() }
    default:
      return { state }
  }
}

const transitionPrompt = (
  state: Extract<ComposerState, { _tag: "prompt" }>,
  event: ComposerEvent,
): TransitionResult => {
  const { prompt } = state
  switch (event._tag) {
    case "Escape":
      return { state: ComposerState.normal(), effect: { _tag: "ClearInput" } }
    case "SubmitAnswer": {
      const newAnswers = [...prompt.answers, event.selections]
      const nextIndex = prompt.currentIndex + 1

      if (nextIndex >= prompt.questions.length) {
        return {
          state: ComposerState.normal(),
          effect: {
            _tag: "RespondPrompt",
            kind: prompt.kind,
            requestId: prompt.requestId,
            answers: newAnswers,
          },
        }
      }

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

export function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  switch (state._tag) {
    case "normal":
      return transitionNormal(state, event)
    case "shell":
      return transitionShell(state, event)
    case "prompt":
      return transitionPrompt(state, event)
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
