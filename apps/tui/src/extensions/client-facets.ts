import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type ManagedRuntime,
  Option,
  type Path,
  Predicate,
  Schema,
  Scope,
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  type InteractionPresented,
  type AgentName,
  type ApprovalResult,
  type BranchId,
  type EventEnvelope,
  type ImagePartProjection,
  type Message,
  type Model,
  type Session,
  type SessionSnapshot,
  SessionId,
  type GentClientRpcError,
  type GentNamespacedClient,
} from "@gent/core/protocol"
import type { CapabilityRef } from "@gent/core/extensions/api"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import type { ToolRenderer } from "../tool-renderers"
import type { JSX } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { NamedThemeColor } from "../theme"
import type { Handover } from "../os"
import { repliesInView, type ReplyWriter } from "../utils"

// ── effect boundary ─────────────────────────────────────────────────────────

/**
 * The Effect-typed authoring surface for TUI client extensions.
 *
 * Extension setup reads dependencies from `ClientDeps` and returns
 * `ClientContributions` through an Effect. A setup that dies is recorded as
 * that extension's load failure; the rest still load.
 *
 * The runtime accepts only the Effect setup shape.
 *
 * Solid integration: extensions return contributions; the TUI shell owns one
 * per-provider `ManagedRuntime` that provides `FileSystem | Path |
 * ChildProcessSpawner | ClientContext`, and runs each setup via
 * `runtime.runPromise`. Async work inside contributions (autocomplete
 * `items`, etc.) is wired via the same runtime — the seam is at the rendering
 * edge, not in the Effect surface.
 *
 * Layering: `ClientDeps` is the TUI-local *floor* (`FileSystem | Path |
 * ChildProcessSpawner`).
 * The TUI shell augments its runtime with `ClientContext`, and an extension
 * that yields it widens its `R`. `ClientContext` lives here, not in
 * `@gent/core`, because its facets (the shell, the panes, the activity) are
 * the TUI's.
 */

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * The dependency channel a client extension's setup Effect MAY require.
 *
 * `ClientDeps` is the TUI-local floor: the Effect platform services for
 * files, paths and processes, as a server extension has them (ARCHITECTURE
 * rule 15). Every client extension gets the same floor, shipped or not, and
 * runs a command through `runProcess`. It is a floor, not a ceiling: the TUI
 * runtime adds `ClientContext`, and an extension that yields it declares a
 * wider `R`.
 */
export type ClientDeps = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

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
  /** Include reactive activity; register the returned cleanup with the caller's lifecycle. */
  readonly include: (readSnapshot: () => ClientActivitySnapshot) => () => void
}

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
  /** None when nobody named the session a model. */
  readonly model: Option.Option<string>
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
 *   import { ClientContext, defineClientExtension } from "@gent/tui/extensions"
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
  /**
   * The (sessionId, branchId) in view. The client starts with a session and
   * only ever moves to another, so there is no time without one. A reactive
   * read: it changes only when the session or the branch moves.
   */
  readonly currentSession: () => ActiveExtensionSession
  readonly request: <Input, Output>(
    ref: CapabilityRef<Input, Output>,
    input: Input,
    activeSession?: ActiveExtensionSession,
  ) => Effect.Effect<Output, ClientTransportRequestError | ClientTransportReplyDecodeError>
  /** Subscribe to `ExtensionStateChanged` pulses from the active session.
   *  Returns an unsubscribe function. Multiple subscribers receive each
   *  pulse independently. Widgets use this to invalidate cached state
   *  when their server-side extension publishes a state change. */
  readonly onExtensionStateChanged: (
    cb: (pulse: { sessionId: SessionId; branchId: BranchId; extensionId: string }) => void,
  ) => () => void
  /**
   * Subscribe to every event for the active session/branch. A subscriber that
   * joins after the feed opened first receives the envelopes the feed already
   * delivered for that branch, in order, then the live ones; ids can repeat
   * after a reconnect, so a subscriber skips any it has seen.
   */
  readonly onSessionEvent: (cb: (envelope: EventEnvelope) => void) => () => void
  /**
   * The active session's model catalog, prices included: the list the shell
   * loads for its model picker, read straight through. Reactive; `None` until
   * the first load settles (a failed load settles with no models).
   */
  readonly modelCatalog: () => Option.Option<ReadonlyArray<Model>>
  /**
   * The model id the session in view runs its next step on: its own setting,
   * else what the server resolved, as the status row names it. Reactive: a
   * model switch changes it before any request goes out. None when nobody
   * named the session a model.
   */
  readonly selectedModel: () => Option.Option<string>
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
 * What the shell hands the transport facet: the raw SDK client, which never
 * reaches an extension, plus the session accessors it passes through.
 */
export type ClientShellTransport = Pick<
  ClientTransport,
  "currentSession" | "onExtensionStateChanged" | "onSessionEvent" | "modelCatalog" | "selectedModel"
> & {
  readonly client: GentNamespacedClient
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
  modelCatalog: payload.modelCatalog,
  selectedModel: payload.selectedModel,
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
      client.driver.set({
        agentName,
        driver: { id: driverId },
        sessionId: payload.currentSession().sessionId,
      }),
    ).pipe(Effect.asVoid),
  driverClear: (input) =>
    shellRead(payload, "driver.clear", (client) => client.driver.clear(input)).pipe(Effect.asVoid),
})

// ── request helper ────────────────────────────────────────────────────────

class ClientTransportRequestError extends Schema.TaggedError<ClientTransportRequestError>()(
  "ClientTransportRequestError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

class ClientTransportReplyDecodeError extends Schema.TaggedError<ClientTransportReplyDecodeError>()(
  "ClientTransportReplyDecodeError",
  {
    extensionId: Schema.String,
    tag: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

const requestExtensionAt = <Input, Output>(
  transport: ClientShellTransport,
  ref: CapabilityRef<Input, Output>,
  input: Input,
  activeSession?: ActiveExtensionSession,
): Effect.Effect<Output, ClientTransportRequestError | ClientTransportReplyDecodeError, never> =>
  Effect.gen(function* () {
    // A request names its session, or goes to the one in view.
    const session = Option.getOrElse(Option.fromNullishOr(activeSession), transport.currentSession)
    // The RPC runs in the caller's fiber, so interrupting the caller stops it.
    const reply = yield* transport.client.extension
      .request({
        sessionId: session.sessionId,
        extensionId: ref.extensionId,
        capabilityId: ref.capabilityId,
        input,
        branchId: session.branchId,
      })
      .pipe(
        Effect.mapError((cause) => {
          // The server reports an extension's refusal in its own words; a pane
          // that draws the message names the reason, not the transport.
          let message = `request failed: ${String(cause)}`
          if (cause._tag === "ExtensionProtocolError") message = cause.message
          return new ClientTransportRequestError({
            extensionId: ref.extensionId,
            tag: ref.capabilityId,
            message,
            cause,
          })
        }),
      )
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
  transport: ClientShellTransport,
  tag: string,
  read: (client: GentNamespacedClient) => Effect.Effect<A, GentClientRpcError>,
): Effect.Effect<A, ClientTransportRequestError> =>
  read(transport.client).pipe(
    Effect.mapError(
      (cause) =>
        new ClientTransportRequestError({
          extensionId: "@gent/tui/client-transport",
          tag,
          message: `${tag} failed: ${String(cause)}`,
          cause,
        }),
    ),
  )

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
      model: Option.fromUndefinedOr(snapshot.resolvedModelId),
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
   * launch `cwd`; a failed read of it gives the launch `cwd`.
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
   * Run an effect with the terminal handed to it, for a program that draws
   * on the terminal itself (`runProcess` with inherited stdio): the renderer
   * suspends first and resumes when the effect ends, however it ends. One
   * handover runs at a time, the host's editor included; a second waits.
   * Keys go to the program while it runs, ctrl+c and ctrl+\ included (each
   * process the effect spawns joins the terminal's foreground group), and
   * transcript rows a running turn commits meanwhile land on the return. An
   * interrupt stops and awaits each process the effect spawned before the
   * renderer resumes; a process such a child starts is out of reach, so the
   * effect spawns each program it runs itself. Gent's exit (a signal, the
   * reader's quit) interrupts every handover the same way before it leaves
   * the terminal.
   */
  readonly handover: Handover
  /**
   * The one docked pane under the composer. The host keeps a single slot,
   * shared with its own pickers: opening a pane closes whatever pane or picker
   * was open. A pane widget renders while `isOpen` answers true for its name.
   */
  readonly pane: PaneOwner
  /**
   * Load the client extensions again, as the host does when a turn ends and
   * a client file changed: an unchanged one stays as it is, a changed one
   * sets up from its new version and the old one's lifetime ends, a removed
   * or disabled one goes. A new version that fails keeps the last good one,
   * and the failure is reported. The `/extensions` pane's `r` calls it.
   */
  readonly reloadExtensions: () => void
}

/** Open and close panes by name; at most one is open. */
export interface PaneOwner {
  readonly open: (id: string) => void
  /** Closes the named pane only; a pane that has since replaced it stays open. */
  readonly close: (id: string) => void
  /** Reactive: re-read inside a Solid scope to follow the slot. */
  readonly isOpen: (id: string) => boolean
}

/**
 * The lifetime of the extension that yields it. The loader gives each
 * extension its own: it ends when a later load replaces the extension (a new
 * version of its file) or removes it (its file is gone, or a config disables
 * it), and at the latest when the `ExtensionUIProvider` unmounts.
 */
export interface ClientLifecycle {
  /** Allocate resources in the extension's lifetime, not the setup request. */
  readonly scoped: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Scope.Scope>>
  /**
   * Register a cleanup callback to run when the extension's lifetime ends.
   * Use for Solid `createRoot(dispose)` disposers, event unsubscribes, and any
   * other resource a widget setup detaches.
   *
   * Setups call this synchronously during `Effect.gen`; cleanups fire in
   * registration order, before what `scoped` allocated is released. Failures
   * inside a cleanup are swallowed so one broken disposer cannot block the
   * rest. A cleanup registered after the lifetime ended runs at once.
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
 * What a surface supplies: the transport, the workspace, the shell callbacks
 * over its connected runtime, the activity reader and the cleanup registry.
 * A test supplies its no-ops through `extension-test-harness-boundary.ts`.
 */
export interface ClientContextDeps {
  readonly transport: ClientShellTransport
  readonly workspace: ClientWorkspace
  readonly shell: ClientShell
  /** Current UI activity; a surface with nothing to report answers `"unknown"`. */
  readonly activity: () => ClientActivitySnapshot
  readonly lifecycle: Pick<ClientLifecycle, "addCleanup">
}

/**
 * `lifecycle.scoped` allocates in the scope that builds this layer: the
 * client runtime's. The loader gives each extension's setup its own
 * lifecycle in a scope forked from this one.
 */
export const makeClientContextLayer = (deps: ClientContextDeps): Layer.Layer<ClientContext> =>
  Layer.effect(
    ClientContext,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const [included, setIncluded] = createSignal<
        ReadonlyArray<{ readonly read: () => ClientActivitySnapshot }>
      >([])
      const activity: ClientActivity = {
        snapshot: () => {
          const focused = deps.activity()
          if (focused.state === "blocked" || Predicate.isUndefined(focused.sessionId))
            return focused
          const states = included()
            .map((entry) => entry.read())
            .filter((next) => next.sessionId === focused.sessionId)
          if (states.some((next) => next.state === "blocked"))
            return { ...focused, state: "blocked" }
          if (focused.state !== "idle") return focused
          if (states.some((next) => next.state === "working"))
            return { ...focused, state: "working" }
          if (states.some((next) => next.state === "unknown"))
            return { ...focused, state: "unknown" }
          return focused
        },
        include: (read) => {
          const entry = { read }
          setIncluded((entries) => [...entries, entry])
          return () => setIncluded((entries) => entries.filter((next) => next !== entry))
        },
      }
      return ClientContext.of({
        transport: transportFacet(deps.transport),
        shell: deps.shell,
        workspace: deps.workspace,
        lifecycle: { ...deps.lifecycle, scoped: (effect) => Scope.provide(scope)(effect) },
        activity,
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
  /**
   * Runs with each reply the guard keeps, as it becomes `value`: state a
   * caller derives from replies changes only for a reply that is shown.
   */
  readonly accepted?: (value: A) => void
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
        sameSession(transport.currentSession(), session)
      // The shell may move while a read is out; its reply then belongs to a
      // session nobody is looking at any more, and is dropped.
      const replies = repliesInView(transport.currentSession, sameSession)

      const settle = (reply: ReplyWriter, write: () => void) => {
        setLoading(false)
        reply.write(write)
      }

      // The session is read when the read starts, so a read queued behind a
      // switch asks the session the shell moved to.
      const refresh = coalescedRead(shell.cast, () => {
        const session = transport.currentSession()
        const reply = replies.take()
        setLoading(true)
        return opts.fetch(session).pipe(
          Effect.match({
            onFailure: (failure) => settle(reply, () => setError(Option.some(failure.message))),
            onSuccess: (value) =>
              settle(reply, () => {
                setStored(Option.some({ session, value }))
                setError(Option.none())
                opts.accepted?.(value)
              }),
          }),
        )
      })

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
//   - renderers, message renderers, widgets, notice rows, interaction renderers:
//     keyed by tool name, message custom type, widget id, notice id and
//     metadataType; the highest
//     scope wins, and inside one scope the first claim keeps the key. Widgets
//     sort by priority.
//   - commands: the same rule by id, slash and keybind, applied by the host's
//     `resolveCommands` over the session's, the extensions' and the server's
//   - status labels: collected (no winner), sorted by priority
//   - autocomplete: collected (no winner), scope-ordered

/** Widget placement slots in the session view */
export const WidgetSlot = Schema.Literals(["below-messages", "above-input", "below-input"])
export type WidgetSlot = typeof WidgetSlot.Type

/** Props passed to an interaction renderer component */
export interface InteractionRendererProps {
  readonly event: InteractionPresented
  readonly resolve: (result: ApprovalResult) => void
}

/**
 * How much of each block the inline transcript shows: one line, a tree of one
 * line a child, or every body. `ctrl+o` steps through them; `esc` collapses.
 */
export type DisclosureLevel = "collapsed" | "preview" | "full"

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
  /** The transcript's level, so a row folds with `ctrl+o` like every other block. */
  readonly disclosure: DisclosureLevel
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
//
// Each entry's schema is the one owner of its shape. The type the host and
// the constructors read is derived from it, and the loader decodes a setup's
// buckets with it, so a field the schema does not list does not exist.

/** A function value; the host calls it, so its parameters are not checked here. */
type HostCalledFunction = (...args: ReadonlyArray<never>) => void

/**
 * A function the host calls as `F`. Only that it is a function is checked:
 * its parameters and result stay the extension's contract.
 */
const contributed = <F extends HostCalledFunction>() =>
  Schema.declare((value: unknown): value is F => Predicate.isFunction(value))

const RendererContribution = Schema.Struct({
  toolNames: Schema.Array(Schema.String),
  component: contributed<ToolRenderer>(),
})
type RendererContribution = typeof RendererContribution.Type

const MessageRendererContribution = Schema.Struct({
  /** Matches `metadata.customType` exactly. */
  customType: Schema.String,
  component: contributed<MessageRenderer>(),
  /**
   * Present when a user message of this type is a prompt the reader asked,
   * though an extension sent it (a `/btw` fork's question): the text the
   * reader wrote, from the message content. The transcript pins it as the
   * reader's last prompt.
   */
  prompt: Schema.optional(contributed<(content: string) => string>()),
  /**
   * The one line the queue widget shows for a waiting message of this type
   * (a background answer as `↳ answer · <question>`). Without it the widget
   * shows the message's text; a restore takes the text either way.
   */
  queueLabel: Schema.optional(contributed<(message: QueuedMessage) => string>()),
})
type MessageRendererContribution = typeof MessageRendererContribution.Type

/** A waiting message as a `queueLabel` reads it: its text and its metadata details. */
export interface QueuedMessage {
  readonly content: string
  readonly details: unknown
}

/** A message row renderer as the host resolves it, keyed by its custom type. */
export type MessageRendererEntry = Omit<MessageRendererContribution, "customType">

const WidgetContribution = Schema.Struct({
  id: Schema.String,
  slot: WidgetSlot,
  /** Lower = earlier; default 100. */
  priority: Schema.optional(Schema.Finite),
  component: contributed<WidgetComponent>(),
})
type WidgetContribution = typeof WidgetContribution.Type

const InteractionRendererContribution = Schema.Struct({
  /** Matches `metadata.type`; the host's prompt renderer draws an unmatched interaction. */
  metadataType: Schema.String,
  component: contributed<InteractionRendererComponent>(),
})

/** A theme color by name, or a resolved one. */
export const StatusLabelColor = Schema.Union([Schema.instanceOf(RGBA), NamedThemeColor])
export type StatusLabelColor = Schema.Schema.Type<typeof StatusLabelColor>

/**
 * When each host label takes its short form on a narrow row: the debug mark
 * first, then the cwd, before the model, the idle phase word, and the
 * `auto → high` effort last (its short form saves two columns). A plain
 * effort and the right-anchored numbers have none. The values are an order,
 * not widths: an extension label ranks between two host labels with a
 * fraction (`STATUS_YIELD.cwd + 0.5` gives way after the cwd, before the model).
 */
export const STATUS_YIELD = { debug: 0, cwd: 1, model: 2, phase: 3, effort: 4 } as const

/** A status label's short form, and when it gives way. */
export interface StatusLabelShort {
  /** The shorter text; empty leaves the label out. */
  readonly text: string
  /** The order in which labels take their short forms, lowest first (`STATUS_YIELD`). */
  readonly rank: number
}

export interface StatusLabelItem {
  readonly text: string
  readonly color: StatusLabelColor
  /**
   * The form the row draws when its group cannot fit every label in full.
   * Absent, the label keeps its text, and only the row's last cut shortens it.
   */
  readonly short?: StatusLabelShort
}

/** Where a status label sits: the left group, or the right group before the gauge and cost. */
export type StatusLabelAnchor = "left" | "right"

/**
 * Text on the composer's status row. The row is one line: the host's labels,
 * then every left extension label by priority, then the right group: the
 * right-anchored extension labels by priority, the context gauge and the
 * cost. The right group is laid out first and keeps its place on a narrow
 * row; the left group truncates. A glance number (a countdown) anchors right.
 */
const StatusLabelContribution = Schema.Struct({
  /** Lower = earlier; default 100. */
  priority: Schema.optional(Schema.Finite),
  /** `right`: in the right group, before the gauge; absent, in the left group. */
  anchor: Schema.optional(Schema.Literal("right")),
  produce: contributed<() => ReadonlyArray<StatusLabelItem>>(),
})
type StatusLabelContribution = typeof StatusLabelContribution.Type

/**
 * One transcript row an extension derives, such as a cache-miss notice. It is
 * not a message: nothing stores it and the model never reads it, so the
 * extension derives it again whenever the branch's events replay.
 */
export interface NoticeRow {
  /** Unique within its contribution; the transcript keys the row on it. */
  readonly key: string
  /** Epoch milliseconds; the row sorts among the transcript's rows by it. */
  readonly createdAt: number
  /** One glyph, drawn in `color` in the row's glyph column. */
  readonly glyph: string
  readonly color: StatusLabelColor
  /** Drawn muted after the glyph. */
  readonly text: string
}

const NoticeRowContribution = Schema.Struct({
  id: Schema.String,
  /**
   * The rows of one branch. Reactive: the transcript reads it again when it
   * changes. `None` while the source cannot yet say what its rows are: native
   * history commits nothing until every source answers, so a row is born with
   * its final text and never lands behind rows scrollback already holds.
   * History holds for a source only `NOTICE_ROWS_BOUND` (5 s) after the
   * extensions loaded; then it commits without that source. The source is no
   * failure and stays: when it answers, its rows draw among the rows history
   * has not yet committed.
   */
  rows: contributed<(session: ActiveExtensionSession) => Option.Option<ReadonlyArray<NoticeRow>>>(),
})
type NoticeRowContribution = typeof NoticeRowContribution.Type

/**
 * Something an extension holds pending that the user can stop with Esc, such
 * as an auto-resume armed for when a usage limit resets. Esc on an idle,
 * empty composer stops the first active one, highest scope first; one press
 * stops one.
 */
const StoppableContribution = Schema.Struct({
  id: Schema.String,
  /** Whether there is something to stop now. */
  active: contributed<() => boolean>(),
  /** Stop it. The host calls it only while `active` answers true. */
  stop: contributed<() => void>(),
})
type StoppableContribution = typeof StoppableContribution.Type

const AutocompleteContribution = Schema.Struct({
  prefix: Schema.String,
  title: Schema.String,
  /** Fetch items for the given filter. Sync OR Effect (no Promise).
   *  - Sync: returned array used directly.
   *  - Effect: run through the TUI shell's `clientRuntime`. R may be any
   *    subset of services the runtime provides (FileSystem | Path |
   *    ChildProcessSpawner |
   *    ClientContext).
   *  The popup wraps in `createResource` — undefined while loading, items
   *  when resolved. Async work goes through Effect so client extension code
   *  shares the TUI shell runtime and cancellation semantics. */
  items:
    contributed<(filter: string) => ReadonlyArray<AutocompleteItem> | AutocompleteItemsEffect>(),
  /** Format the selected item id for insertion into the draft. Default: `${prefix}${id} ` */
  formatInsertion: Schema.optional(contributed<(id: string) => string>()),
  /** Called after an item is selected. Use for side effects like frecency tracking. */
  onSelect: Schema.optional(contributed<(id: string, filter: string) => void>()),
  /**
   * Called each time the popup opens on this prefix, before its first
   * `items`. A source that caches between keys drops the cache here, so the
   * reader never ranks a list older than the popup, whatever filter it opens on.
   */
  onOpen: Schema.optional(contributed<() => void>()),
})
export type AutocompleteContribution = typeof AutocompleteContribution.Type

/**
 * One command: a palette row, and optionally a keybind and a slash name. The
 * session's own commands, client extension commands and server slash commands
 * all take this shape and resolve under one rule (`resolveCommands`).
 */
const Command = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  keybind: Schema.optional(Schema.String),
  /** Slash command trigger (without the /). When set, /name invokes onSlash (or onSelect if no onSlash). */
  slash: Schema.optional(Schema.String),
  /** Additional slash names that resolve to this command */
  aliases: Schema.optional(Schema.Array(Schema.String)),
  onSelect: contributed<() => void>(),
  /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
  onSlash: Schema.optional(contributed<(args: string) => void>()),
})
export type Command = typeof Command.Type

// ── Buckets ──

/**
 * Every contribution bucket, with the schema of one entry. The loader fails
 * an extension that returns any other key, so a renamed bucket fails loudly
 * instead of dropping its items, and one whose bucket has another shape, so a
 * malformed entry fails its own extension before the host resolves every
 * extension's contributions together.
 */
const CONTRIBUTION_BUCKETS = {
  renderers: RendererContribution,
  messageRenderers: MessageRendererContribution,
  widgets: WidgetContribution,
  commands: Command,
  interactionRenderers: InteractionRendererContribution,
  statusLabels: StatusLabelContribution,
  noticeRows: NoticeRowContribution,
  autocomplete: AutocompleteContribution,
  stoppables: StoppableContribution,
}

type ContributionBucket = keyof typeof CONTRIBUTION_BUCKETS

type EntryOf<Bucket extends ContributionBucket> = (typeof CONTRIBUTION_BUCKETS)[Bucket]["Type"]

/** What a setup returns: any of the buckets, each a list of its entries. */
export type ClientContributions = {
  readonly [Bucket in ContributionBucket]?: ReadonlyArray<EntryOf<Bucket>>
}

type MutableClientContributions = {
  -readonly [Bucket in ContributionBucket]?: ReadonlyArray<EntryOf<Bucket>>
}

const isContributionBucket = (key: string): key is ContributionBucket =>
  Object.hasOwn(CONTRIBUTION_BUCKETS, key)

const CONTRIBUTION_BUCKET_NAMES = Object.keys(CONTRIBUTION_BUCKETS).filter(isContributionBucket)

const decodeBucket = <Bucket extends ContributionBucket>(
  out: { -readonly [B in Bucket]?: ReadonlyArray<EntryOf<B>> },
  bucket: Bucket,
  // eslint-disable-next-line effect/noUnknownParameters -- a user setup's bucket is parsed at this boundary.
  entries: unknown,
) =>
  Schema.decodeUnknownExit(Schema.Array(CONTRIBUTION_BUCKETS[bucket]))(entries).pipe(
    Effect.mapError(() => `malformed contribution "${bucket}"`),
    Effect.map((decoded) => {
      out[bucket] = decoded
    }),
  )

/**
 * A setup's result as plain contributions, or the reason it is none. A key
 * the object owns outside the known buckets fails by name, so a renamed
 * bucket never drops its items silently. Each known bucket is read once by
 * property access (a class instance's getter counts) and decoded by its
 * schema to new objects and arrays, so the resolution every extension shares
 * never reads the extension's own object (a getter that throws, or answers
 * differently later). A throw on the way is a defect for the caller to name.
 */
export const decodeContributions = (
  // eslint-disable-next-line effect/noUnknownParameters -- a user setup's result is parsed at this boundary.
  value: unknown,
): Effect.Effect<ClientContributions, string> =>
  Effect.gen(function* () {
    if (!Predicate.isObject(value)) return yield* Effect.fail("setup must return contributions")
    const unknownKey = Option.fromUndefinedOr(
      Object.keys(value).find((key) => !isContributionBucket(key)),
    )
    if (Option.isSome(unknownKey)) {
      return yield* Effect.fail(`unknown contribution "${unknownKey.value}"`)
    }
    const out: MutableClientContributions = {}
    for (const bucket of CONTRIBUTION_BUCKET_NAMES) {
      if (!Predicate.hasProperty(value, bucket)) continue
      const entries = value[bucket]
      // An absent bucket and one set to `undefined` contribute nothing alike.
      if (!Predicate.isUndefined(entries)) yield* decodeBucket(out, bucket, entries)
    }
    return out
  })

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

const appendBucket = <Bucket extends ContributionBucket>(
  out: { -readonly [B in Bucket]?: ReadonlyArray<EntryOf<B>> },
  part: ClientContributions,
  bucket: Bucket,
) => {
  out[bucket] = append(out[bucket], part[bucket])
}

export const clientContributions = (
  ...parts: ReadonlyArray<ClientContributions>
): ClientContributions => {
  const out: MutableClientContributions = {}
  for (const part of parts) {
    for (const bucket of CONTRIBUTION_BUCKET_NAMES) appendBucket(out, part, bucket)
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
  options: {
    readonly prompt?: (content: string) => string
    readonly queueLabel?: (message: QueuedMessage) => string
  } = {},
): ClientContributions => ({ messageRenderers: [{ customType, component, ...options }] })

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

/** Transcript rows derived per branch; the highest scope's claim on an `id` wins. */
export const noticeRowContribution = (opts: NoticeRowContribution): ClientContributions => ({
  noticeRows: [opts],
})

export const autocompleteContribution = (opts: AutocompleteContribution): ClientContributions => ({
  autocomplete: [opts],
})

/** A pending thing Esc stops; the highest scope's claim on an `id` wins. */
export const stoppableContribution = (opts: StoppableContribution): ClientContributions => ({
  stoppables: [opts],
})

/**
 * A client extension's setup is an Effect that yields its dependencies
 * from the per-provider TUI runtime — `ClientDeps` (FileSystem | Path |
 * ChildProcessSpawner) by
 * default, widened to `ClientContext` when the extension yields it; the
 * per-provider `ManagedRuntime` provides it. The setup handles its own
 * failures; one that dies anyway is that extension's load failure, since the
 * loader catches the whole cause and names it, and the rest still load.
 */
type ExtensionClientSetup<Services extends ClientRuntimeServices = ClientDeps> = Effect.Effect<
  ClientContributions,
  never,
  Services
>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path | ChildProcessSpawner). An
 * extension that yields
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
