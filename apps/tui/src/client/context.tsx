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
import { createStore } from "solid-js/store"
import type { Context } from "effect"
import { Effect, Fiber, Schema } from "effect"
import {
  AgentName as AgentNameSchema,
  type AgentDefinition,
  DEFAULT_AGENT_NAME,
  resolveAgentModel,
  type AgentName,
  type ReasoningEffort,
} from "@gent/core/domain/agent.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"

const AgentsByName: Record<string, AgentDefinition> = Object.fromEntries(
  AllBuiltinAgents.map((a) => [a.name, a]),
)
import { type Model, type ModelId } from "@gent/core/domain/model.js"
import type { EventEnvelope } from "@gent/core/domain/event.js"
import { BranchId, SessionId } from "@gent/core/domain/ids.js"
import type { MessageId } from "@gent/core/domain/ids.js"
import type { ClientLog } from "../utils/client-logger"
import { formatConnectionIssue, formatError } from "../utils/format-error"
import { runWithReconnect } from "../utils/run-with-reconnect"
import { useWorkspace } from "../workspace"
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
import { TaggedEnumClass } from "@gent/core/domain/schema-tagged-enum-class"
import {
  SessionState,
  SessionStateEvent,
  transitionSessionState,
  type Session,
} from "./session-state"

export const SteerCommandInput = TaggedEnumClass("SteerCommandInput", {
  Cancel: {},
  Interrupt: {},
  Interject: {
    message: Schema.String,
    agent: Schema.optional(AgentNameSchema),
  },
  SwitchAgent: { agent: AgentNameSchema },
})
export type SteerCommandInput = Schema.Schema.Type<typeof SteerCommandInput>

const resolveModelInfo = (
  models: Record<string, Model>,
  agent: AgentName | undefined,
  lastModelId: ModelId | undefined,
): Model | undefined => {
  if (lastModelId !== undefined) {
    const live = models[lastModelId]
    if (live !== undefined) return live
  }
  if (agent === undefined) return undefined
  const agentDef = AgentsByName[agent]
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
  /**
   * Server-authoritative model id from `SessionSnapshot.metrics.lastModelId`.
   * Mirrors the cost field's flow: hydrated from snapshot, refreshed on
   * `StreamEnded`. Falls back to the agent's default model only when no
   * stream has ended yet for the active session.
   */
  lastModelId: ModelId | undefined
}

// =============================================================================
// Focused Client Surfaces
// =============================================================================

export interface ClientTransportValue {
  /** Namespaced RPC client — returns Effects */
  client: GentNamespacedClient
  /** Runtime for executing Effects */
  runtime: GentRuntime
  /**
   * Host-provided platform services (FileSystem, ChildProcessSpawner, …).
   * `useRuntime` uses this to fork component effects via
   * `Effect.runForkWith(services)`, so call sites don't need
   * per-effect platform provisioning.
   */
  services: Context.Context<unknown>
  /** Structured logger — flows through Effect's logger layer */
  log: ClientLog

  connectionState: () => ConnectionState | undefined
  waitForTransportReady: () => Effect.Effect<void>
  isReconnecting: () => boolean
  connectionGeneration: () => number
  connectionIssue: () => string | null
  extensionHealth: () => ExtensionHealthSnapshot

  setConnectionIssue: (error: string | null) => void

  // Extension state-change pulse subscription. Fires once per
  // `ExtensionStateChanged` event seen on the active session for each
  // registered subscriber. The pulse carries no payload — consumers
  // refetch via the extension's typed `client.extension.request(...)`.
  // Returns an unsubscribe function. Replaces a single-slot callback so
  // multiple widgets can listen for their own extension's pulses.
  onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
}

export interface ClientSessionValue {
  // Session state (union)
  sessionState: () => SessionState
  session: () => Session | null
  isActive: () => boolean
  isLoading: () => boolean

  // Session actions (fire-and-forget, update state internally)
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
}

export interface ClientAgentValue {
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

  // Agent state setters (for local errors only)
  setError: (error: string | null) => void
}

export interface ClientActionValue {
  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string) => void
  // Steering (fire-and-forget)
  steer: (command: SteerCommandInput) => void
}

export type ClientContextValue = ClientTransportValue &
  ClientSessionValue &
  ClientAgentValue &
  ClientActionValue

const ClientTransportContext = createContext<ClientTransportValue>()
const ClientSessionContext = createContext<ClientSessionValue>()
const ClientAgentContext = createContext<ClientAgentValue>()
const ClientActionContext = createContext<ClientActionValue>()

const EMPTY_EXTENSION_HEALTH: ExtensionHealthSnapshot = {
  _tag: "healthy",
  extensions: [],
}

const useRequiredContext = <T,>(ctx: T | undefined, name: string): T => {
  if (ctx === undefined) throw new Error(`${name} must be used within ClientProvider`)
  return ctx
}

export function useClientTransport(): ClientTransportValue {
  return useRequiredContext(useContext(ClientTransportContext), "ClientTransportContext")
}

export function useClientSession(): ClientSessionValue {
  return useRequiredContext(useContext(ClientSessionContext), "ClientSessionContext")
}

export function useClientAgent(): ClientAgentValue {
  return useRequiredContext(useContext(ClientAgentContext), "ClientAgentContext")
}

export function useClientActions(): ClientActionValue {
  return useRequiredContext(useContext(ClientActionContext), "ClientActionContext")
}

export function useClient(): ClientContextValue {
  const transport = useClientTransport()
  const session = useClientSession()
  const agent = useClientAgent()
  const actions = useClientActions()
  return {
    ...transport,
    ...session,
    ...agent,
    ...actions,
  }
}

export function useClientRuntime(): Pick<ClientTransportValue, "runtime" | "services" | "log"> {
  const { runtime, services, log } = useClientTransport()
  return { runtime, services, log }
}

export function useClientTransportState(): Pick<
  ClientTransportValue,
  | "connectionState"
  | "waitForTransportReady"
  | "isReconnecting"
  | "connectionGeneration"
  | "connectionIssue"
  | "extensionHealth"
  | "setConnectionIssue"
  | "onExtensionStateChanged"
> {
  const {
    connectionState,
    waitForTransportReady,
    isReconnecting,
    connectionGeneration,
    connectionIssue,
    extensionHealth,
    setConnectionIssue,
    onExtensionStateChanged,
  } = useClientTransport()
  return {
    connectionState,
    waitForTransportReady,
    isReconnecting,
    connectionGeneration,
    connectionIssue,
    extensionHealth,
    setConnectionIssue,
    onExtensionStateChanged,
  }
}

interface ClientProviderProps extends ParentProps {
  client: GentNamespacedClient
  runtime: GentRuntime
  log: ClientLog
  initialSession: Session | undefined
  initialAgent?: AgentName
  /**
   * Host-provided platform services (e.g. `FileSystem`, `ChildProcessSpawner`).
   * Used by `useRuntime`'s `cast` / `call` so component effects requiring
   * platform services can be executed without per-call-site `Effect.provide`.
   * Per [[central-provider-wiring]], the host wires this once at root —
   * required, never optional. Tests that need a clean slate pass
   * `Context.empty()`.
   */
  services: Context.Context<unknown>
}

export function ClientProvider(props: ClientProviderProps) {
  const defaultAgent: AgentName = props.initialAgent ?? DEFAULT_AGENT_NAME
  const client = props.client
  const runtime = props.runtime
  const log = props.log
  const services = props.services
  const workspace = useWorkspace()
  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    runtime.cast(effect)
  }

  // Extension state-change pulse subscribers — registered by widgets
  // through `ClientTransport.onExtensionStateChanged`. Fires once per
  // `ExtensionStateChanged` event seen on the active session for each
  // subscriber. The pulse carries no payload — consumers refetch via
  // the extension's typed `client.extension.request(...)`.
  type ExtensionPulseCallback = (s: {
    sessionId: SessionId
    branchId: BranchId
    extensionId: string
  }) => void
  const extensionStateChangedSubscribers = new Set<ExtensionPulseCallback>()

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
        Effect.catchEager((err) =>
          Effect.sync(() => {
            const error = formatError(err)
            log.error("model.list.failed", { error })
            setAgentStore({ status: AgentStatus.error(error) })
          }),
        ),
      ),
    )
  })

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    agent: props.initialSession !== undefined ? props.initialAgent : defaultAgent,
    status: AgentStatus.idle(),
    cost: 0,
    lastModelId: undefined,
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
      const sessionId = SessionId.make(key.slice(0, sep))
      const branchId = BranchId.make(key.slice(sep + 1))
      let cancelled = false
      const isActiveSession = () => !cancelled && sessionKey() === key

      const forwardExtensionStateChanged = (event: EventEnvelope["event"]): void => {
        if (event._tag !== "ExtensionStateChanged") return
        if (extensionStateChangedSubscribers.size === 0) return
        const pulse = {
          sessionId: event.sessionId,
          branchId: event.branchId,
          extensionId: event.extensionId,
        }
        for (const cb of extensionStateChangedSubscribers) {
          // Each subscriber owns its own try/catch — one bad subscriber
          // shouldn't starve siblings. We log + drop.
          try {
            cb(pulse)
          } catch (err) {
            log.warn("client.extensionStateChanged.subscriber.threw", {
              extensionId: event.extensionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
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

        // Cost/token updates come from the server — `client.actor.getMetrics`
        // is the authority. On `StreamEnded` we fetch fresh metrics instead
        // of re-joining event.usage against a client-side pricing registry.
        // The server computes cost against ModelRegistry and sums it per
        // session, so there is one source of truth.
        if (event._tag === "StreamEnded" && event.usage !== undefined) {
          const s = session()
          if (s !== null) {
            cast(
              client.actor.getMetrics({ sessionId: s.sessionId, branchId: s.branchId }).pipe(
                Effect.tap((metrics) =>
                  Effect.sync(() => {
                    setAgentStore({
                      cost: metrics.costUsd,
                      lastModelId: metrics.lastModelId,
                    })
                    setLatestInputTokens(metrics.lastInputTokens)
                  }),
                ),
                Effect.catchEager(() => Effect.void),
              ),
            )
          }
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

        // Forward extension state-change pulses to registered callback
        forwardExtensionStateChanged(event)

        switch (event._tag) {
          case "SessionNameUpdated":
            if (event.sessionId === sessionId) {
              dispatchSession(SessionStateEvent.UpdateName.make({ name: event.name }))
            }
            break

          case "BranchSwitched":
            if (event.sessionId === sessionId) {
              dispatchSession(SessionStateEvent.UpdateBranch.make({ branchId: event.toBranchId }))
            }
            break

          case "SessionSettingsUpdated":
            if (event.sessionId === sessionId) {
              if (event.reasoningLevel !== undefined) {
                dispatchSession(
                  SessionStateEvent.UpdateReasoningLevel.make({
                    reasoningLevel: event.reasoningLevel,
                  }),
                )
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
                    dispatchSession(
                      SessionStateEvent.UpdateReasoningLevel.make({
                        reasoningLevel: snapshot.reasoningLevel,
                      }),
                    )
                  }
                  const rt = snapshot.runtime
                  const status = rt._tag === "Idle" ? AgentStatus.idle() : AgentStatus.streaming()
                  setAgentStore({
                    agent: rt.agent,
                    status,
                    cost: snapshot.metrics.costUsd,
                    lastModelId: snapshot.metrics.lastModelId,
                  })
                  setLatestInputTokens(snapshot.metrics.lastInputTokens)

                  // No initial-snapshot fan-out: the UI snapshot channel is gone.
                  // Widgets fetch initial state via `client.extension.request(...)`
                  // and refetch on `ExtensionStateChanged` pulses.
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

  const transportValue: ClientTransportValue = {
    client,
    runtime,
    services,
    log,

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
    setConnectionIssue,
    onExtensionStateChanged: (cb) => {
      extensionStateChangedSubscribers.add(cb)
      return () => {
        extensionStateChangedSubscribers.delete(cb)
      }
    },
  }

  const sessionValue: ClientSessionValue = {
    // Session state
    sessionState,
    session,
    isActive,
    isLoading,

    createSession: (onCreated) => {
      const requestId = crypto.randomUUID()
      log.info("createSession", { requestId })
      dispatchSession(SessionStateEvent.CreateRequested.make({}))
      cast(
        client.session.create({ requestId, cwd: workspace.cwd }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              // Replicate `switchSession`'s side-effect resets so `/new`
              // does not inherit stale agent status / token counts / error
              // banners / extension-health from the previous session.
              // Create always transitions out of a prior session (or from
              // "none"), so the extensionHealth reset is unconditional.
              setAgentStore({
                agent: defaultAgent,
                status: AgentStatus.idle(),
                cost: 0,
                lastModelId: undefined,
              })
              setLatestInputTokens(0)
              setConnectionIssue(null)
              setExtensionHealth(EMPTY_EXTENSION_HEALTH)
              dispatchSession(
                SessionStateEvent.CreateSucceeded.make({
                  session: {
                    sessionId: result.sessionId,
                    branchId: result.branchId,
                    name: result.name,
                    reasoningLevel: undefined,
                  },
                }),
              )
              onCreated?.(SessionId.make(result.sessionId), BranchId.make(result.branchId))
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              log.error("createSession.failed", { error: String(err) })
              dispatchSession(SessionStateEvent.CreateFailed.make({}))
              setAgentStore({ status: AgentStatus.error(formatError(err)) })
            }),
          ),
          Effect.withSpan("TUI.createSession"),
        ),
      )
    },

    switchSession: (sessionId, branchId, name, agent) => {
      const currentSessionId = session()?.sessionId
      setAgentStore({ agent, status: AgentStatus.idle(), cost: 0, lastModelId: undefined })
      setLatestInputTokens(0)
      setConnectionIssue(null)
      if (currentSessionId !== sessionId) {
        setExtensionHealth(EMPTY_EXTENSION_HEALTH)
      }
      dispatchSession(
        SessionStateEvent.Activated.make({
          session: { sessionId, branchId, name, reasoningLevel: undefined },
        }),
      )
    },

    clearSession: () => {
      dispatchSession(SessionStateEvent.Clear.make({}))
      setAgentStore({
        agent: defaultAgent,
        status: AgentStatus.idle(),
        cost: 0,
        lastModelId: undefined,
      })
      setLatestInputTokens(0)
      setConnectionIssue(null)
      setExtensionHealth(EMPTY_EXTENSION_HEALTH)
    },

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
            dispatchSession(
              SessionStateEvent.UpdateReasoningLevel.make({
                reasoningLevel: result.reasoningLevel,
              }),
            )
          }),
        ),
        Effect.asVoid,
      )
    },

    createBranch: (name) => {
      const s = session()
      if (s === null) return Effect.succeed(BranchId.make(""))
      return client.branch
        .create({
          sessionId: s.sessionId,
          requestId: crypto.randomUUID(),
          ...(name !== undefined ? { name } : {}),
        })
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
      if (s === null) return Effect.succeed(BranchId.make(""))
      return client.branch
        .fork({
          sessionId: s.sessionId,
          fromBranchId: s.branchId,
          atMessageId: messageId,
          requestId: crypto.randomUUID(),
          ...(name !== undefined ? { name } : {}),
        })
        .pipe(Effect.map((result) => BranchId.make(result.branchId)))
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

    switchBranch: (branchId, summarize) => {
      const s = session()
      if (s === null) return

      cast(
        client.branch
          .switch({
            sessionId: s.sessionId,
            fromBranchId: s.branchId,
            toBranchId: branchId,
            requestId: crypto.randomUUID(),
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
  const agentValue: ClientAgentValue = {
    agent: () => agentStore.agent,
    agentStatus: () => agentStore.status,
    cost: () => agentStore.cost,
    model: () => {
      // Server-authoritative `lastModelId` from `metrics` is the single source
      // of truth — server-side agent overrides (`runSpec.agentName`) can swap
      // to a different driver mid-turn, so the local agent default would
      // disagree with what's actually running.
      if (agentStore.lastModelId !== undefined) return agentStore.lastModelId
      const agentDef = agentStore.agent !== undefined ? AgentsByName[agentStore.agent] : undefined
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- DEFAULT_AGENT_NAME always registered
      return resolveAgentModel(agentDef ?? AgentsByName[DEFAULT_AGENT_NAME]!)
    },
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "streaming",
    isError: () => agentStore.status._tag === "error",
    error: () => (agentStore.status._tag === "error" ? agentStore.status.error : null),
    latestInputTokens,
    modelInfo: () =>
      resolveModelInfo(modelStore.modelsById, agentStore.agent, agentStore.lastModelId),
    setError: (error) =>
      setAgentStore({ status: error !== null ? AgentStatus.error(error) : AgentStatus.idle() }),
  }

  const actionValue: ClientActionValue = {
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
  }

  return (
    <ClientTransportContext.Provider value={transportValue}>
      <ClientSessionContext.Provider value={sessionValue}>
        <ClientAgentContext.Provider value={agentValue}>
          <ClientActionContext.Provider value={actionValue}>
            {props.children}
          </ClientActionContext.Provider>
        </ClientAgentContext.Provider>
      </ClientSessionContext.Provider>
    </ClientTransportContext.Provider>
  )
}
