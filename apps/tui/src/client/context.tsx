import {
  createContext,
  useContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onMount,
  onCleanup,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Effect, Fiber, Stream, Schema } from "effect"
import {
  AgentName as AgentNameSchema,
  Agents,
  resolveAgentModel,
  type AgentName,
  type ReasoningEffort,
} from "@gent/core/domain/agent.js"
import { calculateCost, type Model } from "@gent/core/domain/model.js"
import type { EventEnvelope } from "@gent/core/domain/event.js"
import type { BranchId, MessageId, SessionId } from "@gent/core/domain/ids.js"
import { tuiError } from "../utils/unified-tracer"
import { clientLog } from "../utils/client-logger"
import { formatConnectionIssue, formatError } from "../utils/format-error"
import { runWithReconnect } from "../utils/run-with-reconnect"
import {
  type WorkerLifecycleState,
  type WorkerSupervisor,
  waitForWorkerRunning,
} from "../worker/supervisor"
import { reduceAgentLifecycle } from "./agent-lifecycle"

import {
  type GentClient,
  type GentRpcError,
  type MessageInfoReadonly,
  type QueueSnapshot,
  type SessionInfo,
  type BranchInfo,
  type BranchTreeNode,
  type SessionTreeNode,
  type SteerCommand,
} from "@gent/sdk"
import { SessionState, transitionSessionState, type Session } from "./session-state"

type SteerCommandInput =
  | { _tag: "Cancel" }
  | { _tag: "Interrupt" }
  | { _tag: "Interject"; message: string; agent?: AgentName }
  | { _tag: "SwitchAgent"; agent: AgentName }

const resolveModelInfo = (models: Record<string, Model>, agent: AgentName): Model | undefined => {
  const agentDef = (Agents as Record<string, typeof Agents.cowork>)[agent]
  return agentDef !== undefined ? models[resolveAgentModel(agentDef)] : undefined
}

export type { Session, SessionState } from "./session-state"

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
  latestInputTokens: () => number
  modelInfo: () => Model | undefined
  workerState: () => WorkerLifecycleState | undefined
  waitForWorkerRunning: () => Effect.Effect<void>
  isReconnecting: () => boolean
  workerRestartCount: () => number
  connectionIssue: () => string | null

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void
  setConnectionIssue: (error: string | null) => void

  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string) => void
  createSession: (firstMessage?: string) => void
  switchSession: (sessionId: SessionId, branchId: BranchId, name: string, bypass?: boolean) => void
  clearSession: () => void
  updateSessionBypass: (bypass: boolean) => Effect.Effect<void, GentRpcError>
  updateSessionReasoningLevel: (
    reasoningLevel: ReasoningEffort | undefined,
  ) => Effect.Effect<void, GentRpcError>

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: () => Effect.Effect<readonly MessageInfoReadonly[], GentRpcError>
  listSessions: () => Effect.Effect<readonly SessionInfo[], GentRpcError>
  listBranches: () => Effect.Effect<readonly BranchInfo[], GentRpcError>
  createBranch: (name?: string) => Effect.Effect<BranchId, GentRpcError>
  getBranchTree: () => Effect.Effect<readonly BranchTreeNode[], GentRpcError>
  getSessionTree: (sessionId: SessionId) => Effect.Effect<SessionTreeNode, GentRpcError>
  forkBranch: (messageId: MessageId, name?: string) => Effect.Effect<BranchId, GentRpcError>
  drainQueuedMessages: () => Effect.Effect<QueueSnapshot, GentRpcError>
  getQueuedMessages: () => Effect.Effect<QueueSnapshot, GentRpcError>
  // Branch navigation (fire-and-forget)
  switchBranch: (branchId: BranchId, summarize?: boolean) => void

  // Steering (fire-and-forget)
  steer: (command: SteerCommandInput) => void
}

const ClientContext = createContext<ClientContextValue>()

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (ctx === undefined) throw new Error("useClient must be used within ClientProvider")
  return ctx
}

interface ClientProviderProps extends ParentProps {
  client: GentClient
  initialSession: Session | undefined
  supervisor?: WorkerSupervisor
}

export function ClientProvider(props: ClientProviderProps) {
  const defaultAgent: AgentName = "cowork"
  const client = props.client
  const waitForTransportRunning = (): Effect.Effect<void> =>
    props.supervisor === undefined ? Effect.void : waitForWorkerRunning(props.supervisor)

  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    Effect.runForkWith(client.services)(effect)
  }

  const [sessionState, setSessionState] = createSignal<SessionState>(
    props.initialSession !== undefined
      ? SessionState.active(props.initialSession)
      : SessionState.none(),
  )
  const dispatchSession = (event: Parameters<typeof transitionSessionState>[1]) => {
    setSessionState((current) => transitionSessionState(current, event))
  }
  const session = (): Session | null => {
    const current = sessionState()
    return current.status === "active" ? current.session : null
  }
  const isActive = () => sessionState().status === "active"
  const isLoading = () => sessionState().status === "creating"

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
        Effect.catchEager(() => Effect.void),
      ),
    )
  })

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    agent: defaultAgent,
    status: AgentStatus.idle(),
    cost: 0,
  })
  const [preferredAgent, setPreferredAgent] = createSignal<AgentName>(defaultAgent)
  const [latestInputTokens, setLatestInputTokens] = createSignal(0)
  const [workerState, setWorkerState] = createSignal<WorkerLifecycleState | undefined>(
    props.supervisor?.getState(),
  )
  const [connectionIssue, setConnectionIssue] = createSignal<string | null>(null)
  const [lastSeenEventId, setLastSeenEventId] = createSignal<number | null>(null)
  const [lastSeenSessionKey, setLastSeenSessionKey] = createSignal<string | null>(null)

  const [modelStore, setModelStore] = createStore<{
    modelsById: Record<string, Model>
  }>({
    modelsById: {},
  })

  createEffect(() => {
    const supervisor = props.supervisor
    if (supervisor === undefined) return
    const unsubscribe = supervisor.subscribe((nextState) => {
      setWorkerState(nextState)
    })
    onCleanup(unsubscribe)
  })

  // Stable session key — only changes when sessionId:branchId actually changes
  const sessionKey = createMemo<string | null>(() => {
    const current = sessionState()
    if (current.status !== "active") return null
    return `${current.session.sessionId}:${current.session.branchId}`
  })

  const workerEpoch = createMemo<number | null>(() => {
    const state = workerState()
    if (state === undefined) return 0
    return state._tag === "running" ? state.restartCount : null
  })

  const isReconnecting = () => {
    const state = workerState()
    return state?._tag === "starting" || state?._tag === "restarting"
  }

  // Subscribe to events when session becomes active - SINGLE shared subscription
  // Uses on() to explicitly track only sessionKey, not other signals read inside
  createEffect(
    on([sessionKey, workerEpoch], ([key]) => {
      if (key === null) {
        setLastSeenEventId(null)
        setLastSeenSessionKey(null)
        setConnectionIssue(null)
        return
      }
      if (key !== lastSeenSessionKey()) {
        setLastSeenSessionKey(key)
        setLastSeenEventId(null)
        setConnectionIssue(null)
      }

      const sep = key.indexOf(":")
      const sessionId = key.slice(0, sep) as SessionId
      const branchId = key.slice(sep + 1) as BranchId
      let cancelled = false

      const processEvent = (envelope: EventEnvelope): void => {
        if (cancelled) return

        clientLog.debug("event.received", {
          eventId: envelope.id,
          tag: envelope.event._tag,
          traceId: envelope.traceId,
        })
        setConnectionIssue(null)

        setLastSeenEventId(envelope.id)

        const event = envelope.event

        // Update agent state based on events
        if (event._tag === "StreamEnded" && event.usage !== undefined) {
          const modelInfo = resolveModelInfo(modelStore.modelsById, agentStore.agent)
          const turnCost = calculateCost(event.usage, modelInfo?.pricing)
          setAgentStore(
            produce((draft) => {
              draft.cost += turnCost
            }),
          )
          setLatestInputTokens(event.usage.inputTokens)
        }

        if (event._tag === "ErrorOccurred") {
          clientLog.error("agent.error", { error: event.error, eventId: envelope.id })
        }

        const lifecycle = reduceAgentLifecycle(event)
        if (lifecycle.preferredAgent !== undefined) {
          if (Schema.is(AgentNameSchema)(lifecycle.preferredAgent)) {
            setPreferredAgent(lifecycle.preferredAgent)
            setAgentStore({ agent: lifecycle.preferredAgent })
          } else {
            setAgentStore({ agent: defaultAgent })
          }
        }
        if (lifecycle.status !== undefined) {
          switch (lifecycle.status._tag) {
            case "idle":
              setAgentStore({ status: AgentStatus.idle() })
              break
            case "streaming":
              setAgentStore({ status: AgentStatus.streaming() })
              break
            case "error":
              setAgentStore({ status: AgentStatus.error(lifecycle.status.error) })
              break
          }
        }

        switch (event._tag) {
          case "SessionNameUpdated":
            if (event.sessionId === sessionId) {
              dispatchSession({ _tag: "UpdateName", name: event.name })
            }
            break

          case "BranchSwitched":
            if (event.sessionId === sessionId) {
              dispatchSession({ _tag: "UpdateBranch", branchId: event.toBranchId })
            }
            break
        }
      }

      const fiber = Effect.runForkWith(client.services)(
        runWithReconnect(
          () =>
            Effect.gen(function* () {
              if (props.supervisor !== undefined && workerState()?._tag !== "running") {
                yield* waitForWorkerRunning(props.supervisor)
              }

              const snapshot = yield* client.getSessionSnapshot({ sessionId, branchId })
              const after = lastSeenEventId() ?? snapshot.lastEventId ?? undefined

              yield* Effect.sync(() => {
                setConnectionIssue(null)
                if (snapshot.bypass !== undefined) {
                  dispatchSession({ _tag: "UpdateBypass", bypass: snapshot.bypass ?? true })
                }
                if (snapshot.reasoningLevel !== undefined) {
                  dispatchSession({
                    _tag: "UpdateReasoningLevel",
                    reasoningLevel: snapshot.reasoningLevel,
                  })
                }
                // Hydrate agent state from snapshot runtime (eliminates cold-start gap)
                const rt = snapshot.runtime
                const status = rt.status === "idle" ? AgentStatus.idle() : AgentStatus.streaming()
                setAgentStore({ agent: rt.agent, status })
              })

              const events = client.streamEvents({
                sessionId,
                branchId,
                ...(after !== undefined ? { after } : {}),
              })

              yield* Stream.runForEach(events, (envelope: EventEnvelope) =>
                Effect.sync(() => {
                  try {
                    processEvent(envelope)
                  } catch (err) {
                    tuiError(
                      "event processing error",
                      err instanceof Error ? err.message : String(err),
                    )
                  }
                }),
              )
            }),
          {
            onError: (err) => {
              if (cancelled) return
              if (props.supervisor !== undefined && workerState()?._tag !== "running") return
              clientLog.error("event.subscription.failed", { error: formatError(err) })
              setConnectionIssue(formatConnectionIssue(err))
            },
            waitForRetry: waitForTransportRunning,
          },
        ),
      )

      onCleanup(() => {
        cancelled = true
        Effect.runFork(Fiber.interrupt(fiber))
      })
    }),
  )

  const value: ClientContextValue = {
    client,

    // Session state
    sessionState,
    session,
    isActive,
    isLoading,

    // Agent state
    agent: () => agentStore.agent,
    agentStatus: () => agentStore.status,
    cost: () => agentStore.cost,
    model: () => {
      const agentDef = (Agents as Record<string, typeof Agents.cowork>)[agentStore.agent]
      return agentDef !== undefined ? resolveAgentModel(agentDef) : resolveAgentModel(Agents.cowork)
    },
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "streaming",
    isError: () => agentStore.status._tag === "error",
    error: () => (agentStore.status._tag === "error" ? agentStore.status.error : null),
    latestInputTokens,
    modelInfo: () => resolveModelInfo(modelStore.modelsById, agentStore.agent),
    workerState,
    waitForWorkerRunning: waitForTransportRunning,
    isReconnecting,
    workerRestartCount: () => workerState()?.restartCount ?? 0,
    connectionIssue,

    // Agent state setters (for local errors only)
    setError: (error) =>
      setAgentStore({ status: error !== null ? AgentStatus.error(error) : AgentStatus.idle() }),
    setConnectionIssue,

    // Fire-and-forget actions
    sendMessage: (content) => {
      const s = session()
      if (s === null) return

      clientLog.info("sendMessage", { sessionId: s.sessionId, branchId: s.branchId })
      cast(
        client
          .sendMessage({
            sessionId: s.sessionId,
            branchId: s.branchId,
            content,
          })
          .pipe(
            Effect.tapError((err) =>
              Effect.sync(() => {
                setConnectionIssue(formatConnectionIssue(err))
              }),
            ),
            Effect.withSpan("TUI.sendMessage"),
          ),
      )
    },

    createSession: (firstMessage) => {
      clientLog.info("createSession", { hasFirstMessage: firstMessage !== undefined })
      dispatchSession({ _tag: "CreateRequested" })
      cast(
        client.createSession(firstMessage !== undefined ? { firstMessage } : undefined).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              dispatchSession({
                _tag: "CreateSucceeded",
                session: {
                  sessionId: result.sessionId,
                  branchId: result.branchId,
                  name: result.name,
                  bypass: result.bypass,
                  reasoningLevel: undefined,
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
          Effect.catchEager((err) =>
            Effect.sync(() => {
              tuiError("createSession", err)
              dispatchSession({ _tag: "CreateFailed" })
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }),
          ),
          Effect.withSpan("TUI.createSession"),
        ),
      )
    },

    switchSession: (sessionId, branchId, name, bypass) => {
      // Reset agent state and activate new session
      setAgentStore({ agent: defaultAgent, status: AgentStatus.idle(), cost: 0 })
      setLatestInputTokens(0)
      setConnectionIssue(null)
      dispatchSession({
        _tag: "Activated",
        session: { sessionId, branchId, name, bypass: bypass ?? true, reasoningLevel: undefined },
      })
    },

    clearSession: () => {
      dispatchSession({ _tag: "Clear" })
      setAgentStore({ agent: preferredAgent(), status: AgentStatus.idle(), cost: 0 })
      setLatestInputTokens(0)
      setConnectionIssue(null)
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
      if (s === null) return Effect.sync(() => undefined)
      return client.updateSessionBypass(s.sessionId, bypass).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            dispatchSession({ _tag: "UpdateBypass", bypass: result.bypass })
          }),
        ),
        Effect.asVoid,
      )
    },

    updateSessionReasoningLevel: (reasoningLevel) => {
      const s = session()
      if (s === null) return Effect.sync(() => undefined)
      return client.updateSessionReasoningLevel(s.sessionId, reasoningLevel).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            dispatchSession({
              _tag: "UpdateReasoningLevel",
              reasoningLevel: result.reasoningLevel,
            })
          }),
        ),
        Effect.asVoid,
      )
    },

    createBranch: (name) => {
      const s = session()
      if (s === null) return Effect.succeed("" as BranchId)
      return client.createBranch(s.sessionId, name)
    },

    getBranchTree: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly BranchTreeNode[])
      return client.getBranchTree(s.sessionId)
    },

    getSessionTree: (sessionId) => client.getSessionTree(sessionId),

    forkBranch: (messageId, name) => {
      const s = session()
      if (s === null) return Effect.succeed("" as BranchId)
      return client
        .forkBranch({
          sessionId: s.sessionId,
          fromBranchId: s.branchId,
          atMessageId: messageId,
          ...(name !== undefined ? { name } : {}),
        })
        .pipe(Effect.map((result) => result.branchId as BranchId))
    },

    drainQueuedMessages: () => {
      const s = session()
      if (s === null) {
        return Effect.succeed({ steering: [] as const, followUp: [] as const })
      }
      return client.drainQueuedMessages({ sessionId: s.sessionId, branchId: s.branchId })
    },

    getQueuedMessages: () => {
      const s = session()
      if (s === null) {
        return Effect.succeed({ steering: [] as const, followUp: [] as const })
      }
      return client.getQueuedMessages({ sessionId: s.sessionId, branchId: s.branchId })
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
