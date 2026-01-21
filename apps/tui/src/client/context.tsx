import { createContext, useContext, createEffect, onCleanup, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Effect, Stream, Runtime } from "effect"
import { calculateCost, type AgentEvent, type AgentMode } from "@gent/core"
import {
  type GentClient,
  type GentRpcClient,
  type MessageInfoReadonly,
  type SessionInfo,
  type BranchInfo,
  createClient,
} from "../client"
import * as State from "../state"

// =============================================================================
// Session State
// =============================================================================

export interface Session {
  sessionId: string
  branchId: string
  name: string
  model: string | undefined
}

export type SessionState =
  | { status: "none" }
  | { status: "loading"; creating: boolean }
  | { status: "active"; session: Session }
  | { status: "switching"; fromSession: Session; toSessionId: string }

// =============================================================================
// Agent State (derived from events)
// =============================================================================

export type AgentStatus = "idle" | "streaming" | "error"

export interface AgentState {
  mode: AgentMode
  status: AgentStatus
  cost: number
  error: string | null
  model: string | undefined
}

// =============================================================================
// Client Context Value
// =============================================================================

export interface ClientContextValue {
  /** Underlying GentClient - returns Effects */
  client: GentClient

  // Session state (union)
  sessionState: () => SessionState
  session: () => Session | null
  isActive: () => boolean
  isLoading: () => boolean

  // Agent state (derived from events)
  mode: () => AgentMode
  agentStatus: () => AgentStatus
  cost: () => number
  error: () => string | null
  model: () => string | undefined
  isStreaming: () => boolean

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void

  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string, mode?: "plan" | "build", model?: string) => void
  createSession: (firstMessage?: string) => void
  switchSession: (sessionId: string, branchId: string, name: string, model?: string) => void
  clearSession: () => void

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: () => Effect.Effect<readonly MessageInfoReadonly[]>
  listSessions: () => Effect.Effect<readonly SessionInfo[]>
  listBranches: () => Effect.Effect<readonly BranchInfo[]>
  createBranch: (name?: string) => Effect.Effect<string>

  // Event subscription (for message updates - agent state handled internally)
  subscribeEvents: (onEvent: (event: AgentEvent) => void) => () => void

  // Steering (fire-and-forget)
  steer: (command: { _tag: "Cancel" } | { _tag: "Interrupt"; message: string } | { _tag: "SwitchModel"; model: string } | { _tag: "SwitchMode"; mode: "build" | "plan" }) => void
}

const ClientContext = createContext<ClientContextValue>()

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (!ctx) throw new Error("useClient must be used within ClientProvider")
  return ctx
}

// =============================================================================
// Provider
// =============================================================================

interface ClientProviderProps extends ParentProps {
  rpcClient: GentRpcClient
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime context unused by RPC calls
  runtime: Runtime.Runtime<any>
  initialSession: Session | undefined
}

export function ClientProvider(props: ClientProviderProps) {
  const client = createClient(props.rpcClient, props.runtime)

  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    Runtime.runFork(client.runtime)(effect)
  }

  // Session state
  const [sessionStore, setSessionStore] = createStore<{ sessionState: SessionState }>({
    sessionState: props.initialSession
      ? { status: "active", session: props.initialSession }
      : { status: "none" },
  })

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    mode: "plan",
    status: "idle",
    cost: 0,
    error: null,
    model: props.initialSession?.model,
  })

  // Derived accessors
  const session = () => {
    const s = sessionStore.sessionState
    return s.status === "active" ? s.session : null
  }

  const isActive = () => sessionStore.sessionState.status === "active"
  const isLoading = () => sessionStore.sessionState.status === "loading"

  // Subscribe to events when session becomes active
  createEffect(() => {
    const s = session()
    if (!s) return

    let cancelled = false
    const events = client.subscribeEvents(s.sessionId)

    cast(
      Stream.runForEach(events, (event: AgentEvent) =>
        Effect.sync(() => {
          if (cancelled) return

          // Update agent state based on events
          switch (event._tag) {
            case "StreamStarted":
              setAgentStore({ status: "streaming", error: null })
              break

            case "StreamEnded":
              setAgentStore({ status: "idle" })
              if (event.usage) {
                // Get pricing for current model
                const modelInfo = agentStore.model
                  ? State.models().find((m) => m.id === agentStore.model)
                  : undefined
                const turnCost = calculateCost(event.usage, modelInfo?.pricing)
                setAgentStore(produce((draft) => {
                  draft.cost += turnCost
                }))
              }
              break

            case "ErrorOccurred":
              setAgentStore({ status: "error", error: event.error })
              break

            case "PlanModeEntered":
              setAgentStore({ mode: "plan" })
              break

            case "PlanModeExited":
              setAgentStore({ mode: "build" })
              break

            case "ModelChanged":
              setAgentStore({ model: event.model })
              setSessionStore(
                produce((draft) => {
                  if (draft.sessionState.status === "active") {
                    draft.sessionState.session.model = event.model
                  }
                }),
              )
              break

            case "SessionNameUpdated":
              if (event.sessionId === s.sessionId) {
                setSessionStore(
                  produce((draft) => {
                    if (draft.sessionState.status === "active") {
                      draft.sessionState.session.name = event.name
                    }
                  }),
                )
              }
              break
          }
        }),
      ),
    )

    onCleanup(() => {
      cancelled = true
    })
  })

  const value: ClientContextValue = {
    client,

    // Session state
    sessionState: () => sessionStore.sessionState,
    session,
    isActive,
    isLoading,

    // Agent state
    mode: () => agentStore.mode,
    agentStatus: () => agentStore.status,
    cost: () => agentStore.cost,
    error: () => agentStore.error,
    model: () => agentStore.model,
    isStreaming: () => agentStore.status === "streaming",

    // Agent state setters (for local errors only)
    setError: (error) => setAgentStore({ error }),

    // Fire-and-forget actions using cast
    sendMessage: (content, mode, model) => {
      const s = session()

      // If no session, create one first
      if (sessionStore.sessionState.status === "none") {
        setSessionStore({ sessionState: { status: "loading", creating: true } })
        cast(
          client.createSession({ firstMessage: content }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                setSessionStore({
                  sessionState: {
                    status: "active",
                    session: {
                      sessionId: result.sessionId,
                      branchId: result.branchId,
                      name: result.name,
                      model: undefined,
                    },
                  },
                })
              }),
            ),
          ),
        )
        return
      }

      if (!s) return

      cast(
        client.sendMessage({
          sessionId: s.sessionId,
          branchId: s.branchId,
          content,
          ...(mode !== undefined ? { mode } : {}),
          ...(model !== undefined ? { model } : {}),
        }),
      )
    },

    createSession: (firstMessage) => {
      setSessionStore({ sessionState: { status: "loading", creating: true } })
      cast(
        client.createSession(firstMessage !== undefined ? { firstMessage } : undefined).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              setSessionStore({
                sessionState: {
                  status: "active",
                  session: {
                    sessionId: result.sessionId,
                    branchId: result.branchId,
                    name: result.name,
                    model: undefined,
                  },
                },
              })
            }),
          ),
        ),
      )
    },

    switchSession: (sessionId, branchId, name, model) => {
      const current = session()
      if (current) {
        setSessionStore({
          sessionState: { status: "switching", fromSession: current, toSessionId: sessionId },
        })
      } else {
        setSessionStore({ sessionState: { status: "loading", creating: false } })
      }

      // Switch to new session - reset agent state with new model
      setAgentStore({ mode: "plan", status: "idle", cost: 0, error: null, model })
      setSessionStore({
        sessionState: { status: "active", session: { sessionId, branchId, name, model } },
      })
    },

    clearSession: () => {
      setSessionStore({ sessionState: { status: "none" } })
      setAgentStore({ mode: "plan", status: "idle", cost: 0, error: null, model: undefined })
    },

    // Return Effects for caller to run
    listMessages: () => {
      const s = session()
      if (!s) return Effect.succeed([] as readonly MessageInfoReadonly[])
      return client.listMessages(s.branchId)
    },

    listSessions: () => client.listSessions(),

    listBranches: () => {
      const s = session()
      if (!s) return Effect.succeed([] as readonly BranchInfo[])
      return client.listBranches(s.sessionId)
    },

    createBranch: (name) => {
      const s = session()
      if (!s) return Effect.succeed("" as string)
      return client.createBranch(s.sessionId, name)
    },

    // Event subscription for message updates (agent state handled internally)
    subscribeEvents: (onEvent) => {
      let cancelled = false
      const s = session()
      if (!s) return () => {}

      const events = client.subscribeEvents(s.sessionId)
      cast(
        Stream.runForEach(events, (e: AgentEvent) =>
          Effect.sync(() => {
            if (cancelled) return
            onEvent(e)
          }),
        ),
      )
      return () => {
        cancelled = true
      }
    },

    // Fire-and-forget steering
    steer: (command) => {
      // Update local mode immediately for responsive UI
      if (command._tag === "SwitchMode") {
        setAgentStore({ mode: command.mode })
      }
      cast(client.steer(command))
    },
  }

  return <ClientContext.Provider value={value}>{props.children}</ClientContext.Provider>
}
