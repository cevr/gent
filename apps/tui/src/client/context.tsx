import { createContext, useContext, createEffect, onCleanup, type ParentProps, DEV } from "solid-js"
import { createStore, produce, DEV as STORE_DEV } from "solid-js/store"
import { Effect, Stream, Runtime } from "effect"
import { calculateCost, type AgentEvent, type AgentMode } from "@gent/core"
import type { GentRpcError } from "@gent/server"
import { log, logEvent, logError, clearLog } from "../utils/log"
import { formatError } from "../utils/format-error"

// Setup Solid dev hooks for tracing
if (DEV) {
  DEV.hooks.afterUpdate = () => log("solid: afterUpdate")
  DEV.hooks.afterCreateOwner = (owner) => log(`solid: createOwner ${owner.name ?? "anonymous"}`)
}
if (STORE_DEV) {
  STORE_DEV.hooks.onStoreNodeUpdate = (_state, prop, value) =>
    log(`store: ${String(prop)} = ${JSON.stringify(value)}`)
}

import {
  type GentClient,
  type GentRpcClient,
  type MessageInfoReadonly,
  type SessionInfo,
  type BranchInfo,
  createClient,
} from "../client"
import * as State from "../state"

// Event listener type
type EventListener = (event: AgentEvent) => void

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
// Agent State (derived from events) - discriminated union
// =============================================================================

export type AgentStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "streaming" }
  | { readonly _tag: "error"; readonly error: string }

export const AgentStatus = {
  idle: (): AgentStatus => ({ _tag: "idle" }),
  streaming: (): AgentStatus => ({ _tag: "streaming" }),
  error: (error: string): AgentStatus => ({ _tag: "error", error }),
} as const

export interface AgentState {
  mode: AgentMode
  status: AgentStatus
  cost: number
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
  model: () => string | undefined
  // Derived accessors
  isStreaming: () => boolean
  isError: () => boolean
  error: () => string | null

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void

  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string, mode?: "plan" | "build", model?: string) => void
  createSession: (firstMessage?: string) => void
  switchSession: (sessionId: string, branchId: string, name: string, model?: string) => void
  clearSession: () => void

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: () => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>
  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>
  listBranches: () => Effect.Effect<readonly BranchInfo[], GentRpcError>
  createBranch: (name?: string) => Effect.Effect<string, GentRpcError>

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
  runtime: Runtime.Runtime<unknown>
  initialSession: Session | undefined
}

export function ClientProvider(props: ClientProviderProps) {
  clearLog()
  log("ClientProvider init")

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
    status: AgentStatus.idle(),
    cost: 0,
    model: props.initialSession?.model,
  })

  // Derived accessors
  const session = () => {
    const s = sessionStore.sessionState
    return s.status === "active" ? s.session : null
  }

  const isActive = () => sessionStore.sessionState.status === "active"
  const isLoading = () => sessionStore.sessionState.status === "loading"

  // External event listeners (for components like session.tsx)
  const eventListeners = new Set<EventListener>()

  // Subscribe to events when session becomes active - SINGLE shared subscription
  createEffect(() => {
    const s = session()
    if (!s) {
      log("event subscription: no session")
      return
    }

    log(`event subscription: ${s.sessionId}`)
    let cancelled = false
    const events = client.subscribeEvents(s.sessionId)

    cast(
      Stream.runForEach(events, (event: AgentEvent) =>
        Effect.sync(() => {
          if (cancelled) return

          logEvent(`event: ${event._tag}`)

          // Update agent state based on events
          switch (event._tag) {
            case "StreamStarted":
              setAgentStore({ status: AgentStatus.streaming() })
              break

            case "StreamEnded":
              setAgentStore({ status: AgentStatus.idle() })
              if (event.usage) {
                // Get pricing from UI-selected model (State) or session model
                const modelInfo = agentStore.model
                  ? State.models().find((m) => m.id === agentStore.model)
                  : State.currentModelInfo()
                const turnCost = calculateCost(event.usage, modelInfo?.pricing)
                setAgentStore(produce((draft) => {
                  draft.cost += turnCost
                }))
              }
              break

            case "ErrorOccurred":
              logError("ErrorOccurred", event.error)
              setAgentStore({ status: AgentStatus.error(event.error) })
              break

            case "PlanModeEntered":
              setAgentStore({ mode: "plan" })
              break

            case "PlanConfirmed":
              setAgentStore({ mode: "build" })
              break

            case "PlanRejected":
              setAgentStore({ mode: "plan" })
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

          // Notify external listeners
          for (const listener of eventListeners) {
            listener(event)
          }
        }),
      ).pipe(
        // Catch stream errors and surface them to UI
        Effect.catchAll((err) =>
          Effect.sync(() => {
            if (!cancelled) {
              logError("stream error", formatError(err))
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }
          }),
        ),
      ),
    )

    onCleanup(() => {
      log("event subscription cleanup")
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
    model: () => agentStore.model,
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "streaming",
    isError: () => agentStore.status._tag === "error",
    error: () => (agentStore.status._tag === "error" ? agentStore.status.error : null),

    // Agent state setters (for local errors only)
    setError: (error) =>
      setAgentStore({ status: error ? AgentStatus.error(error) : AgentStatus.idle() }),

    // Fire-and-forget actions using cast
    sendMessage: (content, mode, model) => {
      log(`sendMessage: ${content.slice(0, 50)}...`)
      const s = session()

      // If no session, create one first (server sends firstMessage automatically)
      if (sessionStore.sessionState.status === "none") {
        log("sendMessage: creating session with firstMessage")
        setSessionStore({ sessionState: { status: "loading", creating: true } })
        cast(
          client.createSession({ firstMessage: content }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                log(`sendMessage: session created ${result.sessionId}`)
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
            Effect.catchAll((err) =>
              Effect.sync(() => {
                logError("sendMessage", formatError(err))
                setSessionStore({ sessionState: { status: "none" } })
                setAgentStore({ status: AgentStatus.error(formatError(err)) })
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
          Effect.catchAll((err) =>
            Effect.sync(() => {
              setSessionStore({ sessionState: { status: "none" } })
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
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
      setAgentStore({ mode: "plan", status: AgentStatus.idle(), cost: 0, model })
      setSessionStore({
        sessionState: { status: "active", session: { sessionId, branchId, name, model } },
      })
    },

    clearSession: () => {
      setSessionStore({ sessionState: { status: "none" } })
      setAgentStore({ mode: "plan", status: AgentStatus.idle(), cost: 0, model: undefined })
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

    // Event subscription for message updates (shared with internal agent state subscription)
    subscribeEvents: (onEvent) => {
      eventListeners.add(onEvent)
      return () => {
        eventListeners.delete(onEvent)
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
