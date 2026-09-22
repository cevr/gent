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
import type { Command } from "../commands"
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

export type ActiveExtensionSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

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
  /** Active (sessionId, branchId); `None` before a session is mounted. */
  readonly currentSession: () => Option.Option<ActiveExtensionSession>
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
   * the thread it continues while a delegate run or a `/btw` fork sits
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
  /** Active (sessionId, branchId); `None` before a session is mounted. */
  readonly currentSession: () => Option.Option<ActiveExtensionSession>
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
  const session = Option.orElse(Option.fromNullishOr(activeSession), transport.currentSession)
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
  /**
   * Show a one-line status in the footer, where the session's own slash
   * commands report a usage hint or a failure. The next turn clears it.
   */
  readonly notify: (message: string) => void
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

// ── Session Query ────────────────────────────────────────────────────────

/**
 * A read keyed by the session the shell is on, with the load state a pane draws.
 *
 * Two rules guard what a reply may write. The generation guard drops every
 * reply but the newest refresh's, because a filter fires one fetch per
 * keystroke and a shorter query can answer last. The key guard drops a reply
 * made for a session the shell has since left, which the generation guard
 * cannot see because a switch raises no new refresh. A dropped reply still
 * clears the load state, or a pane that lost a race would say "loading" until
 * the next refresh.
 *
 * With `follow`, the query reads again whenever the session or the branch
 * moves, and `value` answers `initial` until that read lands, so one session's
 * data never shows under another. Without it, the caller refreshes on its own
 * schedule (a typed filter, a poll, an event) and the last value stays up.
 */
interface SessionQuery<A> {
  readonly value: () => A
  readonly error: () => Option.Option<string>
  readonly loading: () => boolean
  readonly refresh: () => void
}

const sameSession = (left: ActiveExtensionSession, right: ActiveExtensionSession): boolean =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

export const sessionQuery = <A>(opts: {
  readonly initial: A
  readonly follow: boolean
  readonly fetch: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<A, { readonly message: string }>
}): Effect.Effect<SessionQuery<A>, never, ClientTransport | ClientShell | ClientLifecycle> =>
  Effect.gen(function* () {
    const transport = yield* ClientTransport
    const shell = yield* ClientShell
    const lifecycle = yield* ClientLifecycle
    return createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      type Keyed = { readonly session: ActiveExtensionSession; readonly value: A }
      const [stored, setStored] = createSignal<Option.Option<Keyed>>(Option.none())
      const [error, setError] = createSignal<Option.Option<string>>(Option.none())
      const [loading, setLoading] = createSignal(false)
      let generation = 0

      const isCurrent = (session: ActiveExtensionSession): boolean =>
        Option.exists(transport.currentSession(), (now) => sameSession(now, session))

      const settle = (issued: number, session: ActiveExtensionSession, write: () => void) => {
        if (issued !== generation) return
        setLoading(false)
        // The shell may have moved while this was out; that reply belongs to a
        // session nobody is looking at any more.
        if (!isCurrent(session)) return
        write()
      }

      const refresh = (): void => {
        const captured = transport.currentSession()
        if (Option.isNone(captured)) return
        const session = captured.value
        const issued = ++generation
        setLoading(true)
        shell.cast(
          opts.fetch(session).pipe(
            Effect.match({
              onFailure: (failure) =>
                settle(issued, session, () => setError(Option.some(failure.message))),
              onSuccess: (value) =>
                settle(issued, session, () => {
                  setStored(Option.some({ session, value }))
                  setError(Option.none())
                }),
            }),
          ),
        )
      }

      // `currentSession` is the client's identity accessor, so this fires only
      // when the session or the branch moves, never for a rename or a model change.
      if (opts.follow) {
        createEffect(() => {
          setError(Option.none())
          refresh()
        })
      }

      const value = (): A =>
        Option.match(stored(), {
          onNone: () => opts.initial,
          onSome: (keyed) => {
            if (opts.follow && !isCurrent(keyed.session)) return opts.initial
            return keyed.value
          },
        })

      return { value, error, loading, refresh }
    })
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

export type WidgetComponent = () => JSX.Element
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
}

interface WidgetContribution {
  readonly id: string
  readonly slot: WidgetSlot
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly component: WidgetComponent
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
  readonly commands?: ReadonlyArray<Command>
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
): ClientContributions => ({ renderers: [{ toolNames, component }] })

export const widgetContribution = (opts: {
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority?: number
  readonly component: WidgetComponent
}): ClientContributions => ({ widgets: [opts] })

export const clientCommandContribution = (opts: Command): ClientContributions => ({
  commands: [opts],
})

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
