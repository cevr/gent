import {
  createContext,
  useContext,
  createEffect,
  createSignal,
  onMount,
  onCleanup,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Effect, Stream, Runtime, Schema } from "effect"
import {
  AgentName as AgentNameSchema,
  calculateCost,
  resolveAgentModelId,
  type AgentEvent,
  type AgentName,
  type EventEnvelope,
  type Model,
} from "@gent/core"
import type { GentRpcError } from "@gent/server"
import { tuiLog, tuiEvent, tuiError, clearUnifiedLog } from "../utils/unified-tracer"
import { formatError } from "../utils/format-error"

import {
  type GentClient,
  type GentRpcClient,
  type DirectClient,
  type MessageInfoReadonly,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SteerCommand,
  createClient,
} from "@gent/sdk"

// Event listener type
type EventListener = (event: AgentEvent) => void

type SteerCommandInput =
  | { _tag: "Cancel" }
  | { _tag: "Interrupt" }
  | { _tag: "Interject"; message: string }
  | { _tag: "SwitchAgent"; agent: AgentName }

const resolveModelInfo = (models: Record<string, Model>, agent: AgentName): Model | undefined =>
  models[resolveAgentModelId(agent)]

// =============================================================================
// Session State
// =============================================================================

export interface Session {
  sessionId: string
  branchId: string
  name: string
  bypass: boolean
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
  agent: AgentName
  status: AgentStatus
  cost: number
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
  agent: () => AgentName
  agentStatus: () => AgentStatus
  cost: () => number
  model: () => string
  // Derived accessors
  isStreaming: () => boolean
  isError: () => boolean
  error: () => string | null

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void

  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string) => void
  createSession: (firstMessage?: string) => void
  switchSession: (sessionId: string, branchId: string, name: string, bypass?: boolean) => void
  clearSession: () => void
  updateSessionBypass: (bypass: boolean) => Effect.Effect<void, GentRpcError>

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: () => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>
  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>
  listBranches: () => Effect.Effect<readonly BranchInfo[], GentRpcError>
  createBranch: (name?: string) => Effect.Effect<string, GentRpcError>
  getBranchTree: () => Effect.Effect<readonly BranchTreeNode[], GentRpcError>
  forkBranch: (messageId: string, name?: string) => Effect.Effect<string, GentRpcError>
  compactBranch: () => Effect.Effect<void, GentRpcError>

  // Branch navigation (fire-and-forget)
  switchBranch: (branchId: string, summarize?: boolean) => void

  // Event subscription (for message updates - agent state handled internally)
  subscribeEvents: (onEvent: (event: AgentEvent) => void) => () => void

  // Steering (fire-and-forget)
  steer: (command: SteerCommandInput) => void
}

const ClientContext = createContext<ClientContextValue>()

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (ctx === undefined) throw new Error("useClient must be used within ClientProvider")
  return ctx
}

// =============================================================================
// Provider
// =============================================================================

interface ClientProviderProps extends ParentProps {
  rpcClient: GentRpcClient | DirectClient
  runtime: Runtime.Runtime<unknown>
  initialSession: Session | undefined
}

export function ClientProvider(props: ClientProviderProps) {
  clearUnifiedLog()
  tuiLog("ClientProvider init")

  const defaultAgent: AgentName = "cowork"

  // DirectClient already has the right shape, use it directly
  // For GentRpcClient, wrap with createClient
  const client: GentClient =
    "runtime" in props.rpcClient &&
    typeof (props.rpcClient as DirectClient).createSession === "function"
      ? (props.rpcClient as unknown as GentClient)
      : createClient(props.rpcClient as GentRpcClient, props.runtime)

  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    Runtime.runFork(client.runtime)(effect)
  }

  onMount(() => {
    cast(
      client.listModels().pipe(
        Effect.tap((models) =>
          Effect.sync(() => {
            const modelsById: Record<string, Model> = {}
            for (const model of models) modelsById[model.id] = model
            setModelStore({ modelsById })
          }),
        ),
        Effect.catchAll(() => Effect.void),
      ),
    )
  })

  // Session state
  const [sessionStore, setSessionStore] = createStore<{ sessionState: SessionState }>({
    sessionState:
      props.initialSession !== undefined
        ? { status: "active", session: props.initialSession }
        : { status: "none" },
  })

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    agent: defaultAgent,
    status: AgentStatus.idle(),
    cost: 0,
  })
  const [preferredAgent, setPreferredAgent] = createSignal<AgentName>(defaultAgent)

  const [modelStore, setModelStore] = createStore<{
    modelsById: Record<string, Model>
  }>({
    modelsById: {},
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
  const eventBuffer: EventEnvelope[] = []
  const EVENT_BUFFER_LIMIT = 1000

  // Subscribe to events when session becomes active - SINGLE shared subscription
  createEffect(() => {
    const s = session()
    if (s === null) {
      eventBuffer.length = 0
      return
    }

    tuiLog(`event subscription: ${s.sessionId}`)
    let cancelled = false
    eventBuffer.length = 0

    cast(
      Effect.gen(function* () {
        const snapshot = yield* client.getSessionState({
          sessionId: s.sessionId,
          branchId: s.branchId,
        })

        yield* Effect.sync(() => {
          setAgentStore(
            produce((draft) => {
              draft.agent = snapshot.agent ?? defaultAgent
              draft.status = snapshot.isStreaming ? AgentStatus.streaming() : AgentStatus.idle()
            }),
          )
          if (snapshot.bypass !== undefined) {
            setSessionStore(
              produce((draft) => {
                if (draft.sessionState.status === "active") {
                  draft.sessionState.session.bypass = snapshot.bypass ?? true
                }
              }),
            )
          }
        })

        const events = client.subscribeEvents({
          sessionId: s.sessionId,
          branchId: s.branchId,
          ...(snapshot.lastEventId !== null ? { after: snapshot.lastEventId } : {}),
        })

        yield* Stream.runForEach(events, (envelope: EventEnvelope) =>
          Effect.sync(() => {
            if (cancelled) return

            eventBuffer.push(envelope)
            if (eventBuffer.length > EVENT_BUFFER_LIMIT) {
              eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_LIMIT)
            }

            const event = envelope.event
            tuiEvent(`event: ${event._tag}`)

            // Update agent state based on events
            switch (event._tag) {
              case "StreamStarted":
                setAgentStore({ status: AgentStatus.streaming() })
                break

              case "StreamEnded":
                setAgentStore({ status: AgentStatus.idle() })
                if (event.usage !== undefined) {
                  const modelInfo = resolveModelInfo(modelStore.modelsById, agentStore.agent)
                  const turnCost = calculateCost(event.usage, modelInfo?.pricing)
                  setAgentStore(
                    produce((draft) => {
                      draft.cost += turnCost
                    }),
                  )
                }
                break

              case "ErrorOccurred":
                tuiError("ErrorOccurred", event.error)
                setAgentStore({ status: AgentStatus.error(event.error) })
                break

              case "AgentSwitched":
                if (Schema.is(AgentNameSchema)(event.toAgent)) {
                  setPreferredAgent(event.toAgent)
                  setAgentStore({ agent: event.toAgent })
                } else {
                  setAgentStore({ agent: defaultAgent })
                }
                break

              case "MessageReceived":
                if (event.role === "user") {
                  setAgentStore({ status: AgentStatus.streaming() })
                } else if (event.role === "assistant") {
                  setAgentStore({ status: AgentStatus.idle() })
                }
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

              case "BranchSwitched":
                if (event.sessionId === s.sessionId) {
                  setSessionStore(
                    produce((draft) => {
                      if (draft.sessionState.status === "active") {
                        draft.sessionState.session.branchId = event.toBranchId
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
        )
      }).pipe(
        // Catch stream errors and surface them to UI
        Effect.catchAll((err) =>
          Effect.sync(() => {
            if (!cancelled) {
              tuiError("stream error", formatError(err))
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }
          }),
        ),
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
    agent: () => agentStore.agent,
    agentStatus: () => agentStore.status,
    cost: () => agentStore.cost,
    model: () => resolveAgentModelId(agentStore.agent),
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "streaming",
    isError: () => agentStore.status._tag === "error",
    error: () => (agentStore.status._tag === "error" ? agentStore.status.error : null),

    // Agent state setters (for local errors only)
    setError: (error) =>
      setAgentStore({ status: error !== null ? AgentStatus.error(error) : AgentStatus.idle() }),

    // Fire-and-forget actions using cast
    sendMessage: (content) => {
      const s = session()

      // Session required for sending messages
      if (s === null) return

      cast(
        client.sendMessage({
          sessionId: s.sessionId,
          branchId: s.branchId,
          content,
        }),
      )
    },

    createSession: (firstMessage) => {
      setSessionStore({ sessionState: { status: "loading", creating: true } })
      cast(
        client.createSession(firstMessage !== undefined ? { firstMessage } : undefined).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              tuiLog(`createSession success: ${result.sessionId}`)
              setSessionStore({
                sessionState: {
                  status: "active",
                  session: {
                    sessionId: result.sessionId,
                    branchId: result.branchId,
                    name: result.name,
                    bypass: result.bypass,
                  },
                },
              })
              const preferred = preferredAgent()
              if (preferred !== defaultAgent) {
                setAgentStore({ agent: preferred })
                cast(
                  client.steer({
                    _tag: "SwitchAgent",
                    sessionId: result.sessionId,
                    branchId: result.branchId,
                    agent: preferred,
                  }),
                )
              }
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              tuiError("createSession", err)
              setSessionStore({ sessionState: { status: "none" } })
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }),
          ),
        ),
      )
    },

    switchSession: (sessionId, branchId, name, bypass) => {
      const current = session()
      if (current !== null) {
        setSessionStore({
          sessionState: { status: "switching", fromSession: current, toSessionId: sessionId },
        })
      } else {
        setSessionStore({ sessionState: { status: "loading", creating: false } })
      }

      // Switch to new session - reset agent state
      setAgentStore({ agent: defaultAgent, status: AgentStatus.idle(), cost: 0 })
      setSessionStore({
        sessionState: {
          status: "active",
          session: {
            sessionId,
            branchId,
            name,
            bypass: bypass ?? true,
          },
        },
      })
    },

    clearSession: () => {
      setSessionStore({ sessionState: { status: "none" } })
      setAgentStore({ agent: preferredAgent(), status: AgentStatus.idle(), cost: 0 })
    },

    // Return Effects for caller to run
    listMessages: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly MessageInfoReadonly[])
      return client.listMessages(s.branchId)
    },

    listSessions: () => client.listSessions(),

    listBranches: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly BranchInfo[])
      return client.listBranches(s.sessionId)
    },

    updateSessionBypass: (bypass) => {
      const s = session()
      if (s === null) return Effect.succeed(undefined)
      return client.updateSessionBypass(s.sessionId, bypass).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setSessionStore(
              produce((draft) => {
                if (draft.sessionState.status === "active") {
                  draft.sessionState.session.bypass = result.bypass
                }
              }),
            )
          }),
        ),
        Effect.asVoid,
      )
    },

    createBranch: (name) => {
      const s = session()
      if (s === null) return Effect.succeed("" as string)
      return client.createBranch(s.sessionId, name)
    },

    getBranchTree: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly BranchTreeNode[])
      return client.getBranchTree(s.sessionId)
    },

    forkBranch: (messageId, name) => {
      const s = session()
      if (s === null) return Effect.succeed("" as string)
      return client
        .forkBranch({
          sessionId: s.sessionId,
          fromBranchId: s.branchId,
          atMessageId: messageId,
          ...(name !== undefined ? { name } : {}),
        })
        .pipe(Effect.map((result) => result.branchId))
    },

    compactBranch: () => {
      const s = session()
      if (s === null) return Effect.void
      return client.compactBranch({ sessionId: s.sessionId, branchId: s.branchId })
    },

    // Event subscription for message updates (shared with internal agent state subscription)
    subscribeEvents: (onEvent) => {
      const lastId = eventBuffer[eventBuffer.length - 1]?.id
      eventListeners.add(onEvent)
      if (lastId !== undefined) {
        for (const env of eventBuffer) {
          if (env.id <= lastId) {
            onEvent(env.event)
          }
        }
      }
      return () => {
        eventListeners.delete(onEvent)
      }
    },

    // Fire-and-forget steering
    steer: (command) => {
      if (command._tag === "SwitchAgent") {
        setPreferredAgent(command.agent)
      }
      const s = session()
      if (s === null) {
        if (command._tag === "SwitchAgent") {
          setAgentStore({ agent: command.agent })
        }
        return
      }
      const fullCommand: SteerCommand = {
        ...command,
        sessionId: s.sessionId,
        branchId: s.branchId,
      }
      // Update local agent immediately for responsive UI
      if (fullCommand._tag === "SwitchAgent") {
        setAgentStore({ agent: fullCommand.agent })
      }
      cast(client.steer(fullCommand))
    },

    switchBranch: (branchId, summarize) => {
      const s = session()
      if (s === null) return

      cast(
        client
          .switchBranch({
            sessionId: s.sessionId,
            fromBranchId: s.branchId,
            toBranchId: branchId,
            ...(summarize !== undefined ? { summarize } : {}),
          })
          .pipe(
            Effect.tapError((err) =>
              Effect.sync(() => {
                setAgentStore({ status: AgentStatus.error(formatError(err)) })
              }),
            ),
          ),
      )
    },
  }

  return <ClientContext.Provider value={value}>{props.children}</ClientContext.Provider>
}
