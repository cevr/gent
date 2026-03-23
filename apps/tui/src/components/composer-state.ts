/**
 * Prompt-only composer state.
 *
 * Shell mode, autocomplete, and history are local controller concerns.
 * This state exists only for server-driven prompt / question flows.
 */

import type {
  HandoffPresented,
  PermissionRequested,
  PromptPresented,
  Question,
  QuestionsAsked,
} from "@gent/core/domain/event.js"

export interface PromptState {
  readonly requestId: string
  readonly kind: PromptKind
  readonly questions: readonly Question[]
  readonly currentIndex: number
  readonly answers: readonly (readonly string[])[]
}

export type PromptKind = "questions" | "permission" | "prompt" | "handoff"

export type ComposerState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "prompt"; readonly prompt: PromptState }

export const ComposerState = {
  idle: (): ComposerState => ({ _tag: "idle" }),
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

export type ComposerEvent =
  | { readonly _tag: "QuestionsAsked"; readonly event: typeof QuestionsAsked.Type }
  | { readonly _tag: "PermissionRequested"; readonly event: typeof PermissionRequested.Type }
  | { readonly _tag: "PromptPresented"; readonly event: typeof PromptPresented.Type }
  | { readonly _tag: "HandoffPresented"; readonly event: typeof HandoffPresented.Type }
  | { readonly _tag: "SubmitAnswer"; readonly selections: readonly string[] }

export type ComposerEffect = {
  readonly _tag: "RespondPrompt"
  readonly kind: PromptKind
  readonly requestId: string
  readonly answers: readonly (readonly string[])[]
}

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

const transitionPrompt = (
  state: Extract<ComposerState, { _tag: "prompt" }>,
  event: ComposerEvent,
): TransitionResult => {
  const { prompt } = state

  if (event._tag !== "SubmitAnswer") {
    const promptTransition = transitionToPrompt(event)
    return promptTransition ?? { state }
  }

  const nextAnswers = [...prompt.answers, event.selections]
  const nextIndex = prompt.currentIndex + 1

  if (nextIndex >= prompt.questions.length) {
    return {
      state: ComposerState.idle(),
      effect: {
        _tag: "RespondPrompt",
        kind: prompt.kind,
        requestId: prompt.requestId,
        answers: nextAnswers,
      },
    }
  }

  return {
    state: {
      _tag: "prompt",
      prompt: {
        ...prompt,
        currentIndex: nextIndex,
        answers: nextAnswers,
      },
    },
  }
}

export function transition(state: ComposerState, event: ComposerEvent): TransitionResult {
  if (state._tag === "prompt") {
    return transitionPrompt(state, event)
  }

  return transitionToPrompt(event) ?? { state }
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
  const reason = event.reason !== undefined && event.reason.length > 0 ? ` (${event.reason})` : ""
  const summary = event.summary.length > 200 ? event.summary.slice(0, 200) + "..." : event.summary

  return {
    question: `Handoff to new session?${reason}`,
    header: "Handoff",
    markdown: summary,
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
