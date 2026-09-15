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
