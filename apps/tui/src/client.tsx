import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  type Logger,
  Option,
  type PlatformError,
  Predicate,
  Schema,
  type Scope,
} from "effect"
import {
  buildLogPaths,
  ensureLogDir,
  resolveLogDir,
  type GentRuntime,
  makeJsonFileLogger,
} from "@gent/sdk"
import {
  type AgentDefinition,
  type AgentEvent,
  type AgentName,
  BranchId,
  type CreateSessionInput,
  DEFAULT_AGENT_NAME,
  type EventEnvelope,
  type MessageId,
  type Model,
  type ModelContextMetrics,
  ModelId,
  ReasoningEffort,
  SessionId,
  DEFAULT_MODEL_ID,
  resolveAgentModel,
  type Branch,
  type BranchTreeNode,
  ConnectionState,
  type ExtensionHealthSnapshot,
  type GentClientRpcError,
  type GentNamespacedClient,
  type Message,
  type QueueSnapshot,
  type UpdateSessionSettingsInput,
  type SessionSnapshot,
  type SteerCommand,
} from "@gent/core/protocol"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { omitUndefined } from "@gent/core/extensions/api"
import { formatError, randomId, SEND_RETRY, type UiError, useRequiredContext } from "./utils"
import { useWorkspace } from "./workspace"

// ── client logging ──────────────────────────────────────────────────────────

/**
 * Client-side structured logger — unified with Effect's logger.
 *
 * `createClientLog(services)` — creates a logger backed by Effect.runForkWith.
 *   All logs flow through the Effect logger layer and land in the same file.
 *
 * `shutdownLog` — synchronous file write, survives process.exit(). Use for
 *   shutdown paths only (after Effect runtime is torn down). It appends to a
 *   directory `clientTraceLogger` creates in scope at startup.
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync, writeFileSync } from "node:fs" // eslint-disable-line effect/noNodeBuiltinImport -- Synchronous shutdown logging runs after the Effect runtime closes.

// Client log path derives from `process.cwd()` and `resolveLogDir` — the same
// sources the launcher threads into `GentObservability` for the server. Both
// ends hash the same cwd into the same directory, so a single gent instance
// writes client + server logs under one filename prefix, beside its own data
// when `GENT_DATA_DIR` is set. Resolved once at load: `shutdownLog` writes
// after the Effect runtime closes.
const CLIENT_LOG_DIR = Effect.runSync(resolveLogDir)
const CLIENT_LOG_PATH = buildLogPaths(process.cwd(), CLIENT_LOG_DIR).client

// Clock-bypass: `shutdownLog` runs after Effect runtime teardown, so we
// cannot yield `Clock.currentTimeMillis` here. `Date.now()` is the standard
// sync-land alternative.
const isoNow = () => DateTime.formatIso(DateTime.nowUnsafe())
const encodeLogEntry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Synchronous log — survives process.exit(). Use for shutdown paths only. */
export const shutdownLog = (msg: string, data?: Schema.JsonObject) => {
  const entry = new Map<string, Schema.Json>(
    Object.entries(Option.fromNullishOr(data).pipe(Option.getOrElse(() => ({})))),
  )
  entry.set("ts", isoNow())
  entry.set("level", "info")
  entry.set("source", "client")
  entry.set("msg", msg)
  Effect.runSync(
    Effect.ignore(
      Effect.try(() =>
        appendFileSync(CLIENT_LOG_PATH, encodeLogEntry(Object.fromEntries(entry)) + "\n"),
      ),
    ),
  )
}

export const clearClientLog = () => {
  Effect.runSync(Effect.ignore(Effect.try(() => writeFileSync(CLIENT_LOG_PATH, ""))))
}

export interface ClientLog {
  debug: (msg: string, data?: Schema.JsonObject) => void
  info: (msg: string, data?: Schema.JsonObject) => void
  warn: (msg: string, data?: Schema.JsonObject) => void
  error: (msg: string, data?: Schema.JsonObject) => void
}

/**
 * Create an Effect-backed client logger from captured services.
 * Uses runForkWith — logs are async, fire-and-forget, flow through Effect's logger.
 * Falls back to shutdownLog if the Effect runtime throws (e.g. during teardown).
 */
export const createClientLog = (services: Context.Context<unknown>): ClientLog => {
  const fork = Effect.runForkWith(services)

  const makeLogFn =
    (effectLog: (msg: string) => Effect.Effect<void>) =>
    (msg: string, data?: Schema.JsonObject) => {
      const logData = Option.fromNullishOr(data)
      let logEffect = effectLog(msg)
      if (Option.isSome(logData) && Object.keys(logData.value).length > 0) {
        logEffect = effectLog(msg).pipe(Effect.annotateLogs(logData.value))
      }
      const exit = Effect.runSyncExit(Effect.sync(() => fork(logEffect)))
      if (Exit.isFailure(exit)) shutdownLog(msg, data)
    }

  return {
    debug: makeLogFn(Effect.logDebug),
    info: makeLogFn(Effect.logInfo),
    warn: makeLogFn(Effect.logWarning),
    error: makeLogFn(Effect.logError),
  }
}

// ── client trace logging ────────────────────────────────────────────────────

/**
 * Batched JSON file logger at `path`; flushes on scope close.
 *
 * Creates the log directory first: `makeJsonFileLogger` opens the file and
 * does not make its parent, so the directory has to exist before the open.
 */
export const makeClientTraceLogger = (
  dir: string,
  path: string,
): Effect.Effect<
  Logger.Logger<unknown, void>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> => Effect.andThen(ensureLogDir(dir), makeJsonFileLogger(path))

/**
 * The TUI's Effect trace logger. Writes the SDK's JSON line format to
 * CLIENT_LOG_PATH, the file `clientLog` appends to, so all TUI logs land in one
 * place and `gent doctor` reads server and client logs with one parser.
 */
export const clientTraceLogger = makeClientTraceLogger(CLIENT_LOG_DIR, CLIENT_LOG_PATH)

// ── agent state ─────────────────────────────────────────────────────────────

interface AgentState {
  agent: Option.Option<AgentName>
  /**
   * Whether a turn runs. Only the runtime stream, the lifecycle events and the
   * snapshot write it; an error on screen never does.
   */
  running: boolean
  /**
   * How many turns the branch in view has started: the snapshot's completed
   * turns, plus the one it runs, plus each live start since. None until the
   * branch's first snapshot lands.
   */
  turnsStarted: Option.Option<number>
  /** The error on screen. A turn start clears it. */
  error: Option.Option<string>
  cost: number
  /**
   * What the next turn would use, resolved by the server from session
   * settings, config, and the agent definition (`SessionSnapshot.resolved*`).
   * Hydrated from the snapshot and refreshed after every settings change.
   */
  resolvedModelId: Option.Option<ModelId>
  resolvedReasoningLevel: Option.Option<ReasoningEffort>
}

// ── session state ───────────────────────────────────────────────────────────

export interface Session {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly name: string
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset model.
  readonly modelId: ModelId | undefined
  // eslint-disable-next-line effect/noNullish -- RPC session snapshots omit an unset reasoning level.
  readonly reasoningLevel: ReasoningEffort | undefined
  /**
   * The directory the session is rooted in, which is not always the TUI's
   * launch directory: `gent resume <id>` and a session switch reach sessions
   * rooted elsewhere. Absent until read when a switch named only the ids.
   */
  // eslint-disable-next-line effect/noNullish -- a switch by id carries no cwd until the session is read.
  readonly cwd: string | undefined
}

/** A change to the session's settings: a field left out stays as the server stores it. */
type SessionSettingsChange = Omit<UpdateSessionSettingsInput, "sessionId">

const SessionSchema: Schema.Schema<Session> = Schema.Struct({
  sessionId: SessionId,
  branchId: BranchId,
  name: Schema.String,
  modelId: Schema.UndefinedOr(ModelId),
  reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
  cwd: Schema.UndefinedOr(Schema.String),
})

export type SessionState =
  | { readonly status: "none" }
  | { readonly status: "creating" }
  | { readonly status: "active"; readonly session: Session }

export const SessionStateEvent = Schema.TaggedUnion({
  CreateRequested: {},
  CreateSucceeded: { session: SessionSchema },
  CreateFailed: {},
  Activated: { session: SessionSchema },
  Clear: {},
  UpdateName: { name: Schema.String },
  /** The session's cwd, read after a switch; ignored once the shell left that session. */
  UpdateCwd: { sessionId: SessionId, cwd: Schema.String },
  UpdateSettings: {
    modelId: Schema.UndefinedOr(ModelId),
    reasoningLevel: Schema.UndefinedOr(ReasoningEffort),
  },
})
export type SessionStateEvent = Schema.Schema.Type<typeof SessionStateEvent>

export const SessionState = {
  none: (): SessionState => ({ status: "none" }),
  creating: (): SessionState => ({ status: "creating" }),
  active: (session: Session): SessionState => ({ status: "active", session }),
}

const mapActive = (state: SessionState, update: (session: Session) => Session): SessionState => {
  if (state.status === "active") return SessionState.active(update(state.session))
  return state
}

export function transitionSessionState(
  state: SessionState,
  event: SessionStateEvent,
): SessionState {
  switch (event._tag) {
    case "CreateRequested":
      return SessionState.creating()
    case "CreateSucceeded":
    case "Activated":
      return SessionState.active(event.session)
    case "CreateFailed":
    case "Clear":
      return SessionState.none()
    case "UpdateName":
      return mapActive(state, (session) => ({ ...session, name: event.name }))
    case "UpdateCwd":
      return mapActive(state, (session) => {
        if (session.sessionId !== event.sessionId) return session
        return { ...session, cwd: event.cwd }
      })
    case "UpdateSettings":
      return mapActive(state, (session) => ({
        ...session,
        modelId: event.modelId,
        reasoningLevel: event.reasoningLevel,
      }))
  }
}

// ── event hub ───────────────────────────────────────────────────────────────

type ExtensionStatePulse = {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly extensionId: string
}

type ExtensionPulseCallback = (pulse: ExtensionStatePulse) => void
type SessionEventCallback = (envelope: EventEnvelope) => void

const decodeError = Schema.decodeUnknownOption(Schema.instanceOf(Error))
type ThrownInput = Parameters<typeof decodeError>[0]

const formatThrown = (error: ThrownInput): string =>
  Option.match(decodeError(error), {
    onNone: () => String(error),
    onSome: (cause) => cause.message,
  })

const createClientEventHub = (log: ClientLog) => {
  const extensionStateChangedSubscribers = new Set<ExtensionPulseCallback>()
  const sessionEventSubscribers = new Set<SessionEventCallback>()

  const onExtensionStateChanged = (cb: ExtensionPulseCallback): (() => void) => {
    extensionStateChangedSubscribers.add(cb)
    return () => {
      extensionStateChangedSubscribers.delete(cb)
    }
  }

  /**
   * What the feed has delivered since it opened on its branch. The feed opens
   * without waiting for client extensions, so one that subscribes later is
   * handed this history first, then the live envelopes.
   */
  let deliveredSessionEvents: Array<EventEnvelope> = []

  const deliverSessionEvent = (cb: SessionEventCallback, envelope: EventEnvelope): void => {
    const exit = Effect.runSyncExit(Effect.sync(() => cb(envelope)))
    if (Exit.isFailure(exit)) {
      log.warn("client.sessionEvent.subscriber.threw", {
        tag: envelope.event._tag,
        error: formatThrown(Cause.squash(exit.cause)),
      })
    }
  }

  const onSessionEvent = (cb: SessionEventCallback): (() => void) => {
    for (const envelope of deliveredSessionEvents) deliverSessionEvent(cb, envelope)
    sessionEventSubscribers.add(cb)
    return () => {
      sessionEventSubscribers.delete(cb)
    }
  }

  /** The feed opened on another branch: its history starts again. */
  const resetSessionEvents = (): void => {
    deliveredSessionEvents = []
  }

  const notifyExtensionStateChanged = (event: EventEnvelope["event"]): void => {
    if (event._tag !== "ExtensionStateChanged") return
    if (extensionStateChangedSubscribers.size === 0) return
    const pulse = {
      sessionId: event.sessionId,
      branchId: event.branchId,
      extensionId: event.extensionId,
    }
    for (const cb of extensionStateChangedSubscribers) {
      const exit = Effect.runSyncExit(Effect.sync(() => cb(pulse)))
      if (Exit.isFailure(exit)) {
        log.warn("client.extensionStateChanged.subscriber.threw", {
          extensionId: event.extensionId,
          error: formatThrown(Cause.squash(exit.cause)),
        })
      }
    }
  }

  const notifySessionEvent = (envelope: EventEnvelope): void => {
    deliveredSessionEvents.push(envelope)
    for (const cb of sessionEventSubscribers) deliverSessionEvent(cb, envelope)
  }

  return {
    onExtensionStateChanged,
    onSessionEvent,
    notifyExtensionStateChanged,
    notifySessionEvent,
    resetSessionEvents,
  }
}

// ── client provider ─────────────────────────────────────────────────────────

interface AgentLifecycleUpdate {
  /** Whether a turn runs after the event; none when the event does not say. */
  readonly running: Option.Option<boolean>
  /** The error the event shows. It leaves the turn as it is. */
  readonly error: Option.Option<string>
}

const lifecycleUpdate = (update: Partial<AgentLifecycleUpdate>): AgentLifecycleUpdate => ({
  running: Option.none(),
  error: Option.none(),
  ...update,
})

export const reduceAgentLifecycle = (event: AgentEvent): AgentLifecycleUpdate => {
  switch (event._tag) {
    case "StreamStarted":
      return lifecycleUpdate({ running: Option.some(true) })
    case "TurnCompleted":
      return lifecycleUpdate({ running: Option.some(false) })
    case "ErrorOccurred":
      // A notice is not an error on screen.
      if (event.notice === true) return lifecycleUpdate({})
      return lifecycleUpdate({ error: Option.some(event.error) })
    case "MessageReceived":
      if (event.message.role === "user") return lifecycleUpdate({ running: Option.some(true) })
      return lifecycleUpdate({})
    default:
      return lifecycleUpdate({})
  }
}

/** Not connected yet, or not any more: both mean the next reply may not come. */
const isReconnectingState = ConnectionState.isAnyOf(["Connecting", "Reconnecting"])

/**
 * What this UI can ask a running loop to do.
 *
 * Narrower than the wire `SteerCommand` on purpose. The domain also carries
 * `Interrupt`, which the loop folds into `Cancel` (`agent-loop.actor.ts:763`),
 * and `wake` on an interjection, which this UI never needs: it interjects only
 * into a streaming turn, and an idle branch takes an ordinary `sendMessage`
 * that starts a turn by itself.
 *
 * An interjection names no agent: the agent is a property of the session.
 */
export const SteerCommandInput = Schema.TaggedUnion({
  Cancel: {},
  Interject: { message: Schema.String },
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
  /** The generation of the open connection; None while it is not connected. */
  connectedGeneration: () => Option.Option<number>
  isReconnecting: () => boolean
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
  /**
   * Subscribe to every event for the active session/branch. A late subscriber
   * first receives what the feed delivered since it opened on the branch.
   */
  onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
  /** The feed opened on another branch; the delivered history starts again. */
  resetSessionEvents: () => void
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
export interface SessionIdentity {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}

/** One session and branch: the one comparison every identity check uses. */
export const sameIdentity = (left: SessionIdentity, right: SessionIdentity): boolean =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

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
  /**
   * The directory `@file` and `!cmd` resolve against: the active session's
   * cwd, read from the server when the record does not carry it yet. The
   * launch directory stands in only with no session, or for a stored session
   * that names no cwd.
   */
  sessionCwd: Effect.Effect<string, GentClientRpcError>
  /** The directory a given session resolves against, whether or not it is active. */
  cwdOf: (sessionId: SessionId) => Effect.Effect<string, GentClientRpcError>

  // Session actions (fire-and-forget, update state internally)
  /** Create a session and make it the active one. */
  createSession: () => void
  /** Open the session a confirmed handoff produces: linked to the current one, seeded with the summary. */
  openHandoffSession: (summary: string) => void
  switchSession: (sessionId: SessionId, branchId: BranchId, name: string) => void
  clearSession: () => void
  /**
   * Change the session's settings. Only the fields the change names are sent;
   * the server merges them into what it stores, and its reply is folded back.
   */
  updateSessionSettings: (change: SessionSettingsChange) => Effect.Effect<void, GentClientRpcError>

  // Sync data fetching helpers (return Effects for caller to run)
  listMessages: Effect.Effect<readonly Message[], GentClientRpcError>
  listBranches: Effect.Effect<readonly Branch[], GentClientRpcError>
  createBranch: (name?: string) => Effect.Effect<BranchId, GentClientRpcError>
  getBranchTree: Effect.Effect<readonly BranchTreeNode[], GentClientRpcError>
  forkBranch: (messageId: MessageId, name?: string) => Effect.Effect<BranchId, GentClientRpcError>
  drainQueuedMessages: Effect.Effect<QueueSnapshot, GentClientRpcError>
  getQueuedMessages: Effect.Effect<QueueSnapshot, GentClientRpcError>

  // Branch navigation (fire-and-forget)
  switchBranch: (branchId: BranchId) => void
}

/**
 * The context gauge's whole input.
 *
 * The two halves are one value because `buildContextLabels` prefers the
 * projection over the live token count whenever it carries an input budget. Held apart,
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
  cost: () => number
  /** The model the next turn would use: session setting, else the server-resolved default. */
  model: () => string
  // eslint-disable-next-line effect/noNullish -- UI agent accessors expose absence before hydration.
  reasoningLevel: () => ReasoningEffort | undefined
  /** The reasoning level config/agent would apply without a session override. */
  resolvedReasoningLevel: () => Option.Option<ReasoningEffort>
  // Derived accessors
  /** Whether a turn runs; an error on screen does not change it. */
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
  /** `models`, or `None` until the catalog's first load settles; a failed load settles empty. */
  modelCatalog: () => Option.Option<ReadonlyArray<Model>>

  /** Show a local error. It leaves the turn as it is; the next turn start clears it. */
  setError: (error: string) => void
  /**
   * An error that belongs to one session, such as a send it refused. The
   * session in view shows it now; another session keeps it until the reader
   * returns there, and the session in view shows nothing of it.
   */
  setErrorIn: (target: SessionIdentity, error: string) => void
  /**
   * The last extension notice (`ClientContext.shell.notify`). It sits beside the
   * turn status, not in it: a notice leaves a running turn running and a
   * standing error standing. The next notice replaces it; a new turn or a
   * session change clears it.
   */
  notice: () => Option.Option<string>
  setNotice: (message: string) => void
  /** Run a fallible call; a failure lands formatted in the error line and stops there. */
  surfaceError: <A, R>(effect: Effect.Effect<A, UiError, R>) => Effect.Effect<void, never, R>
}

interface ClientActionValue {
  /**
   * Send to the session the content was drafted in, not whichever is active
   * when it lands. A rejected send fails, so the caller can give the text back.
   * The caller names the request id: a text sent again after a lost reply
   * reuses it, so the server's dedup runs it once.
   */
  sendMessage: (
    target: SessionIdentity,
    content: string,
    requestId: string,
  ) => Effect.Effect<void, GentClientRpcError>
  /** Steer the target's loop; a rejected command fails for the caller to report. */
  steer: (
    target: SessionIdentity,
    command: SteerCommandInput,
    requestId: string,
  ) => Effect.Effect<void, GentClientRpcError>
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
  // The agent startup resolved for the startup session holds until its
  // snapshot lands. Past startup a session's snapshot names its agent; with
  // no session, the default agent is the one a new session gets.
  const initialAgent = Option.orElse(Option.fromNullishOr(props.initialAgent), () =>
    Option.match(initialSession, {
      onNone: () => Option.some(DEFAULT_AGENT_NAME),
      onSome: () => Option.none(),
    }),
  )
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
      equals: Option.makeEquivalence<SessionIdentity>(sameIdentity),
    },
  )
  const activeSessionId = createMemo(
    () => Option.map(sessionIdentity(), (identity) => identity.sessionId),
    Option.none<SessionId>(),
    { equals: Option.makeEquivalence<SessionId>((left, right) => left === right) },
  )
  const isActive = () => sessionState().status === "active"
  const isLoading = () => sessionState().status === "creating"

  const cwdOf = (sessionId: SessionId): Effect.Effect<string, GentClientRpcError> =>
    Effect.suspend(() => {
      const known = sessionOption().pipe(
        Option.filter((current) => current.sessionId === sessionId),
        Option.flatMap((current) => Option.fromUndefinedOr(current.cwd)),
      )
      if (Option.isSome(known)) return Effect.succeed(known.value)
      return readCwd(sessionId)
    })
  const readCwd = (sessionId: SessionId): Effect.Effect<string, GentClientRpcError> =>
    client.session.get({ sessionId }).pipe(
      Effect.map((stored) =>
        Option.fromNullishOr(stored).pipe(
          Option.flatMap((value) => Option.fromUndefinedOr(value.cwd)),
        ),
      ),
      Effect.tap((cwd) =>
        Effect.sync(() => {
          if (Option.isNone(cwd)) return
          dispatchSession(SessionStateEvent.cases.UpdateCwd.make({ sessionId, cwd: cwd.value }))
        }),
      ),
      Effect.map(Option.getOrElse(() => workspace.cwd)),
    )
  const sessionCwd: Effect.Effect<string, GentClientRpcError> = Effect.suspend(() =>
    Option.match(sessionOption(), {
      onNone: () => Effect.succeed(workspace.cwd),
      onSome: (current) => cwdOf(current.sessionId),
    }),
  )

  // A session reached by id alone reads its cwd once, so the status row names
  // where it is rooted before anything is submitted.
  createEffect(
    on(activeSessionId, () => {
      const current = sessionOption()
      if (Option.isNone(current) || Predicate.isNotUndefined(current.value.cwd)) return
      cast(sessionCwd.pipe(Effect.catchEager(() => Effect.void)))
    }),
  )

  // The catalog is the active session's profile: a project model driver
  // appears once that session is active, a disabled one disappears.
  let modelCatalogLoadVersion = 0
  createEffect(
    on(activeSessionId, (sessionId) => {
      const version = ++modelCatalogLoadVersion
      const request = omitUndefined({ sessionId: Option.getOrUndefined(sessionId) })
      cast(
        Effect.all({
          models: client.model.list(request),
          drivers: client.driver.list(request),
        }).pipe(
          Effect.tap(({ models, drivers }) =>
            Effect.sync(() => {
              if (version !== modelCatalogLoadVersion) return
              const modelsById: Record<string, Model> = {}
              for (const model of models) modelsById[model.id] = model
              const agentsByName: Record<string, AgentDefinition> = {}
              for (const agent of drivers.agents) agentsByName[agent.name] = agent
              const driverIds = drivers.drivers.map((driver) => driver.id)
              setModelStore({ modelsById, agentsByName, driverIds, settled: true })
            }),
          ),
          Effect.catchEager((err) =>
            Effect.sync(() => {
              if (version !== modelCatalogLoadVersion) return
              const error = formatError(err)
              log.error("model.list.failed", { error })
              setAgentStore({ error: Option.some(error) })
              // A reader waiting for the catalog goes on with what it holds.
              setModelStore({ settled: true })
            }),
          ),
        ),
      )
    }),
  )

  // Agent state (derived from events)
  const [agentStore, setAgentStore] = createStore<AgentState>({
    agent: initialAgent,
    running: false,
    turnsStarted: Option.none(),
    error: Option.none(),
    cost: 0,
    resolvedModelId: Option.none(),
    resolvedReasoningLevel: Option.none(),
  })
  const [sessionMetrics, setSessionMetrics] = createSignal<SessionMetrics>(EMPTY_SESSION_METRICS)
  const [notice, setNoticeState] = createSignal<Option.Option<string>>(Option.none())

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

  // The error each session last showed, until a later error or a turn start
  // replaces it. A snapshot writes the error on screen, so every snapshot shows
  // the held error again: the one the reader returns to, the one just switched
  // to, and a feed that hydrates again after a reconnect.
  //
  // A turn start clears it whether the start arrives live or inside a
  // snapshot: the feed skips the lifecycle events a snapshot covers, so a turn
  // that started while the connection was down shows only as a snapshot that
  // counts more started turns than the error was shown against. An error held
  // for a branch not in view has no count yet; its first snapshot sets it.
  interface HeldError {
    readonly error: string
    readonly turnsStarted: Option.Option<number>
  }
  const heldErrors = new Map<string, HeldError>()
  const identityKey = (identity: SessionIdentity) =>
    `${identity.sessionId}\u0000${identity.branchId}`
  /** Write the error on screen for the session in view; it replaces that session's held error. */
  const showError = (error: Option.Option<string>): void => {
    Option.map(sessionOption(), (current) => heldErrors.delete(identityKey(current)))
    setAgentStore({ error })
  }
  /** Write whether a turn runs. A turn start clears the error on screen. */
  const setRunning = (running: boolean): void => {
    if (running && !agentStore.running) {
      showError(Option.none())
      setAgentStore({ turnsStarted: Option.map(agentStore.turnsStarted, (count) => count + 1) })
    }
    setAgentStore({ running })
  }
  /** The held error a snapshot shows; one shown before a later turn started is dropped. */
  const heldErrorFor = (snapshot: SessionSnapshot, turnsStarted: number): Option.Option<string> => {
    const key = identityKey(snapshot)
    const held = Option.fromUndefinedOr(heldErrors.get(key))
    if (Option.isNone(held)) return Option.none()
    if (Option.exists(held.value.turnsStarted, (shownAt) => turnsStarted > shownAt)) {
      heldErrors.delete(key)
      return Option.none()
    }
    heldErrors.set(key, { error: held.value.error, turnsStarted: Option.some(turnsStarted) })
    return Option.some(held.value.error)
  }

  /**
   * Drop everything the previous session left behind.
   *
   * All three session changes go through here so none can reset a subset.
   * {@link SessionMetrics} is one value for the same reason: its two halves
   * cannot be cleared apart.
   *
   * Extension health belongs to the session rather than the branch, so a
   * branch switch within one session says not to clear it.
   */
  const resetForSession = (input: {
    readonly agent: Option.Option<AgentName>
    readonly clearExtensionHealth: boolean
  }): void => {
    setAgentStore({
      agent: input.agent,
      running: false,
      turnsStarted: Option.none(),
      error: Option.none(),
      cost: 0,
      resolvedModelId: Option.none(),
      resolvedReasoningLevel: Option.none(),
    })
    setSessionMetrics(EMPTY_SESSION_METRICS)
    setNoticeState(Option.none())
    clearConnectionIssue()
    if (input.clearExtensionHealth) setExtensionHealth(EMPTY_EXTENSION_HEALTH)
  }

  const [modelStore, setModelStore] = createStore<{
    modelsById: Record<string, Model>
    agentsByName: Record<string, AgentDefinition>
    /** Ids of the registered model drivers; a model needs one to run. */
    driverIds: readonly string[]
    /** The first catalog load has answered, with the catalog or with a failure. */
    settled: boolean
  }>({
    modelsById: {},
    agentsByName: {},
    driverIds: [],
    settled: false,
  })

  createEffect(() => {
    const unsubscribe = runtime.lifecycle.subscribe((nextState) => {
      const connectionDetails: Record<string, string | number> = {}
      if ("generation" in nextState) connectionDetails["generation"] = nextState.generation
      log.info("connection.state", {
        tag: nextState._tag,
        ...connectionDetails,
      })
      setConnectionState(Option.some(nextState))
    })
    onCleanup(unsubscribe)
  })

  const connectedGeneration = createMemo<Option.Option<number>>(
    () => {
      const state = connectionState()
      if (Option.isNone(state) || state.value._tag !== "Connected") return Option.none()
      return Option.some(state.value.generation)
    },
    Option.none<number>(),
    { equals: Option.makeEquivalence<number>((left, right) => left === right) },
  )

  const isReconnecting = () => {
    const state = connectionState()
    if (Option.isNone(state)) return false
    return isReconnectingState(state.value)
  }

  let extensionHealthLoadVersion = 0

  const extensionHealthDependencies = (): readonly [
    Option.Option<number>,
    Option.Option<SessionId>,
  ] => [connectedGeneration(), Option.map(sessionOption(), (value) => value.sessionId)]

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
    setRunning(input.runtime._tag !== "Idle")
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
      // The snapshot names no cwd; the record keeps the one it has.
      cwd: Option.getOrUndefined(
        Option.flatMap(currentSession, (value) => Option.fromUndefinedOr(value.cwd)),
      ),
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
    const running = snapshot.runtime._tag !== "Idle"
    let turnsStarted = snapshot.metrics.turns
    if (running) turnsStarted += 1
    setAgentStore({
      agent: Option.some(snapshot.agent),
      running,
      turnsStarted: Option.some(turnsStarted),
      error: heldErrorFor(snapshot, turnsStarted),
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
    Option.map(lifecycle.running, setRunning)
    if (Option.isSome(lifecycle.error)) showError(lifecycle.error)
    // A user message starts the next turn; the notice from before it is spent.
    if (event._tag === "MessageReceived" && event.message.role === "user") {
      setNoticeState(Option.none())
    }
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
    connectedGeneration,
    isReconnecting,
    extensionHealth,
    connectionIssue: connectionIssueValue,
    setConnectionIssue,
    onExtensionStateChanged: eventHub.onExtensionStateChanged,
    onSessionEvent: eventHub.onSessionEvent,
    resetSessionEvents: eventHub.resetSessionEvents,
    applySessionRuntime,
    applySessionSnapshot,
    applySessionEvent,
    applyBufferedSessionEvent,
  }

  const createSessionWith = (
    input: Pick<
      CreateSessionInput,
      "parentSessionId" | "parentBranchId" | "continueThread" | "initialPrompt"
    >,
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
            // "none"), so extension health is cleared unconditionally. The
            // session's snapshot names its agent: a handoff inherits its
            // parent's, so assuming the default would flicker.
            resetForSession({ agent: Option.none(), clearExtensionHealth: true })
            dispatchSession(
              SessionStateEvent.cases.CreateSucceeded.make({
                session: {
                  sessionId: result.sessionId,
                  branchId: result.branchId,
                  name: result.name,
                  modelId: Option.getOrUndefined(Option.none()),
                  reasoningLevel: Option.getOrUndefined(Option.none()),
                  cwd: workspace.cwd,
                },
              }),
            )
          }),
        ),
        Effect.catchEager((err) =>
          Effect.sync(() => {
            log.error("createSession.failed", { error: String(err) })
            dispatchSession(SessionStateEvent.cases.CreateFailed.make({}))
            showError(Option.some(formatError(err)))
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
    sessionCwd,
    cwdOf,

    createSession: () => createSessionWith({}),

    openHandoffSession: (summary) => {
      const current = sessionOption()
      if (Option.isNone(current)) return
      createSessionWith({
        parentSessionId: current.value.sessionId,
        parentBranchId: current.value.branchId,
        continueThread: true,
        initialPrompt: summary,
      })
    },

    switchSession: (sessionId, branchId, name) => {
      const current = sessionOption()
      // Choosing the session already in view changes nothing. A reset here
      // would clear its status, metrics and settings, and no snapshot comes to
      // restore them: the identity did not change, so the feed does not re-run.
      if (Option.exists(current, (value) => sameIdentity(value, { sessionId, branchId }))) return
      const currentSessionId = Option.map(current, (value) => value.sessionId)
      // A branch switch stays in the session's directory; another session's
      // directory is read when something asks for it.
      const cwd = Option.getOrUndefined(
        Option.flatMap(
          Option.filter(current, (value) => value.sessionId === sessionId),
          (value) => Option.fromUndefinedOr(value.cwd),
        ),
      )
      resetForSession({
        // The session's snapshot names its agent.
        agent: Option.none(),
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
            cwd,
          },
        }),
      )
    },

    clearSession: () => {
      dispatchSession(SessionStateEvent.cases.Clear.make({}))
      resetForSession({ agent: Option.some(DEFAULT_AGENT_NAME), clearExtensionHealth: true })
    },

    listMessages: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return [] satisfies readonly Message[]
      return yield* client.message.list({ branchId: currentSession.value.branchId })
    }),

    listBranches: Effect.gen(function* () {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return [] satisfies readonly Branch[]
      return yield* client.branch.list({ sessionId: currentSession.value.sessionId })
    }),

    updateSessionSettings: (change) => {
      const currentSession = sessionOption()
      if (Option.isNone(currentSession)) return Effect.void
      const s = currentSession.value
      return client.session.updateSettings({ ...change, sessionId: s.sessionId }).pipe(
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
          Effect.tapError((err) => Effect.sync(() => showError(Option.some(formatError(err))))),
        ),
      )
    },
  }
  const runnableModels = (): readonly Model[] =>
    Object.values(modelStore.modelsById).filter((model) =>
      modelStore.driverIds.includes(model.provider),
    )
  // The agent's name, held as a memo. Every session snapshot writes a new
  // `Option` for the agent (a reconnect refetches one), and a write of the
  // same name is not a new agent: the effects keyed on it (the auth gate, the
  // auth pane's catalog) must not run again and reset an open sign-in.
  const agentName = createMemo(() => Option.getOrUndefined(agentStore.agent))
  const agentValue: ClientAgentValue = {
    agent: agentName,
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
    isStreaming: () => agentStore.running,
    isError: () => Option.isSome(agentStore.error),
    error: () => Option.getOrNull(agentStore.error),
    sessionMetrics,
    modelInfo: () => modelStore.modelsById[agentValue.model()],
    models: runnableModels,
    modelCatalog: () => {
      if (!modelStore.settled) return Option.none()
      return Option.some(runnableModels())
    },
    setErrorIn: (target, error) => {
      // The session in view shows it now. Either way it is held, so the
      // session's next snapshot shows it again over the status it writes.
      const inView = Option.exists(sessionOption(), (current) => sameIdentity(current, target))
      if (inView) agentValue.setError(error)
      // Shown against the turns the branch in view has started; a branch not
      // in view gets its count from its first snapshot.
      let turnsStarted = Option.none<number>()
      if (inView) turnsStarted = agentStore.turnsStarted
      heldErrors.set(identityKey(target), { error, turnsStarted })
    },
    setError: (error) => showError(Option.some(error)),
    notice,
    setNotice: (message) => setNoticeState(Option.some(message)),
    surfaceError: (effect) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchEager((error) => Effect.sync(() => agentValue.setError(formatError(error)))),
      ),
  }

  const actionValue: ClientActionValue = {
    sendMessage: Effect.fn("TUI.sendMessage")(function* (s, content, requestId) {
      log.info("sendMessage", { sessionId: s.sessionId, branchId: s.branchId, requestId })
      yield* client.message
        .send({
          sessionId: s.sessionId,
          branchId: s.branchId,
          content,
          requestId,
        })
        .pipe(Effect.retry(SEND_RETRY))
    }),
    steer: Effect.fn("TUI.steer")(function* (s, command, requestId) {
      const fullCommand: SteerCommand = {
        ...command,
        sessionId: s.sessionId,
        branchId: s.branchId,
        requestId,
      }
      yield* client.steer.command({ command: fullCommand }).pipe(Effect.retry(SEND_RETRY))
    }),
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

// ── runtime hook ────────────────────────────────────────────────────────────

/**
 * Effect execution hook for Solid
 * Provides call (tracked) and cast (fire-and-forget) for Effect execution.
 *
 * Effects are forked against the host-provided `services` context — wired
 * once at the TUI root (`<ClientProvider services={uiServices}>`) per
 * [[central-provider-wiring]]. Component effects requiring platform
 * services (`FileSystem`, `ChildProcessSpawner`, …) execute without any
 * per-call-site `Effect.provide`.
 */

interface UseRuntimeReturn {
  /** Run Effect, interrupting it when the owning component unmounts. */
  call: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
  /** Fire and forget - runs Effect without tracking result */
  cast: <A, E, R>(effect: Effect.Effect<A, E, R>) => void
}

/**
 * Hook to run Effects with the host-provided platform context.
 */
export function useRuntime(): UseRuntimeReturn {
  const { services, log } = useClient()

  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    // The runtime context is captured at the UI boundary. Its map contains the
    // services required by the caller-supplied effect.
    Effect.runForkWith(Context.makeUnsafe<R>(services.mapUnsafe))(effect)

  const call = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = fork(effect)

    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        log.error("call.failed", { error: Cause.pretty(exit.cause) })
      }
    })

    onCleanup(() => {
      Effect.runFork(Fiber.interrupt(fiber))
    })
  }

  const cast = <A, E, R>(effect: Effect.Effect<A, E, R>): void => {
    const fiber = fork(effect)
    fiber.addObserver((exit) => {
      if (Exit.isFailure(exit)) {
        log.error("cast.failed", { error: Cause.pretty(exit.cause) })
      }
    })
  }

  return { call, cast }
}
