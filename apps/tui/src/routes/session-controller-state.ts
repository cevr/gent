import type { QueueEntryInfo } from "@gent/sdk"

export type QueueState = {
  steering: readonly QueueEntryInfo[]
  followUp: readonly QueueEntryInfo[]
}

export type AuthGateState = "checking" | "open" | "closed" | "error"

export interface SessionControllerState {
  readonly authGate: AuthGateState
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
}): SessionControllerState => ({
  authGate: !input.debugMode && (input.missingAuthProviders?.length ?? 0) > 0 ? "open" : "closed",
  ...(input.agent !== undefined ? { validatedAgent: input.agent } : {}),
  authCheckVersion: 0,
  queue: emptyQueueState(),
  elapsed: 0,
})

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
): SessionControllerState =>
  input.version !== state.authCheckVersion
    ? state
    : {
        ...state,
        validatedAgent: input.agent,
        authGate: input.missing ? "open" : "closed",
      }

export const failAuthCheck = (
  state: SessionControllerState,
  version: number,
): SessionControllerState =>
  version !== state.authCheckVersion
    ? state
    : {
        ...state,
        validatedAgent: undefined,
        authGate: "error",
      }

export const closeAuthGate = (
  state: SessionControllerState,
  agent: string | undefined,
): SessionControllerState => ({
  ...state,
  authCheckVersion: state.authCheckVersion + 1,
  ...(agent !== undefined ? { validatedAgent: agent } : { validatedAgent: undefined }),
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

export const queuedDraftText = (queue: QueueState): string | undefined => {
  const all = [...queue.steering, ...queue.followUp]
  return all.length === 0 ? undefined : all.map((entry) => entry.content).join("\n")
}

export const isBlockingAuthGate = (state: AuthGateState): boolean =>
  state === "open" || state === "error"

export const formatAuthGateError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string") return message
  }
  return String(error)
}
