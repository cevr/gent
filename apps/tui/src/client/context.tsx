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
import { Effect, Fiber, Schema } from "effect"
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
import type { ClientLog } from "../utils/client-logger"
import { formatConnectionIssue, formatError } from "../utils/format-error"
import { runWithReconnect } from "../utils/run-with-reconnect"
import { reduceAgentLifecycle } from "./agent-lifecycle"
import { runSessionSubscriptionAttempt } from "./session-subscription"

import type {
  ConnectionState,
  GentNamespacedClient,
  GentRuntime,
  GentRpcError,
  MessageInfoReadonly,
  QueueSnapshot,
  SessionInfo,
  BranchInfo,
  BranchTreeNode,
  ExtensionHealthSnapshot,
  SessionTreeNode,
  SteerCommand,
} from "@gent/sdk"
import { SessionState, transitionSessionState, type Session } from "./session-state"

type SteerCommandInput =
  | { _tag: "Cancel" }
  | { _tag: "Interrupt" }
  | { _tag: "Interject"; message: string; agent?: AgentName }
  | { _tag: "SwitchAgent"; agent: AgentName }

const resolveModelInfo = (
  models: Record<string, Model>,
  agent: AgentName | undefined,
): Model | undefined => {
  if (agent === undefined) return undefined
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
  agent: AgentName | undefined
  status: AgentStatus
  cost: number
}

// =============================================================================
// Client Context Value
// =============================================================================

export interface ClientContextValue {
  /** Namespaced RPC client — returns Effects */
  client: GentNamespacedClient
  /** Runtime for executing Effects */
  runtime: GentRuntime
  /** Structured logger — flows through Effect's logger layer */
  log: ClientLog

  // Session state (union)
  sessionState: () => SessionState
  session: () => Session | null
  isActive: () => boolean
  isLoading: () => boolean

  // Agent state (derived from events)
  agent: () => AgentName | undefined
  agentStatus: () => AgentStatus
  cost: () => number
  model: () => string
  // Derived accessors
  isStreaming: () => boolean
  isError: () => boolean
  error: () => string | null
  latestInputTokens: () => number
  modelInfo: () => Model | undefined
  connectionState: () => ConnectionState | undefined
  waitForTransportReady: () => Effect.Effect<void>
  isReconnecting: () => boolean
  connectionGeneration: () => number
  connectionIssue: () => string | null
  extensionHealth: () => ExtensionHealthSnapshot

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void
  setConnectionIssue: (error: string | null) => void

  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string) => void
  createSession: (onCreated?: (sessionId: SessionId, branchId: BranchId) => void) => void
  switchSession: (sessionId: SessionId, branchId: BranchId, name: string, agent?: AgentName) => void
  clearSession: () => void
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

  // Extension state snapshot callback (wired by ExtensionUIProvider)
  onExtensionSnapshot: (
    cb: (snapshot: {
      sessionId: SessionId
      branchId: BranchId
      extensionId: string
      epoch: number
      model: unknown
    }) => void,
  ) => void
}

const ClientContext = createContext<ClientContextValue>()

const EMPTY_EXTENSION_HEALTH: ExtensionHealthSnapshot = {
  extensions: [],
  summary: {
    status: "healthy",
    failedExtensions: [],
    failedActors: [],
    failedScheduledJobs: [],
  },
}

export function useClient(): ClientContextValue {
  const ctx = useContext(ClientContext)
  if (ctx === undefined) throw new Error("useClient must be used within ClientProvider")
  return ctx
}

interface ClientProviderProps extends ParentProps {
  client: GentNamespacedClient
  runtime: GentRuntime
  log: ClientLog
  initialSession: Session | undefined
  initialAgent?: AgentName
}

export function ClientProvider(props: ClientProviderProps) {
  const defaultAgent: AgentName = props.initialAgent ?? "cowork"
  const client = props.client
  const runtime = props.runtime
  const log = props.log
  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    runtime.cast(effect)
  }

  // Extension state snapshot callback — wired by ExtensionUIProvider
  let extensionSnapshotCb:
    | ((s: {
        sessionId: SessionId
        branchId: BranchId
        extensionId: string
        epoch: number
        model: unknown
      }) => void)
    | undefined

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
      client.model.list().pipe(
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
    agent: props.initialSession !== undefined ? props.initialAgent : defaultAgent,
    status: AgentStatus.idle(),
    cost: 0,
  })
  const [latestInputTokens, setLatestInputTokens] = createSignal(0)
  const [connectionState, setConnectionState] = createSignal<ConnectionState | undefined>(
    runtime.lifecycle.getState(),
  )
  const [connectionIssue, setConnectionIssue] = createSignal<string | null>(null)
  const [extensionHealth, setExtensionHealth] =
    createSignal<ExtensionHealthSnapshot>(EMPTY_EXTENSION_HEALTH)
  const [lastSeenEventId, setLastSeenEventId] = createSignal<number | null>(null)
  const [lastSeenSessionKey, setLastSeenSessionKey] = createSignal<string | null>(null)

  const [modelStore, setModelStore] = createStore<{
    modelsById: Record<string, Model>
  }>({
    modelsById: {},
  })

  createEffect(() => {
    const unsubscribe = runtime.lifecycle.subscribe((nextState) => {
      log.info("connection.state", {
        tag: nextState._tag,
        ...("generation" in nextState ? { generation: nextState.generation } : {}),
        ...("reason" in nextState ? { reason: nextState.reason } : {}),
        ...("pid" in nextState ? { pid: nextState.pid } : {}),
      })
      setConnectionState(nextState)
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
    const state = connectionState()
    if (state === undefined) return 0
    if (state._tag === "connected") return state.generation
    if (state._tag === "reconnecting") return null
    return null
  })

  const isReconnecting = () => {
    const state = connectionState()
    return state?._tag === "connecting" || state?._tag === "reconnecting"
  }

  let extensionHealthLoadVersion = 0

  createEffect(
    on(
      () => [workerEpoch(), session()?.sessionId] as const,
      ([epoch, sessionId]) => {
        const version = ++extensionHealthLoadVersion
        if (connectionState()?._tag !== "connected" || epoch === null) {
          setExtensionHealth(EMPTY_EXTENSION_HEALTH)
          return
        }

        cast(
          client.extension
            .listStatus({
              ...(sessionId !== undefined ? { sessionId } : {}),
            })
            .pipe(
              Effect.tap((nextHealth) =>
                Effect.sync(() => {
                  if (version !== extensionHealthLoadVersion) return
                  setExtensionHealth(nextHealth)
                }),
              ),
              Effect.catchEager((error) =>
                Effect.sync(() => {
                  if (version !== extensionHealthLoadVersion) return
                  setExtensionHealth(EMPTY_EXTENSION_HEALTH)
                  log.warn("extension.health.refresh.failed", { error: String(error) })
                }),
              ),
            ),
        )
      },
      { defer: false },
    ),
  )

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
      const isActiveSession = () => !cancelled && sessionKey() === key

      const forwardExtensionSnapshot = (event: EventEnvelope["event"]): void => {
        if (event._tag === "ExtensionUiSnapshot" && extensionSnapshotCb !== undefined) {
          extensionSnapshotCb({
            sessionId: event.sessionId,
            branchId: event.branchId,
            extensionId: event.extensionId,
            epoch: event.epoch,
            model: event.model,
          })
        }
      }

      const processEvent = (envelope: EventEnvelope): void => {
        if (!isActiveSession()) return

        log.debug("event.received", {
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
          log.error("agent.error", { error: event.error, eventId: envelope.id })
        }

        const lifecycle = reduceAgentLifecycle(event)
        if (lifecycle.preferredAgent !== undefined) {
          if (Schema.is(AgentNameSchema)(lifecycle.preferredAgent)) {
            setAgentStore({ agent: lifecycle.preferredAgent })
          } else {
            setAgentStore({ agent: undefined })
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

        // Forward extension snapshots to registered callback
        forwardExtensionSnapshot(event)

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

          case "SessionSettingsUpdated":
            if (event.sessionId === sessionId) {
              if (event.reasoningLevel !== undefined) {
                dispatchSession({
                  _tag: "UpdateReasoningLevel",
                  reasoningLevel: event.reasoningLevel,
                })
              }
            }
            break
        }
      }

      log.info("ctx.subscribe.start", { sessionId, branchId })
      const fiber = runtime.fork(
        runWithReconnect(
          () =>
            Effect.gen(function* () {
              if (connectionState()?._tag !== "connected") {
                log.info("ctx.wait-for-ready", { sessionId, branchId })
                yield* runtime.lifecycle.waitForReady
                log.info("ctx.ready", { sessionId, branchId })
              }

              yield* runSessionSubscriptionAttempt({
                sessionId,
                branchId,
                lastSeenEventId: lastSeenEventId(),
                log,
                isActiveSession,
                getSnapshot: client.session.getSnapshot({ sessionId, branchId }),
                hydrateSnapshot: (snapshot) => {
                  setConnectionIssue(null)
                  if (snapshot.reasoningLevel !== undefined) {
                    dispatchSession({
                      _tag: "UpdateReasoningLevel",
                      reasoningLevel: snapshot.reasoningLevel,
                    })
                  }
                  const rt = snapshot.runtime
                  const status = rt.status === "idle" ? AgentStatus.idle() : AgentStatus.streaming()
                  setAgentStore({ agent: rt.agent, status })

                  if (
                    snapshot.extensionSnapshots !== undefined &&
                    extensionSnapshotCb !== undefined
                  ) {
                    for (const ext of snapshot.extensionSnapshots) {
                      extensionSnapshotCb({
                        sessionId,
                        branchId,
                        ...ext,
                      })
                    }
                  }
                },
                openEvents: (after) =>
                  client.session.events({
                    sessionId,
                    branchId,
                    ...(after !== undefined ? { after } : {}),
                  }),
                processEvent,
              })
            }),
          {
            label: "ctx.events",
            log,
            onError: (err) => {
              if (!isActiveSession()) return
              if (connectionState()?._tag !== "connected") return
              log.error("event.subscription.failed", { error: formatError(err) })
              setConnectionIssue(formatConnectionIssue(err))
            },
            waitForRetry: () => runtime.lifecycle.waitForReady,
          },
        ),
      )

      onCleanup(() => {
        log.info("ctx.subscribe.cleanup", { sessionId, branchId })
        cancelled = true
        Effect.runFork(Fiber.interrupt(fiber))
      })
    }),
  )

  const value: ClientContextValue = {
    client,
    runtime,
    log,

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
      if (agentStore.agent === undefined) return resolveAgentModel(Agents.cowork)
      const agentDef = (Agents as Record<string, typeof Agents.cowork>)[agentStore.agent]
      return agentDef !== undefined ? resolveAgentModel(agentDef) : resolveAgentModel(Agents.cowork)
    },
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "streaming",
    isError: () => agentStore.status._tag === "error",
    error: () => (agentStore.status._tag === "error" ? agentStore.status.error : null),
    latestInputTokens,
    modelInfo: () => resolveModelInfo(modelStore.modelsById, agentStore.agent),
    connectionState,
    waitForTransportReady: () => runtime.lifecycle.waitForReady,
    isReconnecting,
    extensionHealth,
    connectionGeneration: () => {
      const state = connectionState()
      if (state === undefined) return 0
      if (state._tag === "connected") return state.generation
      if (state._tag === "reconnecting") return state.generation
      return 0
    },
    connectionIssue,

    // Agent state setters (for local errors only)
    setError: (error) =>
      setAgentStore({ status: error !== null ? AgentStatus.error(error) : AgentStatus.idle() }),
    setConnectionIssue,

    // Fire-and-forget actions
    sendMessage: (content) => {
      const s = session()
      if (s === null) return

      const requestId = crypto.randomUUID()
      log.info("sendMessage", { sessionId: s.sessionId, branchId: s.branchId, requestId })
      cast(
        client.message
          .send({
            sessionId: s.sessionId,
            branchId: s.branchId,
            content,
            requestId,
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

    createSession: (onCreated) => {
      const requestId = crypto.randomUUID()
      log.info("createSession", { requestId })
      dispatchSession({ _tag: "CreateRequested" })
      cast(
        client.session.create({ requestId }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              dispatchSession({
                _tag: "CreateSucceeded",
                session: {
                  sessionId: result.sessionId,
                  branchId: result.branchId,
                  name: result.name,
                  reasoningLevel: undefined,
                },
              })
              onCreated?.(result.sessionId as SessionId, result.branchId as BranchId)
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              log.error("createSession.failed", { error: String(err) })
              dispatchSession({ _tag: "CreateFailed" })
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }),
          ),
          Effect.withSpan("TUI.createSession"),
        ),
      )
    },

    switchSession: (sessionId, branchId, name, agent) => {
      // Reset agent state and activate new session
      setAgentStore({ agent, status: AgentStatus.idle(), cost: 0 })
      setLatestInputTokens(0)
      setConnectionIssue(null)
      setExtensionHealth(EMPTY_EXTENSION_HEALTH)
      dispatchSession({
        _tag: "Activated",
        session: { sessionId, branchId, name, reasoningLevel: undefined },
      })
    },

    clearSession: () => {
      dispatchSession({ _tag: "Clear" })
      setAgentStore({ agent: defaultAgent, status: AgentStatus.idle(), cost: 0 })
      setLatestInputTokens(0)
      setConnectionIssue(null)
      setExtensionHealth(EMPTY_EXTENSION_HEALTH)
    },

    // Return Effects for caller to run
    listMessages: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly MessageInfoReadonly[])
      return client.message.list({ branchId: s.branchId })
    },

    listSessions: () => client.session.list(),

    listBranches: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly BranchInfo[])
      return client.branch.list({ sessionId: s.sessionId })
    },

    updateSessionReasoningLevel: (reasoningLevel) => {
      const s = session()
      if (s === null) return Effect.sync(() => undefined)
      return client.session.updateReasoningLevel({ sessionId: s.sessionId, reasoningLevel }).pipe(
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
      return client.branch
        .create({ sessionId: s.sessionId, ...(name !== undefined ? { name } : {}) })
        .pipe(Effect.map((result) => result.branchId))
    },

    getBranchTree: () => {
      const s = session()
      if (s === null) return Effect.succeed([] as readonly BranchTreeNode[])
      return client.branch.getTree({ sessionId: s.sessionId })
    },

    getSessionTree: (sessionId) => client.session.getTree({ sessionId }),

    forkBranch: (messageId, name) => {
      const s = session()
      if (s === null) return Effect.succeed("" as BranchId)
      return client.branch
        .fork({
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
      return client.queue.drain({ sessionId: s.sessionId, branchId: s.branchId })
    },

    getQueuedMessages: () => {
      const s = session()
      if (s === null) {
        return Effect.succeed({ steering: [] as const, followUp: [] as const })
      }
      return client.queue.get({ sessionId: s.sessionId, branchId: s.branchId })
    },

    // Fire-and-forget steering
    steer: (command) => {
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
      cast(client.steer.command({ command: fullCommand }))
    },

    onExtensionSnapshot: (cb) => {
      extensionSnapshotCb = cb
    },

    switchBranch: (branchId, summarize) => {
      const s = session()
      if (s === null) return

      cast(
        client.branch
          .switch({
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
