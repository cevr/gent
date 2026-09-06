import { Option, Predicate } from "effect"
import type { QueueEntryInfo } from "@gent/sdk"

export type QueueState = {
  steering: readonly QueueEntryInfo[]
  followUp: readonly QueueEntryInfo[]
}

export type AuthGateState = "checking" | "open" | "closed" | "error"

export interface SessionControllerState {
  readonly authGate: AuthGateState
  // eslint-disable-next-line effect/noNullish -- reducer consumers expose the validated agent as an optional snapshot field.
  readonly validatedAgent?: string
  readonly authCheckVersion: number
  readonly queue: QueueState
  readonly elapsed: number
}

const emptyQueueState = (): QueueState => ({ steering: [], followUp: [] })

export const initialSessionControllerState = (input: {
  readonly debugMode?: boolean
  readonly missingAuthProviders?: readonly string[]
  readonly agent?: string
}): SessionControllerState => {
  const missingProviders = Option.fromNullishOr(input.missingAuthProviders)
  let authGate: AuthGateState = "closed"
  if (
    input.debugMode !== true &&
    Option.isSome(missingProviders) &&
    missingProviders.value.length > 0
  ) {
    authGate = "open"
  }
  const state: SessionControllerState = {
    authGate,
    authCheckVersion: 0,
    queue: emptyQueueState(),
    elapsed: 0,
  }
  const agent = Option.fromNullishOr(input.agent)
  return Option.match(agent, {
    onNone: () => state,
    onSome: (value) => ({ ...state, validatedAgent: value }),
  })
}

export const beginAuthCheck = (state: SessionControllerState): SessionControllerState => ({
  ...state,
  authGate: "checking",
  authCheckVersion: state.authCheckVersion + 1,
})

export const completeAuthCheck = (
  state: SessionControllerState,
  input: {
    readonly version: number
    readonly agent: string
    readonly missing: boolean
  },
): SessionControllerState => {
  if (input.version !== state.authCheckVersion) return state
  let authGate: AuthGateState = "closed"
  if (input.missing) authGate = "open"
  return { ...state, validatedAgent: input.agent, authGate }
}

export const failAuthCheck = (
  state: SessionControllerState,
  version: number,
): SessionControllerState => {
  if (version !== state.authCheckVersion) return state
  return {
    ...state,
    validatedAgent: Option.getOrUndefined(Option.none()),
    authGate: "error",
  }
}

export const closeAuthGate = (
  state: SessionControllerState,
  // eslint-disable-next-line effect/noNullish -- auth gate closure may omit an agent override.
  agent: string | undefined,
): SessionControllerState => ({
  ...state,
  authCheckVersion: state.authCheckVersion + 1,
  validatedAgent: Option.getOrUndefined(Option.fromNullishOr(agent)),
  authGate: "closed",
})

export const setQueue = (
  state: SessionControllerState,
  queue: QueueState,
): SessionControllerState => ({
  ...state,
  queue,
})

export const clearQueue = (state: SessionControllerState): SessionControllerState =>
  setQueue(state, emptyQueueState())

export const setElapsed = (
  state: SessionControllerState,
  elapsed: number,
): SessionControllerState => ({
  ...state,
  elapsed,
})

// eslint-disable-next-line effect/noNullish -- queue projection omits text when the queue is empty.
export const queuedDraftText = (queue: QueueState): string | undefined => {
  const all = [...queue.steering, ...queue.followUp]
  if (all.length === 0) return Option.getOrUndefined(Option.none())
  return all.map((entry) => entry.content).join("\n")
}

export const isBlockingAuthGate = (state: AuthGateState): boolean =>
  state === "open" || state === "error"

// eslint-disable-next-line effect/noUnknownParameters -- auth failures cross the Effect and UI boundary.
export const formatAuthGateError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (Predicate.isObject(error) && "message" in error) {
    const message = error["message"]
    if (Predicate.isString(message)) return message
  }
  return String(error)
}
