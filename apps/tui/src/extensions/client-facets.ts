import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type ManagedRuntime,
  Option,
  type Path,
  Schema,
  Scope,
} from "effect"
import {
  type ActiveInteraction,
  type AgentName,
  type ApprovalResult,
  type BranchId,
  type DriverListResult,
  type EventEnvelope,
  type Message,
  type Session,
  SessionId,
} from "@gent/core/protocol"
import type { GentClientRpcError, GentNamespacedClient, GentRuntime } from "@gent/sdk"
import type { CapabilityRef, DriverRef } from "@gent/core/extensions/api"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { ToolRenderer } from "../tool-renderers"
import type { HeadlessToolRenderer } from "../headless"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"

// ── effect boundary ─────────────────────────────────────────────────────────

/**
 * ClientEffect — the Effect-typed authoring surface for TUI client extensions.
 *
 * Extension setup reads dependencies from `ClientDeps` and returns
 * `ClientContributions` through an Effect, with errors surfaced
 * on the typed `ClientSetupError` channel.
 *
 * The runtime accepts only the Effect setup shape.
 *
 * Solid integration: extensions return contributions; the TUI shell owns one
 * per-provider `ManagedRuntime` widened with the union of services any
 * Effect-typed setup may yield (e.g. `FileSystem | Path | ClientTransport`),
 * and runs each setup via `runtime.runPromise`. Async work inside
 * contributions (autocomplete `items`, etc.) is wired via the same runtime —
 * the seam is at the rendering edge, not in the Effect surface.
 *
 * Layering: `ClientDeps` is the TUI-local *floor* (`FileSystem | Path`).
 * Each client surface (TUI shell, future SDK headless, web UI) augments its
 * runtime with the services its extensions need, and an extension widens its
 * `R` accordingly. The TUI shell publishes its typed `ClientTransport` tag
 * at `apps/tui/src/extensions/client-facets.ts` because the SDK client
 * types (`GentNamespacedClient`, `GentRuntime`) live downstream of `@gent/core`.
 */

// ── Errors ────────────────────────────────────────────────────────────────

/** Failure surfaced from a client extension's `setup` Effect. */
export class ClientSetupError extends Schema.TaggedError<ClientSetupError>()("ClientSetupError", {
  extensionId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ── Transport ─────────────────────────────────────────────────────────────

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * The dependency channel a client extension's setup Effect MAY require.
 *
 * `ClientDeps` is the TUI-local floor: file system and path
 * services. It's a *floor*, not a ceiling — an individual client surface
 * (the TUI shell, a future SDK headless, a web UI) augments its runtime
 * with additional services like transport, theming, or platform-specific
 * APIs, and an extension that yields one of those declares a wider `R`.
 *
 * `@gent/core` does NOT declare `ClientTransport` because its payload type
 * lives downstream (`GentNamespacedClient` + `GentRuntime` are SDK types).
 * The TUI declares its own `ClientTransport` tag with a typed payload at
 * `apps/tui/src/extensions/client-facets.ts`. Other
 * client surfaces would do the same with whatever transport they speak.
 */
type ClientDeps = FileSystem.FileSystem | Path.Path

// ── ClientEffect ──────────────────────────────────────────────────────────

/**
 * An Effect that returns a value, may fail with `ClientSetupError`, and may
 * read from any subset of services its runtime provides. `R` defaults to
 * `ClientDeps` — the floor — so a setup that only needs `FileSystem`/`Path`
 * compiles without ceremony. Extensions needing more (transport, theme,
 * shell-specific services) widen `R` themselves; the loader's runtime
 * provides whatever services the extension yields.
 */
export type ClientEffect<Value, Error = ClientSetupError, Services = ClientDeps> = Effect.Effect<
  Value,
  Error,
  Services
>

// ── activity facet ──────────────────────────────────────────────────────────

/** Current UI activity for terminal integrations. No event replay or private state mirror. */

export const ClientActivitySnapshot = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  state: Schema.Literals(["idle", "working", "blocked", "unknown"]),
})
export type ClientActivitySnapshot = typeof ClientActivitySnapshot.Type

/**
 * Absence has one encoding: a surface with nothing to report reports
 * `"unknown"`. A reader never re-tests a decision the composition root made.
 */
export class ClientActivity extends Context.Service<
  ClientActivity,
  { readonly snapshot: () => ClientActivitySnapshot }
>()("@gent/tui/src/extensions/client-facets/ClientActivity") {}

const unknownActivity = (): ClientActivitySnapshot => ({ state: "unknown" })

export const makeClientActivityLayer = (snapshot: () => ClientActivitySnapshot = unknownActivity) =>
  Layer.succeed(ClientActivity, ClientActivity.of({ snapshot }))

// ── transport facet ─────────────────────────────────────────────────────────

/**
 * TUI-side `ClientTransport` — typed transport surface for client extensions.
 *
 * Core can't declare this with typed payloads because TUI extension transport
 * runs above the SDK. The TUI shell owns the raw SDK client/runtime and
 * publishes only typed extension request/session/event helpers here.
 *
 * Usage from a client extension:
 *
 *   ```ts
 *   import { Effect } from "effect"
 *   import { ClientTransport } from "../client-transport"
 *
 *   export default defineClientExtension("@gent/x", {
 *     id: "@gent/x",
 *     setup: Effect.gen(function* () {
 *       const transport = yield* ClientTransport
 *       const result = yield* transport.request(ref(MyRpc.List), {})
 *       return [...]
 *     }),
 *   })
 *   ```
 *
 * The TUI's `ExtensionUIProvider` constructs a per-render `ManagedRuntime`
 * that includes `BunFileSystem | BunPath | ClientTransport.Live(payload)`,
 * passes it to `loadTuiExtensions`, and the loader's `invokeSetup` runs
 * each Effect-typed setup against it.
 */

type ActiveExtensionSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

/**
 * Per-loop detail, for one loop at a time.
 *
 * Enumerating every loop must not fan out into N snapshot reads, so listings
 * carry identity and liveness only and a client asks for this separately —
 * for the row a reader is actually looking at. Every field is optional
 * because a session that has never streamed has no model and no cost yet.
 */
export interface ExtensionAgentDetail {
  /** Runtime state tag, e.g. `"Idle"` / `"Running"`. */
  readonly status: Option.Option<string>
  readonly model: Option.Option<string>
  readonly turns: number
  readonly costUsd: number
  readonly durationMs: number
  /** Messages the last projection left out of the model's view; 0 before a turn has run. */
  readonly omittedMessages: number
}

export interface ClientTransportDefinition {
  /** Active (sessionId, branchId) — absent before a session is mounted. */
  // eslint-disable-next-line effect/noNullish -- extension transport preserves an absent active session.
  readonly currentSession: () => ActiveExtensionSession | undefined
  readonly request: <Input, Output>(
    ref: CapabilityRef<Input, Output>,
    input: Input,
    activeSession?: ActiveExtensionSession,
  ) => Effect.Effect<
    Output,
    NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError
  >
  /** Subscribe to `ExtensionStateChanged` pulses from the active session.
   *  Returns an unsubscribe function. Multiple subscribers receive each
   *  pulse independently. Widgets use this to invalidate cached state
   *  when their server-side extension publishes a state change. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
  /** Subscribe to every event for the active session/branch. */
  readonly onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
  /**
   * Read live detail for one loop, by explicit key rather than the active
   * session: the caller is asking about a row, which is usually not the
   * session the shell is on.
   */
  readonly agentDetail: (
    key: ActiveExtensionSession,
  ) => Effect.Effect<ExtensionAgentDetail, ClientTransportRequestError>
  /** Delete a session and its descendants; their loops stop and their rows go. */
  readonly deleteSession: (sessionId: SessionId) => Effect.Effect<void, ClientTransportRequestError>
  /**
   * The sessions of one thread, oldest first.
   *
   * Sessions carry the thread they belong to, so a compaction handoff stays in
   * the thread it continues while a delegate run or a `/btw` side question sits
   * in its own. Membership is the server's answer; nothing here re-derives it.
   */
  readonly threadSessions: (
    sessionId: SessionId,
  ) => Effect.Effect<ReadonlyArray<Session>, ClientTransportRequestError>
  /** Every durable message on one branch, in order. */
  readonly listMessages: (
    branchId: BranchId,
  ) => Effect.Effect<ReadonlyArray<Message>, ClientTransportRequestError>
  /** Every registered driver plus the per-agent override map. */
  readonly driverList: Effect.Effect<DriverListResult, ClientTransportRequestError>
  /** Route one agent to a driver; the server rejects unknown driver ids. */
  readonly driverSet: (input: {
    readonly agentName: AgentName
    readonly driver: DriverRef
  }) => Effect.Effect<void, ClientTransportRequestError>
  /** Remove one agent's driver override. */
  readonly driverClear: (input: {
    readonly agentName: AgentName
  }) => Effect.Effect<void, ClientTransportRequestError>
}

export interface ClientShellTransportDefinition {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
  /** Active (sessionId, branchId) — absent before a session is mounted. */
  // eslint-disable-next-line effect/noNullish -- extension transport preserves an absent active session.
  readonly currentSession: () => ActiveExtensionSession | undefined
  /** Subscribe to `ExtensionStateChanged` pulses from the active session.
   *  Returns an unsubscribe function. Multiple subscribers receive each
   *  pulse independently. Widgets use this to invalidate cached state
   *  when their server-side extension publishes a state change. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
  /** Subscribe to every event for the active session/branch. */
  readonly onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
}

export class ClientTransport extends Context.Service<ClientTransport, ClientTransportDefinition>()(
  "@gent/tui/src/extensions/client-facets/ClientTransport",
) {}

/**
 * Build a Layer providing `ClientTransport` from a connected `useClient()`
 * result. The input carries shell authority; the provided service does not.
 */
export const makeClientTransportLayer = (
  payload: ClientShellTransportDefinition,
): Layer.Layer<ClientTransport> => {
  const transport: ClientTransportDefinition = {
    currentSession: payload.currentSession,
    request: <Input, Output>(
      ref: CapabilityRef<Input, Output>,
      input: Input,
      activeSession?: ActiveExtensionSession,
    ) => requestExtensionAt(payload, ref, input, activeSession),
    onExtensionStateChanged: payload.onExtensionStateChanged,
    onSessionEvent: payload.onSessionEvent,
    agentDetail: (key) => agentDetailAt(payload, key),
    deleteSession: (sessionId) =>
      shellRead(payload, "session.delete", (client) => client.session.delete({ sessionId })).pipe(
        Effect.asVoid,
      ),
    threadSessions: (sessionId) =>
      shellRead(payload, "session.thread", (client) => client.session.thread({ sessionId })),
    listMessages: (branchId) =>
      shellRead(payload, "message.list", (client) => client.message.list({ branchId })),
    driverList: shellRead(payload, "driver.list", (client) => client.driver.list()),
    driverSet: (input) =>
      shellRead(payload, "driver.set", (client) => client.driver.set(input)).pipe(Effect.asVoid),
    driverClear: (input) =>
      shellRead(payload, "driver.clear", (client) => client.driver.clear(input)).pipe(
        Effect.asVoid,
      ),
  }
  return Layer.succeed(ClientTransport, transport)
}

// ── request helper ────────────────────────────────────────────────────────

export class NoActiveSessionError extends Schema.TaggedError<NoActiveSessionError>()(
  "NoActiveSessionError",
  {},
) {}

export class ClientTransportRequestError extends Schema.TaggedError<ClientTransportRequestError>()(
  "ClientTransportRequestError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ClientTransportReplyDecodeError extends Schema.TaggedError<ClientTransportReplyDecodeError>()(
  "ClientTransportReplyDecodeError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const currentOrActiveSession = (
  transport: ClientShellTransportDefinition,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<ActiveExtensionSession, NoActiveSessionError> => {
  const session = Option.orElse(Option.fromNullishOr(activeSession), () =>
    Option.fromNullishOr(transport.currentSession()),
  )
  if (Option.isNone(session)) return Effect.fail(new NoActiveSessionError())
  return Effect.succeed(session.value)
}

const requestExtensionAt = <Input, Output>(
  transport: ClientShellTransportDefinition,
  ref: CapabilityRef<Input, Output>,
  input: Input,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<
  Output,
  NoActiveSessionError | ClientTransportRequestError | ClientTransportReplyDecodeError,
  never
> =>
  Effect.gen(function* () {
    const session = yield* currentOrActiveSession(transport, activeSession)
    const reply = yield* Effect.tryPromise({
      try: () =>
        transport.runtime.run(
          transport.client.extension.request({
            sessionId: session.sessionId,
            extensionId: ref.extensionId,
            capabilityId: ref.capabilityId,
            input,
            branchId: session.branchId,
          }),
        ),
      catch: (cause) =>
        new ClientTransportRequestError({
          extensionId: ref.extensionId,
          tag: ref.capabilityId,
          message: `request failed: ${String(cause)}`,
          cause,
        }),
    })
    return yield* Schema.decodeUnknownEffect(ref.output)(reply).pipe(
      Effect.mapError(
        (cause) =>
          new ClientTransportReplyDecodeError({
            extensionId: ref.extensionId,
            tag: ref.capabilityId,
            message: `reply decode failed: ${String(cause)}`,
            cause,
          }),
      ),
    )
  })

/** One shell RPC read, with its failure named by the RPC it came from. */
const shellRead = <A>(
  transport: ClientShellTransportDefinition,
  tag: string,
  read: (client: GentNamespacedClient) => Effect.Effect<A, GentClientRpcError>,
): Effect.Effect<A, ClientTransportRequestError> =>
  Effect.tryPromise({
    try: () => transport.runtime.run(read(transport.client)),
    catch: (cause) =>
      new ClientTransportRequestError({
        extensionId: "@gent/tui/client-transport",
        tag,
        message: `${tag} failed: ${String(cause)}`,
        cause,
      }),
  })

/**
 * Narrow the session snapshot down to the fields a per-loop detail line shows.
 *
 * The snapshot also carries the full projected message list; a detail line has
 * no use for it, so the extension surface never sees it.
 */
const agentDetailAt = (
  transport: ClientShellTransportDefinition,
  key: ActiveExtensionSession,
): Effect.Effect<ExtensionAgentDetail, ClientTransportRequestError> =>
  shellRead(transport, "session.getSnapshot", (client) =>
    client.session.getSnapshot({ sessionId: key.sessionId, branchId: key.branchId }),
  ).pipe(
    Effect.map((snapshot) => ({
      status: Option.some(snapshot.runtime._tag),
      model: Option.some(snapshot.resolvedModelId),
      turns: snapshot.metrics.turns,
      costUsd: snapshot.metrics.costUsd,
      durationMs: snapshot.metrics.durationMs,
      omittedMessages: Option.fromUndefinedOr(snapshot.metrics.context).pipe(
        Option.map((context) => context.omittedMessages),
        Option.getOrElse(() => 0),
      ),
    })),
  )

// ── workspace, shell and lifecycle facets ───────────────────────────────────

/**
 * TUI client services — typed Effect services that compose into the
 * per-provider `ManagedRuntime`. Effect-typed extension setups yield
 * the services they need (`ClientWorkspace`, `ClientShell`,
 * `ClientTransport`).
 *
 * Why split: each service has a different lifetime/coupling profile.
 * `ClientWorkspace` is process-static (cwd/home don't change).
 * `ClientShell` captures session-bound callbacks. Splitting lets a setup
 * yield exactly what it depends on and lets future client surfaces (SDK headless, web
 * UI) provide a subset.
 */

// ── ClientWorkspace ──────────────────────────────────────────────────────

export interface ClientWorkspaceDefinition {
  readonly cwd: string
  readonly home: string
}

export class ClientWorkspace extends Context.Service<ClientWorkspace, ClientWorkspaceDefinition>()(
  "@gent/tui/src/extensions/client-facets/ClientWorkspace",
) {}

export const makeClientWorkspaceLayer = (
  payload: ClientWorkspaceDefinition,
): Layer.Layer<ClientWorkspace> => Layer.succeed(ClientWorkspace, payload)

// ── ClientShell ──────────────────────────────────────────────────────────

export interface ClientShellDefinition {
  /** Send a chat message into the active session. */
  readonly sendMessage: (content: string) => void
  /** Open a registered overlay by id. */
  readonly openOverlay: (id: OverlayId) => void
  /** Close any open overlay. */
  readonly closeOverlay: () => void
  /**
   * Switch the shell to another session branch and navigate to it.
   *
   * Takes the branch explicitly rather than resolving one from the session:
   * a session has many branches, and the caller already knows which loop it
   * means. Unknown ids are the host's to reject, not the extension's.
   */
  readonly switchSession: (input: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly name: string
  }) => void
  /** Run an extension-owned Effect from a sync UI callback. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>
  /** Fork an extension-owned Effect from a sync UI callback. */
  readonly cast: <A, E>(effect: Effect.Effect<A, E, never>) => void
}

export class ClientShell extends Context.Service<ClientShell, ClientShellDefinition>()(
  "@gent/tui/src/extensions/client-facets/ClientShell",
) {}

export const makeClientShellLayer = (payload: ClientShellDefinition): Layer.Layer<ClientShell> =>
  Layer.succeed(ClientShell, payload)

// ── ClientLifecycle ──────────────────────────────────────────────────────

export interface ClientLifecycleDefinition {
  /** Allocate resources in the client provider lifetime, not the setup request. */
  readonly scoped: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>
  /**
   * Register a cleanup callback to run when the surrounding
   * `ExtensionUIProvider` unmounts (i.e. when the per-provider runtime is
   * disposed). Use for Solid `createRoot(dispose)` disposers, event
   * unsubscribes, and any other resource a widget setup detaches.
   *
   * Setups call this synchronously during `Effect.gen`; cleanups fire in
   * registration order. Failures inside a cleanup are swallowed so one
   * broken disposer cannot block the rest.
   */
  readonly addCleanup: (fn: () => void) => void
}

export class ClientLifecycle extends Context.Service<ClientLifecycle, ClientLifecycleDefinition>()(
  "@gent/tui/src/extensions/client-facets/ClientLifecycle",
) {}

export const makeClientLifecycleLayer = (
  payload: Pick<ClientLifecycleDefinition, "addCleanup">,
): Layer.Layer<ClientLifecycle> =>
  Layer.effect(
    ClientLifecycle,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      return ClientLifecycle.of({ ...payload, scoped: (effect) => Scope.provide(scope)(effect) })
    }),
  )

// ── Session Resource ─────────────────────────────────────────────────────

type ActiveClientSession = NonNullable<ReturnType<ClientTransportDefinition["currentSession"]>>

interface ClientSessionResource<A> {
  // eslint-disable-next-line effect/noNullish -- resource consumers use undefined before the first fetch.
  readonly read: () => A | undefined
  readonly refetch: () => void
}

/**
 * A keyed query the caller refreshes itself, with the load state a docked pane
 * draws.
 *
 * {@link makeClientSessionResource} fetches on its own whenever the session
 * changes; a pane instead refreshes on its own schedule — a typed query, a
 * poll, an event — and needs to say whether it is loading and what failed. The
 * Two rules guard what a reply may write. The generation guard drops every
 * reply but the newest refresh's, because a filter fires one fetch per
 * keystroke and a shorter query can answer last. The key guard drops a reply
 * made for a session the shell has since left, which the generation guard
 * cannot see because a switch raises no new refresh. A dropped reply still
 * clears the load state, or a pane that lost a race would say "loading" until
 * the next refresh.
 */
interface ClientSessionQuery<A, Q> {
  readonly value: () => A
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: (query: Q) => void
  /** Re-run the last query, for a caller whose data changed under it. */
  readonly reload: () => void
}

/** The key a query is made for; callers keep their own branded id types. */
type SessionKey = { readonly sessionId: string; readonly branchId: string }

export const makeClientSessionQuery = <A, Q, K extends SessionKey>(opts: {
  readonly initial: A
  readonly current: () => Option.Option<K>
  readonly cast: (effect: Effect.Effect<void>) => void
  readonly fetch: (query: Q, session: K) => Effect.Effect<A, { readonly message: string }>
}): ClientSessionQuery<A, Q> => {
  const [value, setValue] = createSignal<A>(opts.initial)
  const [error, setError] = createSignal<Option.Option<string>>(Option.none())
  const [loading, setLoading] = createSignal(false)
  let generation = 0
  let last = Option.none<Q>()

  const refresh = (query: Q): void => {
    const captured = opts.current()
    last = Option.some(query)
    if (Option.isNone(captured)) return
    const issued = ++generation
    setLoading(true)
    opts.cast(
      opts.fetch(query, captured.value).pipe(
        Effect.match({
          onFailure: (failure) => {
            if (issued !== generation) return
            setLoading(false)
            if (!isCurrent(captured.value)) return
            setError(Option.some(failure.message))
          },
          onSuccess: (next) => {
            if (issued !== generation) return
            setLoading(false)
            // The shell may have moved while this was out; that reply belongs
            // to a session nobody is looking at any more.
            if (!isCurrent(captured.value)) return
            setValue(() => next)
            setError(Option.none())
          },
        }),
      ),
    )
  }

  const reload = (): void => {
    if (Option.isNone(last)) return
    refresh(last.value)
  }

  const isCurrent = (captured: K): boolean =>
    Option.match(opts.current(), {
      onNone: () => false,
      onSome: (now) => now.sessionId === captured.sessionId && now.branchId === captured.branchId,
    })

  return { value, error, loading, refresh, reload }
}

export const makeClientSessionResource = <A>(opts: {
  /** Only the active identity: the resource asks which session, never what it is called. */
  readonly transport: Pick<ClientTransportDefinition, "currentSession">
  readonly lifecycle: Pick<ClientLifecycleDefinition, "addCleanup">
  readonly cast: <B, E>(effect: Effect.Effect<B, E, never>) => void
  readonly label: string
  readonly fetch: (session: ActiveClientSession) => Effect.Effect<A, Error>
  // eslint-disable-next-line effect/noNullish -- subscription is optional for static resources.
  readonly subscribe?: (refetch: () => void) => () => void
}): Effect.Effect<ClientSessionResource<A>> =>
  Effect.sync(() => {
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly value: A
    }

    let getState: () => Option.Option<Keyed> = () => Option.none()
    let setState: (next: Option.Option<Keyed>) => void = () => {}

    // eslint-disable-next-line effect/noNullish -- resource consumers use undefined before the first fetch.
    const read = (): A | undefined => {
      const state = getState()
      const current = Option.fromNullishOr(opts.transport.currentSession())
      if (Option.isNone(state) || Option.isNone(current)) {
        return Option.getOrUndefined(Option.none<A>())
      }
      if (
        state.value.sessionId !== current.value.sessionId ||
        state.value.branchId !== current.value.branchId
      ) {
        return Option.getOrUndefined(Option.none<A>())
      }
      return state.value.value
    }

    const refetchCaptured = (captured: ActiveClientSession): void => {
      opts.cast(
        opts.fetch(captured).pipe(
          Effect.flatMap((value) =>
            Effect.sync(() => {
              const current = Option.fromNullishOr(opts.transport.currentSession())
              if (
                Option.isNone(current) ||
                current.value.sessionId !== captured.sessionId ||
                current.value.branchId !== captured.branchId
              ) {
                return
              }
              setState(
                Option.some({
                  sessionId: captured.sessionId,
                  branchId: captured.branchId,
                  value,
                }),
              )
            }),
          ),
          Effect.catchEager((err) =>
            Effect.logWarning(`${opts.label} refresh failed`).pipe(
              Effect.annotateLogs({ error: String(err) }),
            ),
          ),
        ),
      )
    }

    const refetch = (): void => {
      const session = Option.fromNullishOr(opts.transport.currentSession())
      if (Option.isNone(session)) return
      refetchCaptured(session.value)
    }

    createRoot((dispose) => {
      const [state, set] = createSignal<Option.Option<Keyed>>(Option.none())
      getState = state
      setState = set
      // `currentSession` is the client's identity accessor, so this fires only
      // when the session or the branch actually moves — never for a rename or
      // a model change. Blanking on every fire is therefore blanking on every
      // real move, which is what the pane should draw while the new key loads.
      createEffect(() => {
        const session = Option.fromNullishOr(opts.transport.currentSession())
        setState(Option.none())
        if (Option.isNone(session)) return
        refetchCaptured(session.value)
      })
      opts.lifecycle.addCleanup(dispose)
    })

    const subscribe = Option.fromNullishOr(opts.subscribe)
    if (Option.isSome(subscribe)) opts.lifecycle.addCleanup(subscribe.value(refetch))

    return { read, refetch }
  })

// ── contribution surface ────────────────────────────────────────────────────

// TUI Extension Client Module
//
// Extensions export an Effect-typed `setup` that returns contribution buckets.
// The TUI discovers *.client.{tsx,ts,js,mjs}
// files from extension directories, imports them, runs each `setup` against
// the per-provider `clientRuntime`, and resolves contributions with scope
// precedence (project > user > builtin). Setups yield typed services from
// the runtime (`ClientTransport`, `ClientShell`, `ClientWorkspace`,
// `ClientLifecycle`, `FileSystem`, `Path`) — there is no
// `(ctx) => Array` arm and no imperative context bag.
//
// The `ClientContributions` bucket is the foundational data structure here.
// Adding a new facet means adding an explicit field and resolver path, not
// another stringly runtime tag table. Per-bucket conflict rules are preserved
// by the resolver:
//   - renderers: last (highest scope) wins by tool name
//   - widgets:   last (highest scope) wins by widget id; sorted by priority
//   - commands:  last (highest scope) wins by command id; superseded
//                keybind/slash entries are stripped from prior owners
//   - overlays:  last (highest scope) wins by overlay id
//   - interaction renderers: last (highest scope) wins by metadataType
//   - composer surface: single slot, last (highest scope) wins
//   - border labels: collected (no winner), sorted by priority
//   - autocomplete: collected (no winner), scope-ordered

/** Widget placement slots in the session view */
export type WidgetSlot = "below-messages" | "above-input" | "below-input"

/** Props passed to an interaction renderer component */
export interface InteractionRendererProps {
  readonly event: ActiveInteraction
  readonly resolve: (result: ApprovalResult) => void
}

/** Props passed to registered overlay components. */
export interface OverlayProps {
  readonly open: boolean
  readonly onClose: () => void
}

export type WidgetComponent = () => JSX.Element
export type OverlayComponent = (props: OverlayProps) => JSX.Element
export type InteractionRendererComponent = (props: InteractionRendererProps) => JSX.Element

export type ClientRuntimeServices =
  | ClientDeps
  | ClientTransport
  | ClientWorkspace
  | ClientShell
  | ClientLifecycle
  | ClientActivity

export type ClientRuntime = ManagedRuntime.ManagedRuntime<ClientRuntimeServices, never>

/** Item in an autocomplete popup */
export interface AutocompleteItem {
  readonly id: string
  readonly label: string
  readonly description?: string
}

type AutocompleteItemsEffect = Effect.Effect<
  ReadonlyArray<AutocompleteItem>,
  Error,
  ClientRuntimeServices
>

// ── Contribution shapes ──

interface RendererContribution {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
  readonly headless?: HeadlessToolRenderer
}

interface WidgetContribution {
  readonly id: string
  readonly slot: WidgetSlot
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly component: WidgetComponent
}

interface ClientCommandContribution {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly keybind?: string
  /** Slash command trigger (without the /). When set, /name invokes onSlash (or onSelect if no onSlash). */
  readonly slash?: string
  /** Additional slash names that resolve to this command */
  readonly aliases?: ReadonlyArray<string>
  /** Slash command priority. Lower wins. Builtins are 0, default extension is 10. Set < 0 to override builtins. */
  readonly slashPriority?: number
  readonly onSelect: () => void
  /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
  readonly onSlash?: (args: string) => void
}

interface OverlayContribution {
  readonly id: string
  /** Receives `{ open, onClose }` props at render time. */
  readonly component: OverlayComponent
}

interface InteractionRendererContribution {
  /** Matches against metadata.type. undefined = default fallback renderer. */
  readonly metadataType?: string
  readonly component: InteractionRendererComponent
}

export type BorderLabelPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right"
export type BorderLabelColor =
  | RGBA
  | "warning"
  | "info"
  | "success"
  | "primary"
  | "text"
  | "textMuted"

export interface BorderLabelItem {
  readonly text: string
  readonly color: BorderLabelColor
}

interface BorderLabelContribution {
  readonly position: BorderLabelPosition
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly produce: () => ReadonlyArray<BorderLabelItem>
}

export interface AutocompleteContribution {
  readonly prefix: string
  readonly title: string
  /** Fetch items for the given filter. Sync OR Effect (no Promise).
   *  - Sync: returned array used directly.
   *  - Effect: run through the TUI shell's `clientRuntime`. R may be any
   *    subset of services the runtime provides (FileSystem | Path |
   *    ClientTransport | ClientWorkspace | ...).
   *  The popup wraps in `createResource` — undefined while loading, items
   *  when resolved. Async work goes through Effect so client extension code
   *  shares the TUI shell runtime and cancellation semantics. */
  readonly items: (filter: string) => ReadonlyArray<AutocompleteItem> | AutocompleteItemsEffect
  /** Format the selected item id for insertion into the draft. Default: `${prefix}${id} ` */
  readonly formatInsertion?: (id: string) => string
  /** Called after an item is selected. Use for side effects like frecency tracking. */
  readonly onSelect?: (id: string, filter: string) => void
}

// ── Buckets ──

export interface ClientContributions {
  readonly renderers?: ReadonlyArray<RendererContribution>
  readonly widgets?: ReadonlyArray<WidgetContribution>
  readonly commands?: ReadonlyArray<ClientCommandContribution>
  readonly overlays?: ReadonlyArray<OverlayContribution>
  readonly interactionRenderers?: ReadonlyArray<InteractionRendererContribution>
  readonly borderLabels?: ReadonlyArray<BorderLabelContribution>
  readonly autocomplete?: ReadonlyArray<AutocompleteContribution>
}

type MutableClientContributions = {
  -readonly [Key in keyof ClientContributions]: ClientContributions[Key]
}

// eslint-disable-next-line effect/noNullish -- contribution buckets preserve omitted optional arrays.
const append = <A>(
  // eslint-disable-next-line effect/noNullish -- contribution buckets preserve omitted optional arrays.
  left: ReadonlyArray<A> | undefined,
  // eslint-disable-next-line effect/noNullish -- contribution buckets preserve omitted optional arrays.
  right: ReadonlyArray<A> | undefined,
  // eslint-disable-next-line effect/noNullish -- contribution buckets preserve omitted optional arrays.
): ReadonlyArray<A> | undefined => {
  const rightOption = Option.fromNullishOr(right)
  const leftOption = Option.fromNullishOr(left)
  if (Option.isNone(rightOption)) return Option.getOrUndefined(leftOption)
  if (Option.isNone(leftOption)) return rightOption.value
  return [...leftOption.value, ...rightOption.value]
}

export const clientContributions = (
  ...parts: ReadonlyArray<ClientContributions>
): ClientContributions => {
  const out: MutableClientContributions = {}

  for (const part of parts) {
    out.renderers = append(out.renderers, part.renderers)
    out.widgets = append(out.widgets, part.widgets)
    out.commands = append(out.commands, part.commands)
    out.overlays = append(out.overlays, part.overlays)
    out.interactionRenderers = append(out.interactionRenderers, part.interactionRenderers)
    out.borderLabels = append(out.borderLabels, part.borderLabels)
    out.autocomplete = append(out.autocomplete, part.autocomplete)
  }

  return out
}

// ── Smart constructors ──

export const rendererContribution = (
  toolNames: ReadonlyArray<string>,
  component: ToolRenderer,
  options?: { readonly headless?: HeadlessToolRenderer },
): ClientContributions => ({ renderers: [{ toolNames, component, ...options }] })

export const widgetContribution = (opts: {
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority?: number
  readonly component: WidgetComponent
}): ClientContributions => ({ widgets: [opts] })

export const clientCommandContribution = (
  opts: ClientCommandContribution,
): ClientContributions => ({ commands: [opts] })

export const overlayContribution = (opts: {
  readonly id: string
  readonly component: OverlayComponent
}): ClientContributions => ({ overlays: [opts] })

/**
 * Build an interaction renderer contribution. The component must be a function
 * accepting `InteractionRendererProps` — core owns this prop shape (it's what
 * the TUI shell calls renderers with), so we type the factory tightly.
 */
export const interactionRendererContribution = (
  component: InteractionRendererComponent,
  metadataType?: string,
): ClientContributions => {
  const renderer = Option.match(Option.fromNullishOr(metadataType), {
    onNone: () => ({ component }),
    onSome: (value) => ({ metadataType: value, component }),
  })
  return { interactionRenderers: [renderer] }
}

export const borderLabelContribution = (opts: BorderLabelContribution): ClientContributions => ({
  borderLabels: [opts],
})

export const autocompleteContribution = (opts: AutocompleteContribution): ClientContributions => ({
  autocomplete: [opts],
})

/** Overlay identifier (registered in `OverlayContribution`). */
type OverlayId = string

/**
 * A client extension's setup is an Effect that yields its dependencies
 * from the per-provider TUI runtime — `ClientDeps` (FileSystem | Path) by
 * default, widened by every TUI service the extension yields
 * (`ClientWorkspace`, `ClientShell`, `ClientTransport`).
 *
 * The TUI shell publishes its typed `ClientTransport` tag at
 * `apps/tui/src/extensions/client-facets.ts`; an extension that needs
 * the transport yields it and the per-provider `ManagedRuntime` provides
 * it. Errors flow on the typed `ClientSetupError` channel.
 */
type ExtensionClientSetup<Services extends ClientRuntimeServices = ClientDeps> = ClientEffect<
  ClientContributions,
  ClientSetupError,
  Services
>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path). An extension that yields
 * additional services (e.g. a TUI-side `ClientTransport`) widens `R` and
 * relies on the loader's runtime to provide every service it requires.
 */
export interface ExtensionClientModule<R extends ClientRuntimeServices = ClientDeps> {
  readonly id: string
  readonly setup: ExtensionClientSetup<R>
}

export type AnyExtensionClientModule = ExtensionClientModule<ClientRuntimeServices>

/**
 * Create a TUI client extension module with typed contributions. Server
 * extensions and TUI client modules share an id by convention — the TUI
 * loader looks up the module by id when wiring contributions.
 *
 * The setup is an Effect. Read the typed transport via
 * `yield* ClientTransport` and the other services via `yield* ClientShell` /
 * `ClientWorkspace`.
 */
export function defineClientExtension<R extends ClientRuntimeServices = ClientDeps>(
  id: string,
  spec: { readonly setup: ExtensionClientSetup<R> },
): ExtensionClientModule<R> {
  return { id, setup: spec.setup }
}
