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
  type EventEnvelope,
  type ImagePartProjection,
  type Message,
  type Session,
  type SessionSnapshot,
  SessionId,
  type GentClientRpcError,
  type GentNamespacedClient,
} from "@gent/core/protocol"
import type { GentRuntime } from "@gent/sdk"
import { omitUndefined, type CapabilityRef } from "@gent/core/extensions/api"
import { createEffect, createRoot, createSignal, on } from "solid-js"
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
 * per-provider `ManagedRuntime` that provides `FileSystem | Path | ClientContext`,
 * and runs each setup via `runtime.runPromise`. Async work inside
 * contributions (autocomplete `items`, etc.) is wired via the same runtime —
 * the seam is at the rendering edge, not in the Effect surface.
 *
 * Layering: `ClientDeps` is the TUI-local *floor* (`FileSystem | Path`).
 * The TUI shell augments its runtime with `ClientContext`, and an extension
 * that yields it widens its `R`. `ClientContext` lives here, not in
 * `@gent/core`, because the SDK client types (`GentNamespacedClient`,
 * `GentRuntime`) live downstream of `@gent/core`.
 */

// ── Errors ────────────────────────────────────────────────────────────────

/** Failure surfaced from a client extension's `setup` Effect. */
export class ClientSetupError extends Schema.TaggedError<ClientSetupError>()("ClientSetupError", {
  extensionId: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * The dependency channel a client extension's setup Effect MAY require.
 *
 * `ClientDeps` is the TUI-local floor: file system and path services. It is
 * a floor, not a ceiling: the TUI runtime adds `ClientContext`, and an
 * extension that yields it declares a wider `R`.
 */
type ClientDeps = FileSystem.FileSystem | Path.Path

// ── ClientEffect ──────────────────────────────────────────────────────────

/**
 * An Effect that returns a value, may fail with `ClientSetupError`, and may
 * read from any subset of services its runtime provides. `R` defaults to
 * `ClientDeps` — the floor — so a setup that only needs `FileSystem`/`Path`
 * compiles without ceremony. An extension that yields `ClientContext` widens
 * `R` itself; the loader's runtime provides it.
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
interface ClientActivity {
  readonly snapshot: () => ClientActivitySnapshot
}

const unknownActivity = (): ClientActivitySnapshot => ({ state: "unknown" })

// ── transport facet ─────────────────────────────────────────────────────────

export type ActiveExtensionSession = { readonly sessionId: SessionId; readonly branchId: BranchId }

/**
 * Per-loop detail, for one loop at a time.
 *
 * Enumerating every loop must not fan out into N snapshot reads, so listings
 * carry identity and liveness only and a client asks for this separately —
 * for the row a reader is actually looking at. A session that has never
 * streamed reads zero turns, zero cost and its resolved model.
 */
export interface ExtensionAgentDetail {
  /** What the loop is doing: its runtime state tag. */
  readonly status: SessionSnapshot["runtime"]["_tag"]
  readonly model: string
  readonly turns: number
  readonly costUsd: number
  readonly durationMs: number
  /** Messages the last projection left out of the model's view; 0 before a turn has run. */
  readonly omittedMessages: number
}

/**
 * `ClientContext.transport` — the typed transport surface for client extensions.
 *
 * Core can't declare this with typed payloads because TUI extension transport
 * runs above the SDK. The TUI shell owns the raw SDK client/runtime and
 * publishes only typed extension request/session/event helpers here.
 *
 * Usage from a client extension:
 *
 *   ```ts
 *   import { Effect } from "effect"
 *   import { ClientContext, defineClientExtension } from "./client-facets"
 *
 *   export default defineClientExtension("@gent/x", {
 *     setup: Effect.gen(function* () {
 *       const { transport } = yield* ClientContext
 *       const result = yield* transport.request(ref(MyRpc.List), {})
 *       return clientContributions(...)
 *     }),
 *   })
 *   ```
 *
 * The TUI's `ExtensionUIProvider` builds one `ManagedRuntime` per provider
 * with `makeClientRuntime`, and `loadTuiExtensions` runs each setup on it.
 */
export interface ClientTransport {
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
  /** Route one agent to a driver; the server rejects unknown driver ids. */
  readonly driverSet: (input: {
    readonly agentName: AgentName
    readonly driverId: string
  }) => Effect.Effect<void, ClientTransportRequestError>
  /** Remove one agent's driver override. */
  readonly driverClear: (input: {
    readonly agentName: AgentName
  }) => Effect.Effect<void, ClientTransportRequestError>
}

/**
 * What the shell hands the transport facet: the raw SDK client and runtime,
 * which never reach an extension, plus the session accessors it passes through.
 */
export type ClientShellTransport = Pick<
  ClientTransport,
  "currentSession" | "onExtensionStateChanged" | "onSessionEvent"
> & {
  readonly client: GentNamespacedClient
  readonly runtime: GentRuntime
}

/** Seal the shell's authority behind the typed transport an extension sees. */
const transportFacet = (payload: ClientShellTransport): ClientTransport => ({
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
  // Drivers belong to the active session's profile: its project drivers count.
  driverSet: ({ agentName, driverId }) =>
    shellRead(payload, "driver.set", (client) =>
      client.driver.set({ agentName, driver: { id: driverId }, ...activeSessionPayload(payload) }),
    ).pipe(Effect.asVoid),
  driverClear: (input) =>
    shellRead(payload, "driver.clear", (client) => client.driver.clear(input)).pipe(Effect.asVoid),
})

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
  transport: ClientShellTransport,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<ActiveExtensionSession, NoActiveSessionError> => {
  const session = Option.orElse(Option.fromNullishOr(activeSession), transport.currentSession)
  if (Option.isNone(session)) return Effect.fail(new NoActiveSessionError())
  return Effect.succeed(session.value)
}

const requestExtensionAt = <Input, Output>(
  transport: ClientShellTransport,
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

/** `{ sessionId }` of the active session, or `{}` before one exists. */
const activeSessionPayload = (transport: ClientShellTransport) =>
  omitUndefined({
    sessionId: Option.getOrUndefined(
      Option.map(transport.currentSession(), (session) => session.sessionId),
    ),
  })

/** One shell RPC read, with its failure named by the RPC it came from. */
const shellRead = <A>(
  transport: ClientShellTransport,
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
  transport: ClientShellTransport,
  key: ActiveExtensionSession,
): Effect.Effect<ExtensionAgentDetail, ClientTransportRequestError> =>
  shellRead(transport, "session.getSnapshot", (client) =>
    client.session.getSnapshot({ sessionId: key.sessionId, branchId: key.branchId }),
  ).pipe(
    Effect.map((snapshot) => ({
      status: snapshot.runtime._tag,
      model: snapshot.resolvedModelId,
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

interface ClientWorkspace {
  /** Where the TUI launched. */
  readonly cwd: string
  readonly home: string
  /**
   * The active session's directory, which `@` paths and the model's tools
   * resolve against. A resumed or switched session can be rooted outside the
   * launch `cwd`; with no session it is the launch `cwd`.
   */
  readonly sessionCwd: Effect.Effect<string>
}

export interface ClientShell {
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
  /**
   * The one docked pane under the composer. The host keeps a single slot,
   * shared with its own pickers: opening a pane closes whatever pane or picker
   * was open. A pane widget renders while `isOpen` answers true for its name.
   */
  readonly pane: PaneOwner
}

/** Open and close panes by name; at most one is open. */
export interface PaneOwner {
  readonly open: (id: string) => void
  /** Closes the named pane only; a pane that has since replaced it stays open. */
  readonly close: (id: string) => void
  /** Reactive: re-read inside a Solid scope to follow the slot. */
  readonly isOpen: (id: string) => boolean
}

interface ClientLifecycle {
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

// ── client context ──────────────────────────────────────────────────────────

/**
 * The one service a client extension yields, as `ExtensionContext` is on the
 * server: `const { transport, shell } = yield* ClientContext`. Every surface
 * that loads client extensions builds it with `makeClientContextLayer`.
 */
export class ClientContext extends Context.Service<
  ClientContext,
  {
    readonly transport: ClientTransport
    readonly shell: ClientShell
    readonly workspace: ClientWorkspace
    readonly lifecycle: ClientLifecycle
    readonly activity: ClientActivity
  }
>()("@gent/tui/src/extensions/client-facets/ClientContext") {}

/**
 * What a surface supplies: the transport, the workspace, the `cast` of its
 * connected runtime, and the pane slot. The other shell callbacks, the activity reader, and the
 * cleanup registry default to no-ops, so a test does not restate them.
 */
export interface ClientContextDeps {
  readonly transport: ClientShellTransport
  /** `sessionCwd` defaults to the launch `cwd`, for a surface with no session to read. */
  readonly workspace: Omit<ClientWorkspace, "sessionCwd"> &
    Partial<Pick<ClientWorkspace, "sessionCwd">>
  readonly shell: Pick<ClientShell, "cast" | "pane"> & Partial<Omit<ClientShell, "cast" | "pane">>
  /** Current UI activity; absent when the surface has no activity to report. */
  readonly activity?: () => ClientActivitySnapshot
  /** Cleanup registry; absent when the surface disposes the runtime whole. */
  readonly lifecycle?: Pick<ClientLifecycle, "addCleanup">
}

const noopShell: Omit<ClientShell, "cast" | "pane"> = { notify: () => {}, switchSession: () => {} }

const noopLifecycle: Pick<ClientLifecycle, "addCleanup"> = { addCleanup: () => {} }

/** `lifecycle.scoped` allocates in the scope that builds this layer: the client runtime's. */
export const makeClientContextLayer = (deps: ClientContextDeps): Layer.Layer<ClientContext> =>
  Layer.effect(
    ClientContext,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const lifecycle = Option.getOrElse(
        Option.fromUndefinedOr(deps.lifecycle),
        () => noopLifecycle,
      )
      return ClientContext.of({
        transport: transportFacet(deps.transport),
        shell: { ...noopShell, ...deps.shell },
        workspace: {
          sessionCwd: Effect.succeed(deps.workspace.cwd),
          ...deps.workspace,
        },
        lifecycle: { ...lifecycle, scoped: (effect) => Scope.provide(scope)(effect) },
        activity: {
          snapshot: Option.getOrElse(Option.fromUndefinedOr(deps.activity), () => unknownActivity),
        },
      })
    }),
  )

// ── Session Query ────────────────────────────────────────────────────────

/**
 * A read keyed by the session the shell is on, with the load state a pane draws.
 *
 * One read runs at a time (`coalescedRead`): a refresh during a read runs one
 * more read after it, so replies land in the order they were asked and a read
 * slower than its trigger still lands. The key guard drops a reply made for a
 * session the shell has since left. A dropped reply still clears the load
 * state, or a pane that lost a race would say "loading" until the next read.
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

/**
 * One read at a time. A request while a read runs marks one more read, which
 * starts when the running one ends; any further requests fold into it. Each
 * read is built when it starts, so a queued read asks with the newest inputs.
 */
export const coalescedRead = (
  cast: (effect: Effect.Effect<void>) => void,
  read: () => Effect.Effect<void>,
): (() => void) => {
  let running = false
  let again = false
  const request = (): void => {
    if (running) {
      again = true
      return
    }
    running = true
    cast(
      read().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running = false
            if (!again) return
            again = false
            request()
          }),
        ),
      ),
    )
  }
  return request
}

const sameSession = (left: ActiveExtensionSession, right: ActiveExtensionSession): boolean =>
  left.sessionId === right.sessionId && left.branchId === right.branchId

export const sessionQuery = <A>(opts: {
  readonly initial: A
  readonly follow: boolean
  readonly fetch: (
    session: ActiveExtensionSession,
  ) => Effect.Effect<A, { readonly message: string }>
}): Effect.Effect<SessionQuery<A>, never, ClientContext> =>
  Effect.gen(function* () {
    const { transport, shell, lifecycle } = yield* ClientContext
    return createRoot((dispose) => {
      lifecycle.addCleanup(dispose)
      type Keyed = { readonly session: ActiveExtensionSession; readonly value: A }
      const [stored, setStored] = createSignal<Option.Option<Keyed>>(Option.none())
      const [error, setError] = createSignal<Option.Option<string>>(Option.none())
      const [loading, setLoading] = createSignal(false)

      const isCurrent = (session: ActiveExtensionSession): boolean =>
        Option.exists(transport.currentSession(), (now) => sameSession(now, session))

      const settle = (session: ActiveExtensionSession, write: () => void) => {
        setLoading(false)
        // The shell may have moved while this was out; that reply belongs to a
        // session nobody is looking at any more.
        if (!isCurrent(session)) return
        write()
      }

      // The session is read when the read starts, so a read queued behind a
      // switch asks the session the shell moved to.
      const refresh = coalescedRead(shell.cast, () =>
        Option.match(transport.currentSession(), {
          onNone: () => Effect.void,
          onSome: (session) => {
            setLoading(true)
            return opts.fetch(session).pipe(
              Effect.match({
                onFailure: (failure) =>
                  settle(session, () => setError(Option.some(failure.message))),
                onSuccess: (value) =>
                  settle(session, () => {
                    setStored(Option.some({ session, value }))
                    setError(Option.none())
                  }),
              }),
            )
          },
        }),
      )

      // `currentSession` is the client's identity accessor, so this fires only
      // when the session or the branch moves, never for a rename or a model change.
      // The dependency is explicit: a switch that lands during a read queues a
      // read without reading the session, and an effect that tracked only what
      // `refresh` read would lose it there and never fire again.
      if (opts.follow) {
        createEffect(
          on(transport.currentSession, () => {
            setError(Option.none())
            refresh()
          }),
        )
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
// the runtime (`ClientContext`, `FileSystem`, `Path`) — there is no
// `(ctx) => Array` arm and no imperative context bag.
//
// The `ClientContributions` bucket is the foundational data structure here.
// Adding a new facet means adding an explicit field and resolver path, not
// another stringly runtime tag table. Per-bucket conflict rules are preserved
// by the resolver:
//   - renderers, message renderers, widgets, interaction renderers: keyed by
//     tool name, message custom type, widget id and metadataType; the highest
//     scope wins, and inside one scope the first claim keeps the key. Widgets
//     sort by priority.
//   - commands: the same rule by id, slash and keybind, applied by the host's
//     `resolveCommands` over the session's, the extensions' and the server's
//   - status labels: collected (no winner), sorted by priority
//   - autocomplete: collected (no winner), scope-ordered

/** Widget placement slots in the session view */
export type WidgetSlot = "below-messages" | "above-input" | "below-input"

/** Props passed to an interaction renderer component */
export interface InteractionRendererProps {
  readonly event: ActiveInteraction
  readonly resolve: (result: ApprovalResult) => void
}

/**
 * One user-role message a harness or an extension wrote, as its row draws it.
 * The transcript picks the renderer by the message's `metadata.customType`;
 * with full detail on, every message draws the plain row instead.
 */
export interface MessageRowProps {
  readonly content: string
  readonly images: ReadonlyArray<ImagePartProjection>
  readonly interjection: boolean
  readonly pendingMode?: "queued" | "steer"
  /** The message's `metadata.details`, for the renderer to decode. */
  readonly details: unknown
}

export type MessageRenderer = (props: MessageRowProps) => JSX.Element
export type WidgetComponent = () => JSX.Element
export type InteractionRendererComponent = (props: InteractionRendererProps) => JSX.Element

export type ClientRuntimeServices = ClientDeps | ClientContext

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

interface MessageRendererContribution {
  /** Matches `metadata.customType` exactly. */
  readonly customType: string
  readonly component: MessageRenderer
}

interface WidgetContribution {
  readonly id: string
  readonly slot: WidgetSlot
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly component: WidgetComponent
}

interface InteractionRendererContribution {
  /** Matches `metadata.type`; the host's prompt renderer draws an unmatched interaction. */
  readonly metadataType: string
  readonly component: InteractionRendererComponent
}

/** A theme color by name, or a resolved one. */
export type StatusLabelColor =
  | RGBA
  | "warning"
  | "info"
  | "success"
  | "primary"
  | "text"
  | "textMuted"

export interface StatusLabelItem {
  readonly text: string
  readonly color: StatusLabelColor
}

/**
 * Text on the composer's status row. The row is one line: the host's labels,
 * then every extension label by priority, then the right-anchored gauge and cost.
 */
interface StatusLabelContribution {
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly produce: () => ReadonlyArray<StatusLabelItem>
}

export interface AutocompleteContribution {
  readonly prefix: string
  readonly title: string
  /** Fetch items for the given filter. Sync OR Effect (no Promise).
   *  - Sync: returned array used directly.
   *  - Effect: run through the TUI shell's `clientRuntime`. R may be any
   *    subset of services the runtime provides (FileSystem | Path |
   *    ClientContext).
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
  readonly messageRenderers?: ReadonlyArray<MessageRendererContribution>
  readonly widgets?: ReadonlyArray<WidgetContribution>
  readonly commands?: ReadonlyArray<Command>
  readonly interactionRenderers?: ReadonlyArray<InteractionRendererContribution>
  readonly statusLabels?: ReadonlyArray<StatusLabelContribution>
  readonly autocomplete?: ReadonlyArray<AutocompleteContribution>
}

/**
 * Every contribution bucket. The loader fails an extension that returns any
 * other key, so a renamed bucket fails loudly instead of dropping its items.
 */
const CONTRIBUTION_BUCKETS = {
  renderers: true,
  messageRenderers: true,
  widgets: true,
  commands: true,
  interactionRenderers: true,
  statusLabels: true,
  autocomplete: true,
} satisfies Record<keyof ClientContributions, true>

/** The first key a setup returned that is not a contribution bucket. */
export const unknownContributionKey = (keys: ReadonlyArray<string>): Option.Option<string> =>
  Option.fromUndefinedOr(keys.find((key) => !Object.hasOwn(CONTRIBUTION_BUCKETS, key)))

type MutableClientContributions = {
  -readonly [Key in keyof ClientContributions]: ClientContributions[Key]
}

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
    out.messageRenderers = append(out.messageRenderers, part.messageRenderers)
    out.widgets = append(out.widgets, part.widgets)
    out.commands = append(out.commands, part.commands)
    out.interactionRenderers = append(out.interactionRenderers, part.interactionRenderers)
    out.statusLabels = append(out.statusLabels, part.statusLabels)
    out.autocomplete = append(out.autocomplete, part.autocomplete)
  }

  return out
}

// ── Smart constructors ──

export const rendererContribution = (
  toolNames: ReadonlyArray<string>,
  component: ToolRenderer,
): ClientContributions => ({ renderers: [{ toolNames, component }] })

export const messageRendererContribution = (
  customType: string,
  component: MessageRenderer,
): ClientContributions => ({ messageRenderers: [{ customType, component }] })

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
  metadataType: string,
): ClientContributions => ({ interactionRenderers: [{ metadataType, component }] })

export const statusLabelContribution = (opts: StatusLabelContribution): ClientContributions => ({
  statusLabels: [opts],
})

export const autocompleteContribution = (opts: AutocompleteContribution): ClientContributions => ({
  autocomplete: [opts],
})

/**
 * A client extension's setup is an Effect that yields its dependencies
 * from the per-provider TUI runtime — `ClientDeps` (FileSystem | Path) by
 * default, widened to `ClientContext` when the extension yields it; the
 * per-provider `ManagedRuntime` provides it. Errors flow on the typed
 * `ClientSetupError` channel.
 */
type ExtensionClientSetup<Services extends ClientRuntimeServices = ClientDeps> = ClientEffect<
  ClientContributions,
  ClientSetupError,
  Services
>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path). An extension that yields
 * `ClientContext` widens `R` and relies on the loader's runtime to provide it.
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
 * The setup is an Effect. Read the host facets via `yield* ClientContext`.
 */
export function defineClientExtension<R extends ClientRuntimeServices = ClientDeps>(
  id: string,
  spec: { readonly setup: ExtensionClientSetup<R> },
): ExtensionClientModule<R> {
  return { id, setup: spec.setup }
}
