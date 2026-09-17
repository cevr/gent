import {
  createContext,
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
import { Effect, Option, Predicate, Schema } from "effect"
import {
  AgentName as AgentNameSchema,
  type AgentDefinition,
  BranchId,
  DEFAULT_AGENT_NAME,
  type AgentEvent,
  type AgentName,
  type CreateSessionInput,
  type SessionId,
  type EventEnvelope,
  type MessageId,
  type Model,
  type ModelContextMetrics,
  type ReasoningEffort,
} from "@gent/core/protocol"
import { DEFAULT_MODEL_ID, resolveAgentModel } from "@gent/core-internal/domain/agent.js"
import { omitUndefined } from "@gent/core-internal/domain/guards.js"
import type { ClientLog } from "../utils/client-logger"
import { formatConnectionIssue, formatError, type UiError } from "../utils/format-error"
import { useRequiredContext } from "../utils/solid-context"
import { randomId } from "../utils/random-id"
import { useWorkspace } from "../workspace/context"
import { AgentStatus, type AgentState } from "./agent-state"
import { createClientEventHub } from "./event-hub"

interface AgentLifecycleUpdate {
  readonly status?: AgentStatus
}

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return { status: AgentStatus.cases.Streaming.make({}) }
    case "TurnCompleted":
      return { status: AgentStatus.cases.Idle.make({}) }
    case "ErrorOccurred":
      return { status: AgentStatus.cases.Error.make({ error: event.error }) }
    case "MessageReceived":
      if (event.message.role === "user") {
        return { status: AgentStatus.cases.Streaming.make({}) }
      }
      return {}
    default:
      return {}
  }
}

import type {
  ConnectionState,
  GentNamespacedClient,
  GentRuntime,
  GentClientRpcError,
  Message,
  QueueSnapshot,
  SessionSnapshot,
  Session as DomainSession,
  Branch,
  BranchTreeNode,
  ExtensionHealthSnapshot,
  SteerCommand,
} from "@gent/sdk"
import {
  SessionState,
  SessionStateEvent,
  sessionSettings,
  transitionSessionState,
  type Session,
  type SessionSettings,
} from "./session-state"

const isReconnectingState = (state: ConnectionState): boolean =>
  Predicate.isTagged("connecting")(state) || Predicate.isTagged("reconnecting")(state)

/**
 * What this UI can ask a running loop to do.
 *
 * Narrower than the wire `SteerCommand` on purpose. The domain also carries
 * `Interrupt`, which the loop folds into `Cancel` (`agent-loop.actor.ts:763`),
 * and `wake` on an interjection, which this UI never needs: it interjects only
 * into a streaming turn, and an idle branch takes an ordinary `sendMessage`
 * that starts a turn by itself.
 *
 * Choosing an agent here is local state, not an instruction to a running
 * turn: it picks the agent the next turn starts with, and `selectAgent`
 * does that directly.
 */
export const SteerCommandInput = Schema.TaggedUnion({
  Cancel: {},
  Interject: {
    message: Schema.String,
    agent: Schema.optional(AgentNameSchema),
  },
})
export type SteerCommandInput = Schema.Schema.Type<typeof SteerCommandInput>

// =============================================================================
// Focused Client Surfaces
// =============================================================================

interface ClientTransportValue {
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

  // eslint-disable-next-line effect/noNullish -- RPC transport exposes an absent state before startup.
  connectionState: () => ConnectionState | undefined
  waitForTransportReady: Effect.Effect<void>
  isReconnecting: () => boolean
  connectionGeneration: () => number
  // eslint-disable-next-line effect/noNullish -- UI transport exposes null when no issue is present.
  connectionIssue: () => string | null
  extensionHealth: () => ExtensionHealthSnapshot

  // eslint-disable-next-line effect/noNullish -- UI transport accepts null to clear its issue.
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
  /** Subscribe to every event for the active session/branch. */
  onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
  applySessionRuntime: (input: Pick<SessionSnapshot, "sessionId" | "branchId" | "runtime">) => void
  applySessionSnapshot: (snapshot: SessionSnapshot) => void
  applySessionEvent: (envelope: EventEnvelope) => void
  applyBufferedSessionEvent: (envelope: EventEnvelope) => void
}

/**
 * Which session the shell is on, and nothing else about it.
 *
 * A rename or a `/model` change makes a new {@link Session} record carrying the
 * same ids, so anything that reacts to the record restarts for a change it does
 * not care about. This is the value that changes only when the shell actually
 * moves to another session or branch, and every consumer that needs the
 * identity rather than the record reads it.
 */
interface SessionIdentity {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

interface ClientSessionValue {
  // Session state (union)
  sessionState: () => SessionState
  // eslint-disable-next-line effect/noNullish -- UI session accessors expose null while no session is active.
  session: () => Session | null
  /** The active session's ids; a new record with the same ids is the same value. */
  sessionIdentity: () => Option.Option<SessionIdentity>
  /** The active session's id alone, for consumers that never read the branch. */
  activeSessionId: () => Option.Option<SessionId>
  isActive: () => boolean
  isLoading: () => boolean

  // Session actions (fire-and-forget, update state internally)
  /** Create a session and make it the active one. */
  createSession: () => void
  /** Open the session a confirmed handoff produces: linked to the current one, seeded with the summary. */
  openHandoffSession: (summary: string) => void
  // eslint-disable-next-line effect/noNullish -- session switching accepts an optional agent override.
  switchSession: (sessionId: SessionId, branchId: BranchId, name: string, agent?: AgentName) => void
  clearSession: () => void
  /** Replace the session's settings from its current ones; the server reply is folded back. */
  updateSessionSettings: (
    update: (current: SessionSettings) => SessionSettings,
  ) => Effect.Effect<void, GentClientRpcError>

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: Effect.Effect<readonly Message[], GentClientRpcError>
  listSessions: Effect.Effect<readonly DomainSession[], GentClientRpcError>
  listBranches: Effect.Effect<readonly Branch[], GentClientRpcError>
  // eslint-disable-next-line effect/noNullish -- RPC branch creation accepts an omitted name.
  createBranch: (name?: string) => Effect.Effect<BranchId, GentClientRpcError>
  getBranchTree: Effect.Effect<readonly BranchTreeNode[], GentClientRpcError>
  // eslint-disable-next-line effect/noNullish -- RPC branch forking accepts an omitted name.
  forkBranch: (messageId: MessageId, name?: string) => Effect.Effect<BranchId, GentClientRpcError>
  drainQueuedMessages: Effect.Effect<QueueSnapshot, GentClientRpcError>
  getQueuedMessages: Effect.Effect<QueueSnapshot, GentClientRpcError>

  // Branch navigation (fire-and-forget)
  // eslint-disable-next-line effect/noNullish -- RPC branch switching accepts an omitted summary flag.
  switchBranch: (branchId: BranchId) => void
}

/**
 * The context gauge's whole input.
 *
 * The two halves are one value because `buildContextLabels` prefers the
 * projection over the live token count whenever it carries a limit. Held apart,
 * a projection left from the previous session outranks the fresh token count of
 * the new one and renders the old percentage.
 */
export interface SessionMetrics {
  readonly latestInputTokens: number
  /** The last turn's model-context projection, absent until a turn has run. */
  readonly context: Option.Option<ModelContextMetrics>
}

interface ClientAgentValue {
  // Agent state (derived from events)
  // eslint-disable-next-line effect/noNullish -- UI agent accessors expose absence before hydration.
  agent: () => AgentName | undefined
  agentStatus: () => AgentStatus
  cost: () => number
  /** The model the next turn would use: session setting, else the server-resolved default. */
  model: () => string
  // eslint-disable-next-line effect/noNullish -- UI agent accessors expose absence before hydration.
  reasoningLevel: () => ReasoningEffort | undefined
  /** The reasoning level config/agent would apply without a session override. */
  resolvedReasoningLevel: () => Option.Option<ReasoningEffort>
  // Derived accessors
  isStreaming: () => boolean
  isError: () => boolean
  // eslint-disable-next-line effect/noNullish -- UI agent accessors expose null outside the error state.
  error: () => string | null
  /** What the last turn spent: the provider's token count and the model-context projection. */
  sessionMetrics: () => SessionMetrics
  // eslint-disable-next-line effect/noNullish -- model metadata is absent until the model registry loads.
  modelInfo: () => Model | undefined
  /** The models a registered driver can run, in registry order; empty until both load. */
  models: () => readonly Model[]

  // Agent state setters (for local errors only)
  // eslint-disable-next-line effect/noNullish -- UI callers pass null to clear a local error.
  setError: (error: string | null) => void
  /** Run a fallible call; a failure lands formatted in the error line and stops there. */
  surfaceError: <A, R>(effect: Effect.Effect<A, UiError, R>) => Effect.Effect<void, never, R>
}

interface ClientActionValue {
  // Session actions (fire-and-forget, update state internally)
  sendMessage: (content: string) => void
  // Steering (fire-and-forget)
  steer: (command: SteerCommandInput) => void
  /**
   * Choose the agent the next turn starts with.
   *
   * Local to this UI: it names what a new turn begins as, so there is no
   * running turn to instruct and nothing to send. A turn already streaming
   * keeps the agent it started with.
   */
  selectAgent: (agent: AgentName) => void
}

export type ClientContextValue = ClientTransportValue &
  ClientSessionValue &
  ClientAgentValue &
  ClientActionValue

/**
 * One context, one value.
 *
 * The four interfaces above name the facets of the client — transport,
 * session, agent, actions — but they are not four seams. They share one
 * provider, one lifetime, and one set of signals, and every consumer wants
 * them together. Splitting them into four Solid contexts only forced each
 * call site to spread them back into a single object, which allocated a new
 * value per read and let a stale copy outlive the seam it came from.
 */
const ClientContext = createContext<ClientContextValue>()

const EMPTY_EXTENSION_HEALTH: ExtensionHealthSnapshot = {
  _tag: "Healthy",
  extensions: [],
}

const EMPTY_SESSION_METRICS: SessionMetrics = {
  latestInputTokens: 0,
  context: Option.none(),
}

const metricsOf = (snapshot: SessionSnapshot): SessionMetrics => ({
  latestInputTokens: snapshot.metrics.lastInputTokens,
  context: Option.fromUndefinedOr(snapshot.metrics.context),
})

/** The client. One value, provided once, read the same way everywhere. */
export function useClient(): ClientContextValue {
  return useRequiredContext(ClientContext, "useClient must be used within ClientProvider")
}

interface ClientProviderProps extends ParentProps {
  client: GentNamespacedClient
  runtime: GentRuntime
  log: ClientLog
  // eslint-disable-next-line effect/noNullish -- bootstrap passes no session when starting fresh.
  initialSession: Session | undefined
  // eslint-disable-next-line effect/noNullish -- bootstrap may omit an agent override.
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
  const defaultAgent = Option.getOrElse(
    Option.fromNullishOr(props.initialAgent),
    () => DEFAULT_AGENT_NAME,
  )
  const client = props.client
  const runtime = props.runtime
  const log = props.log
  const services = props.services
  const workspace = useWorkspace()
  // Helper to run effects fire-and-forget
  const cast = <A, E>(effect: Effect.Effect<A, E, never>): void => {
    runtime.cast(effect)
  }

  const eventHub = createClientEventHub(log)

  const initialSession = Option.fromNullishOr(props.initialSession)
  const initialSessionState = Option.match(initialSession, {
    onNone: SessionState.none,
    onSome: SessionState.active,
  })
  let initialAgent = Option.some(defaultAgent)
  if (Option.isSome(initialSession)) initialAgent = Option.fromNullishOr(props.initialAgent)
  const [sessionState, setSessionState] = createSignal<SessionState>(initialSessionState)
  const dispatchSession = (event: Parameters<typeof transitionSessionState>[1]) => {
    setSessionState((current) => transitionSessionState(current, event))
  }
  const sessionOption = (): Option.Option<Session> => {
    const current = sessionState()
    if (current.status === "active") return Option.some(current.session)
    return Option.none()
  }
  // eslint-disable-next-line effect/noNullish -- UI session accessors use null for inactive state.
  const session = (): Session | null => Option.getOrNull(sessionOption())
  // The one place the session's identity is derived. Held as a memo with an
  // equivalence on the ids so a rename or a settings change — both of which
  // rebuild the record — leaves this value untouched, and the effects keyed on
  // it keep running.
  const sessionIdentity = createMemo(
    () =>
      Option.map(sessionOption(), (active) => ({
        sessionId: active.sessionId,
        branchId: active.branchId,
      })),
    Option.none<SessionIdentity>(),
    {
      equals: Option.makeEquivalence<SessionIdentity>(
        (left, right) => left.sessionId === right.sessionId && left.branchId === right.branchId,
      ),
    },
  )
  const activeSessionId = createMemo(
    () => Option.map(sessionIdentity(), (identity) => identity.sessionId),
    Option.none<SessionId>(),
    { equals: Option.makeEquivalence<SessionId>((left, right) => left === right) },
  )
  const isActive = () => sessionState().status === "active"
  const isLoading = () => sessionState().status === "creating"

  onMount(() => {
    cast(
      Effect.all({
        models: client.model.list(),
        drivers: client.driver.list(),
      }).pipe(
        Effect.tap(({ models, drivers }) =>
          Effect.sync(() => {
            const modelsById: Record<string, Model> = {}
            for (const model of models) modelsById[model.id] = model
            const agentsByName: Record<string, AgentDefinition> = {}
            for (const agent of drivers.agents) agentsByName[agent.name] = agent
            const driverIds = drivers.drivers
              .filter((driver) => driver._tag === "Model")
              .map((driver) => driver.id)
            setModelStore({ modelsById, agentsByName, driverIds })
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            const error = formatError(err)
            log.error("model.list.failed", { error })
            setAgentStore({ status: AgentStatus.cases.Error.make({ error }) })
          }),
        ),
      ),
    )
  })

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    agent: initialAgent,
    status: AgentStatus.cases.Idle.make({}),
    cost: 0,
    resolvedModelId: Option.none(),
    resolvedReasoningLevel: Option.none(),
  })
  const [sessionMetrics, setSessionMetrics] = createSignal<SessionMetrics>(EMPTY_SESSION_METRICS)

  const [connectionState, setConnectionState] = createSignal<Option.Option<ConnectionState>>(
    Option.fromNullishOr(runtime.lifecycle.getState()),
  )
  const connectionStateValue = () => Option.getOrUndefined(connectionState())
  const [connectionIssue, setConnectionIssueState] = createSignal<Option.Option<string>>(
    Option.none(),
  )
  const connectionIssueValue = () => Option.getOrNull(connectionIssue())
  // eslint-disable-next-line effect/noNullish -- UI transport uses null to clear an issue.
  const setConnectionIssue = (error: string | null): void => {
    setConnectionIssueState(Option.fromNullishOr(error))
  }
  const clearConnectionIssue = (): void => {
    setConnectionIssueState(Option.none())
  }
  const [extensionHealth, setExtensionHealth] =
    createSignal<ExtensionHealthSnapshot>(EMPTY_EXTENSION_HEALTH)

  /**
   * Drop everything the previous session left behind.
   *
   * All three session changes go through here so none can reset a subset.
   * {@link SessionMetrics} is one value for the same reason: its two halves
   * cannot be cleared apart.
   *
   * `switchSession` is the one caller that can land back on the session it is
   * already on, and extension health belongs to the session rather than the
   * branch, so it says whether to clear it.
   */
  const resetForSession = (input: {
    readonly agent: Option.Option<AgentName>
    readonly clearExtensionHealth: boolean
  }): void => {
    setAgentStore({
      agent: input.agent,
      status: AgentStatus.cases.Idle.make({}),
      cost: 0,
      resolvedModelId: Option.none(),
      resolvedReasoningLevel: Option.none(),
    })
    setSessionMetrics(EMPTY_SESSION_METRICS)
    clearConnectionIssue()
    if (input.clearExtensionHealth) setExtensionHealth(EMPTY_EXTENSION_HEALTH)
  }

  const [modelStore, setModelStore] = createStore<{
    modelsById: Record<string, Model>
    agentsByName: Record<string, AgentDefinition>
    /** Ids of the registered model drivers; a model needs one to run. */
    driverIds: readonly string[]
  }>({
    modelsById: {},
    agentsByName: {},
    driverIds: [],
  })

  createEffect(() => {
    const unsubscribe = runtime.lifecycle.subscribe((nextState) => {
      const connectionDetails: Record<string, string | number> = {}
      if ("generation" in nextState) connectionDetails["generation"] = nextState.generation
      if ("reason" in nextState) connectionDetails["reason"] = nextState.reason
      if ("pid" in nextState) {
        const pid = Option.fromNullishOr(nextState.pid)
        if (Option.isSome(pid)) connectionDetails["pid"] = pid.value
      }
      log.info("connection.state", {
        tag: nextState._tag,
        ...connectionDetails,
      })
      setConnectionState(Option.some(nextState))
    })
    onCleanup(unsubscribe)
  })

  const workerEpoch = createMemo<Option.Option<number>>(() => {
    const state = connectionState()
    if (Option.isNone(state) || state.value._tag !== "Connected") return Option.none()
    return Option.some(state.value.generation)
  })

  const isReconnecting = () => {
    const state = connectionState()
    if (Option.isNone(state)) return false
    return isReconnectingState(state.value)
  }

  let extensionHealthLoadVersion = 0

  const extensionHealthDependencies = (): readonly [
    Option.Option<number>,
    Option.Option<SessionId>,
  ] => [workerEpoch(), Option.map(sessionOption(), (value) => value.sessionId)]

  createEffect(
    on(
      extensionHealthDependencies,
      ([epoch, sessionId]) => {
        const version = ++extensionHealthLoadVersion
        if (Option.isNone(epoch)) {
          setExtensionHealth(EMPTY_EXTENSION_HEALTH)
          return
        }

        const request = omitUndefined({ sessionId: Option.getOrUndefined(sessionId) })
        cast(
          client.extension.listStatus(request).pipe(
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

  const applySessionRuntime: ClientTransportValue["applySessionRuntime"] = (input) => {
    const current = sessionOption()
    if (Option.isNone(current)) return
    if (current.value.sessionId !== input.sessionId || current.value.branchId !== input.branchId)
      return
    if (input.runtime._tag === "Idle") {
      if (agentStore.status._tag === "Streaming") {
        setAgentStore({ status: AgentStatus.cases.Idle.make({}) })
      }
    } else {
      setAgentStore({ status: AgentStatus.cases.Streaming.make({}) })
    }
  }

  const applySessionSnapshot = (snapshot: SessionSnapshot): void => {
    const currentSession = sessionOption()
    if (Option.isSome(currentSession)) {
      if (
        currentSession.value.sessionId !== snapshot.sessionId ||
        currentSession.value.branchId !== snapshot.branchId
      ) {
        return
      }
    }
    clearConnectionIssue()
    const nextSession = {
      sessionId: snapshot.sessionId,
      branchId: snapshot.branchId,
      name: Option.getOrElse(Option.fromNullishOr(snapshot.name), () =>
        Option.getOrElse(
          Option.flatMap(currentSession, (value) => Option.fromNullishOr(value.name)),
          () => "Unnamed",
        ),
      ),
      modelId: snapshot.modelId,
      reasoningLevel: snapshot.reasoningLevel,
    }
    const sessionChanged = Option.match(currentSession, {
      onNone: () => true,
      onSome: (current) =>
        current.name !== nextSession.name ||
        current.modelId !== nextSession.modelId ||
        current.reasoningLevel !== nextSession.reasoningLevel,
    })
    if (sessionChanged) {
      dispatchSession(SessionStateEvent.cases.Activated.make({ session: nextSession }))
    }
    const rt = snapshot.runtime
    let status: AgentStatus = AgentStatus.cases.Streaming.make({})
    if (rt._tag === "Idle") status = AgentStatus.cases.Idle.make({})
    setAgentStore({
      agent: Option.fromNullishOr(rt.agent),
      status,
      cost: snapshot.metrics.costUsd,
      resolvedModelId: Option.some(snapshot.resolvedModelId),
      resolvedReasoningLevel: Option.fromUndefinedOr(snapshot.resolvedReasoningLevel),
    })
    setSessionMetrics(metricsOf(snapshot))
  }

  const refreshSessionMetrics = (): void => {
    const currentSession = sessionOption()
    if (Option.isNone(currentSession)) return
    const s = currentSession.value
    cast(
      client.session.getSnapshot({ sessionId: s.sessionId, branchId: s.branchId }).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            // The session can change while this reply is in flight. Writing it
            // blind would restore the previous session's cost, model, tokens
            // and context over the new session's reset values, so a reply that
            // no longer names the active branch is dropped.
            const active = sessionOption()
            if (Option.isNone(active)) return
            if (active.value.sessionId !== s.sessionId) return
            if (active.value.branchId !== s.branchId) return
            setAgentStore({
              cost: snapshot.metrics.costUsd,
              resolvedModelId: Option.some(snapshot.resolvedModelId),
              resolvedReasoningLevel: Option.fromUndefinedOr(snapshot.resolvedReasoningLevel),
            })
            setSessionMetrics(metricsOf(snapshot))
          }),
        ),
        Effect.catchEager(() => Effect.void),
      ),
    )
  }

  const applyAgentLifecycleEvent = (event: EventEnvelope["event"]): void => {
    const lifecycle = reduceAgentLifecycle(event)
    const status = Option.fromNullishOr(lifecycle.status)
    if (Option.isSome(status)) setAgentStore({ status: status.value })
  }

  const applySessionMetadataEvent = (event: EventEnvelope["event"]): void => {
    switch (event._tag) {
      case "SessionNameUpdated": {
        const s = sessionOption()
        if (Option.isSome(s) && event.sessionId === s.value.sessionId) {
          dispatchSession(SessionStateEvent.cases.UpdateName.make({ name: event.name }))
        }
        break
      }

      case "BranchSwitched": {
        const s = sessionOption()
        if (Option.isSome(s) && event.sessionId === s.value.sessionId) {
          dispatchSession(SessionStateEvent.cases.UpdateBranch.make({ branchId: event.toBranchId }))
        }
        break
      }

      case "SessionSettingsUpdated": {
        const s = sessionOption()
        if (Option.isSome(s) && event.sessionId === s.value.sessionId) {
          dispatchSession(
            SessionStateEvent.cases.UpdateSettings.make({
              modelId: event.modelId,
              reasoningLevel: event.reasoningLevel,
            }),
          )
          // The server resolves what the cleared/changed settings fall back to.
          refreshSessionMetrics()
        }
        break
      }
    }
  }

  const applySessionEvent = (envelope: EventEnvelope): void => {
    const event = envelope.event
    eventHub.notifySessionEvent(envelope)
    eventHub.notifyExtensionStateChanged(event)
    if (event._tag === "StreamEnded" && Option.isSome(Option.fromNullishOr(event.usage))) {
      refreshSessionMetrics()
    }
    if (event._tag === "ErrorOccurred") {
      log.error("agent.error", { error: event.error, eventId: envelope.id })
    }
    applyAgentLifecycleEvent(event)
    applySessionMetadataEvent(event)
  }

  const applyBufferedSessionEvent = (envelope: EventEnvelope): void => {
    const event = envelope.event
    eventHub.notifySessionEvent(envelope)
    // Snapshot replay owns lifecycle, metadata, and metrics; buffered events
    // may still invalidate extension subscribers, which must stay idempotent.
    eventHub.notifyExtensionStateChanged(event)
  }

  const transportValue: ClientTransportValue = {
    client,
    runtime,
    services,
    log,

    connectionState: connectionStateValue,
    waitForTransportReady: runtime.lifecycle.waitForReady,
    isReconnecting,
    extensionHealth,
    connectionGeneration: () => {
      const state = connectionState()
      if (Option.isNone(state)) return 0
      if (state.value._tag === "Connected") return state.value.generation
      if (state.value._tag === "Reconnecting") return state.value.generation
      return 0
    },
    connectionIssue: connectionIssueValue,
    setConnectionIssue,
    onExtensionStateChanged: eventHub.onExtensionStateChanged,
    onSessionEvent: eventHub.onSessionEvent,
    applySessionRuntime,
    applySessionSnapshot,
    applySessionEvent,
    applyBufferedSessionEvent,
  }

  const createSessionWith = (
    input: Pick<CreateSessionInput, "parentSessionId" | "parentBranchId" | "initialPrompt">,
  ) => {
    dispatchSession(SessionStateEvent.cases.CreateRequested.make({}))
    const createSessionEffect = Effect.fn("TUI.createSession")(function* () {
      const requestId = yield* randomId
      yield* Effect.sync(() => {
        log.info("createSession", { requestId })
      })
      return yield* client.session.create({ ...input, requestId, cwd: workspace.cwd })
    })
    cast(
      createSessionEffect().pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            // Create always transitions out of a prior session (or from
            // "none"), so extension health is cleared unconditionally.
            resetForSession({ agent: Option.some(defaultAgent), clearExtensionHealth: true })
            dispatchSession(
              SessionStateEvent.cases.CreateSucceeded.make({
                session: {
                  sessionId: result.sessionId,
                  branchId: result.branchId,
                  name: result.name,
                  modelId: Option.getOrUndefined(Option.none()),
                  reasoningLevel: Option.getOrUndefined(Option.none()),
                },
              }),
            )
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            log.error("createSession.failed", { error: String(err) })
            dispatchSession(SessionStateEvent.cases.CreateFailed.make({}))
            setAgentStore({
              status: AgentStatus.cases.Error.make({ error: formatError(err) }),
            })
          }),
        ),
      ),
    )
  }

  const sessionValue: ClientSessionValue = {
    // Session state
    sessionState,
    session,
    sessionIdentity,
    activeSessionId,
    isActive,
    isLoading,

    createSession: () => createSessionWith({}),

    openHandoffSession: (summary) => {
      const current = sessionOption()
      if (Option.isNone(current)) return
      createSessionWith({
        parentSessionId: current.value.sessionId,
        parentBranchId: current.value.branchId,
        initialPrompt: summary,
      })
    },

    switchSession: (sessionId, branchId, name, agent) => {
      const currentSessionId = Option.map(sessionOption(), (value) => value.sessionId)
      resetForSession({
        agent: Option.fromNullishOr(agent),
        // A branch switch within one session keeps that session's health.
        clearExtensionHealth:
          Option.isNone(currentSessionId) || currentSessionId.value !== sessionId,
      })
      dispatchSession(
        SessionStateEvent.cases.Activated.make({
          session: {
            sessionId,
            branchId,
            name,
            modelId: Option.getOrUndefined(Option.none()),
            reasoningLevel: Option.getOrUndefined(Option.none()),
          },
        }),
      )
    },

    clearSession: () => {
      dispatchSession(SessionStateEvent.cases.Clear.make({}))
      resetForSession({ agent: Option.some(defaultAgent), clearExtensionHealth: true })
    },

    listMessages: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return [] satisfies readonly Message[]
      return yield* client.message.list({ branchId: currentSession.value.branchId })
    }),

    listSessions: client.session.list(),

    listBranches: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return [] satisfies readonly Branch[]
      return yield* client.branch.list({ sessionId: currentSession.value.sessionId })
    }),

    updateSessionSettings: (update) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return Effect.void
      const s = currentSession.value
      return client.session
        .updateSettings({ sessionId: s.sessionId, ...update(sessionSettings(s)) })
        .pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              dispatchSession(SessionStateEvent.cases.UpdateSettings.make(result))
              refreshSessionMetrics()
            }),
          ),
          Effect.asVoid,
        )
    },

    createBranch: (name) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return Effect.succeed(BranchId.make(""))
      const s = currentSession.value
      return Effect.gen(function* () {
        const requestId = yield* randomId
        const result = yield* client.branch.create({
          sessionId: s.sessionId,
          requestId,
          name,
        })
        return result.branchId
      })
    },

    getBranchTree: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) {
        return [] satisfies readonly BranchTreeNode[]
      }
      return yield* client.branch.getTree({ sessionId: currentSession.value.sessionId })
    }),

    forkBranch: (messageId, name) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return Effect.succeed(BranchId.make(""))
      const s = currentSession.value
      return Effect.gen(function* () {
        const requestId = yield* randomId
        const result = yield* client.branch.fork({
          sessionId: s.sessionId,
          fromBranchId: s.branchId,
          atMessageId: messageId,
          requestId,
          name,
        })
        return BranchId.make(result.branchId)
      })
    },

    drainQueuedMessages: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) {
        return { steering: [], followUp: [] } satisfies QueueSnapshot
      }
      const requestId = yield* randomId
      return yield* client.queue.drain({
        sessionId: currentSession.value.sessionId,
        branchId: currentSession.value.branchId,
        requestId,
      })
    }),

    getQueuedMessages: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) {
        return { steering: [], followUp: [] } satisfies QueueSnapshot
      }
      return yield* client.queue.get({
        sessionId: currentSession.value.sessionId,
        branchId: currentSession.value.branchId,
      })
    }),

    switchBranch: (branchId) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return
      const s = currentSession.value

      cast(
        Effect.gen(function* () {
          const requestId = yield* randomId
          return yield* client.branch.switch({
            sessionId: s.sessionId,
            fromBranchId: s.branchId,
            toBranchId: branchId,
            requestId,
          })
        }).pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              setAgentStore({
                status: AgentStatus.cases.Error.make({ error: formatError(err) }),
              })
            }),
          ),
        ),
      )
    },
  }
  const agentValue: ClientAgentValue = {
    agent: () => Option.getOrUndefined(agentStore.agent),
    agentStatus: () => agentStore.status,
    cost: () => agentStore.cost,
    model: () => {
      // The session setting applies before the snapshot refresh lands; the
      // server-resolved id covers config and agent defaults. The agent
      // definition only fills the gap before the first snapshot hydrates.
      const pinned = Option.flatMap(sessionOption(), (s) => Option.fromUndefinedOr(s.modelId))
      if (Option.isSome(pinned)) return pinned.value
      if (Option.isSome(agentStore.resolvedModelId)) return agentStore.resolvedModelId.value
      const agentDef = Option.flatMap(agentStore.agent, (agent) =>
        Option.fromNullishOr(modelStore.agentsByName[agent]),
      )
      const defaultAgentDef = Option.fromNullishOr(modelStore.agentsByName[DEFAULT_AGENT_NAME])
      const resolved = Option.orElse(agentDef, () => defaultAgentDef)
      if (Option.isSome(resolved)) return resolveAgentModel(resolved.value)
      return DEFAULT_MODEL_ID
    },
    reasoningLevel: () =>
      Option.getOrUndefined(
        Option.orElse(
          Option.flatMap(sessionOption(), (s) => Option.fromUndefinedOr(s.reasoningLevel)),
          () => agentStore.resolvedReasoningLevel,
        ),
      ),
    resolvedReasoningLevel: () => agentStore.resolvedReasoningLevel,
    // Derived accessors
    isStreaming: () => agentStore.status._tag === "Streaming",
    isError: () => agentStore.status._tag === "Error",
    error: () => {
      if (agentStore.status._tag === "Error") return agentStore.status.error
      return Option.getOrNull(Option.none<string>())
    },
    sessionMetrics,
    modelInfo: () => modelStore.modelsById[agentValue.model()],
    models: () =>
      Object.values(modelStore.modelsById).filter((model) =>
        modelStore.driverIds.includes(model.provider),
      ),
    setError: (error) => {
      const nextError = Option.fromNullishOr(error)
      if (Option.isSome(nextError)) {
        setAgentStore({ status: AgentStatus.cases.Error.make({ error: nextError.value }) })
        return
      }
      setAgentStore({ status: AgentStatus.cases.Idle.make({}) })
    },
    surfaceError: (effect) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchEager((error) => Effect.sync(() => agentValue.setError(formatError(error)))),
      ),
  }

  const actionValue: ClientActionValue = {
    sendMessage: (content) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return
      const s = currentSession.value

      const sendMessageEffect = Effect.fn("TUI.sendMessage")(function* () {
        const requestId = yield* randomId
        yield* Effect.sync(() => {
          log.info("sendMessage", { sessionId: s.sessionId, branchId: s.branchId, requestId })
        })
        return yield* client.message.send({
          sessionId: s.sessionId,
          branchId: s.branchId,
          content,
          requestId,
        })
      })
      cast(
        sendMessageEffect().pipe(
          Effect.tapError((err) =>
            Effect.sync(() => {
              setConnectionIssue(formatConnectionIssue(err))
            }),
          ),
        ),
      )
    },
    selectAgent: (agent) => {
      setAgentStore({ agent: Option.some(agent) })
    },

    steer: (command) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return
      const s = currentSession.value
      cast(
        Effect.gen(function* () {
          const requestId = yield* randomId
          const fullCommand: SteerCommand = {
            ...command,
            sessionId: s.sessionId,
            branchId: s.branchId,
            requestId,
          }
          return yield* client.steer.command({ command: fullCommand })
        }),
      )
    },
  }

  // Built once, for the life of the provider. Every accessor on it reads a
  // signal, so the object itself never needs to change identity — and a
  // consumer that holds it can never observe a value from a stale merge.
  const clientValue: ClientContextValue = {
    ...transportValue,
    ...sessionValue,
    ...agentValue,
    ...actionValue,
  }

  return <ClientContext.Provider value={clientValue}>{props.children}</ClientContext.Provider>
}
