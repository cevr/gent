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

import { createEffect, createRoot, createSignal } from "solid-js"
import { Context, Effect, Layer, Option, Scope } from "effect"
import type { BranchId, SessionId } from "@gent/core/extensions/api"
import type { OverlayId } from "./client-facets.js"
import type { ClientTransportDefinition } from "./client-transport"

// ── ClientWorkspace ──────────────────────────────────────────────────────

export interface ClientWorkspaceDefinition {
  readonly cwd: string
  readonly home: string
}

export class ClientWorkspace extends Context.Service<ClientWorkspace, ClientWorkspaceDefinition>()(
  "@gent/tui/src/extensions/client-services/ClientWorkspace",
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
  "@gent/tui/src/extensions/client-services/ClientShell",
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
  "@gent/tui/src/extensions/client-services/ClientLifecycle",
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

export interface ClientSessionResource<A> {
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
export interface ClientSessionQuery<A, Q> {
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
  readonly transport: ClientTransportDefinition
  readonly lifecycle: ClientLifecycleDefinition
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
