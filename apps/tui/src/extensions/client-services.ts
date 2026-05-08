/**
 * TUI client services — typed Effect services that compose into the
 * per-provider `ManagedRuntime`. Effect-typed extension setups yield
 * the services they need (`ClientWorkspace`, `ClientShell`,
 * `ClientComposer`, `ClientTransport`).
 *
 * Why split: each service has a different lifetime/coupling profile.
 * `ClientWorkspace` is process-static (cwd/home don't change).
 * `ClientShell` captures session-bound callbacks. `ClientComposer` is
 * reactive (reads a Solid signal). Splitting lets a setup yield exactly
 * what it depends on and lets future client surfaces (SDK headless, web
 * UI) provide a subset.
 */

import { createEffect, createRoot, createSignal } from "solid-js"
import { Context, Effect, Layer } from "effect"
import type { AgentName, DriverRef } from "@gent/core/extensions/api"
import type { OverlayId, ComposerState } from "./client-facets.js"
import type { ClientTransportShape } from "./client-transport"

// ── ClientWorkspace ──────────────────────────────────────────────────────

export interface ClientWorkspaceShape {
  readonly cwd: string
  readonly home: string
}

export class ClientWorkspace extends Context.Service<ClientWorkspace, ClientWorkspaceShape>()(
  "@gent/tui/src/extensions/client-services/ClientWorkspace",
) {}

export const makeClientWorkspaceLayer = (
  payload: ClientWorkspaceShape,
): Layer.Layer<ClientWorkspace> => Layer.succeed(ClientWorkspace, payload)

// ── ClientShell ──────────────────────────────────────────────────────────

export interface ClientShellShape {
  /** Send a chat message into the active session. */
  readonly sendMessage: (content: string) => void
  /** Open a registered overlay by id. */
  readonly openOverlay: (id: OverlayId) => void
  /** Close any open overlay. */
  readonly closeOverlay: () => void
}

export class ClientShell extends Context.Service<ClientShell, ClientShellShape>()(
  "@gent/tui/src/extensions/client-services/ClientShell",
) {}

export const makeClientShellLayer = (payload: ClientShellShape): Layer.Layer<ClientShell> =>
  Layer.succeed(ClientShell, payload)

// ── ClientDriver ─────────────────────────────────────────────────────────

export interface ClientDriverShape {
  readonly list: () => Effect.Effect<
    {
      readonly drivers: ReadonlyArray<{ readonly _tag: "model" | "external"; readonly id: string }>
    },
    Error
  >
  readonly set: (input: {
    readonly agentName: AgentName
    readonly driver: DriverRef
  }) => Effect.Effect<void, Error>
  readonly clear: (input: { readonly agentName: AgentName }) => Effect.Effect<void, Error>
}

export class ClientDriver extends Context.Service<ClientDriver, ClientDriverShape>()(
  "@gent/tui/src/extensions/client-services/ClientDriver",
) {}

export const makeClientDriverLayer = (payload: ClientDriverShape): Layer.Layer<ClientDriver> =>
  Layer.succeed(ClientDriver, payload)

// ── ClientComposer ───────────────────────────────────────────────────────

export interface ClientComposerShape {
  /** Reactive accessor for the current composer state. */
  readonly state: () => ComposerState
}

export class ClientComposer extends Context.Service<ClientComposer, ClientComposerShape>()(
  "@gent/tui/src/extensions/client-services/ClientComposer",
) {}

export const makeClientComposerLayer = (
  payload: ClientComposerShape,
): Layer.Layer<ClientComposer> => Layer.succeed(ClientComposer, payload)

// ── ClientLifecycle ──────────────────────────────────────────────────────

export interface ClientLifecycleShape {
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

export class ClientLifecycle extends Context.Service<ClientLifecycle, ClientLifecycleShape>()(
  "@gent/tui/src/extensions/client-services/ClientLifecycle",
) {}

export const makeClientLifecycleLayer = (
  payload: ClientLifecycleShape,
): Layer.Layer<ClientLifecycle> => Layer.succeed(ClientLifecycle, payload)

// ── Session Resource ─────────────────────────────────────────────────────

type ActiveClientSession = NonNullable<ReturnType<ClientTransportShape["currentSession"]>>

export interface ClientSessionResource<A> {
  readonly read: () => A | undefined
  readonly refetch: () => void
}

export const makeClientSessionResource = <A>(opts: {
  readonly transport: ClientTransportShape
  readonly lifecycle: ClientLifecycleShape
  readonly label: string
  readonly fetch: (session: ActiveClientSession) => Effect.Effect<A, Error>
  readonly subscribe?: (refetch: () => void) => () => void
}): Effect.Effect<ClientSessionResource<A>> =>
  Effect.sync(() => {
    type Keyed = {
      readonly sessionId: string
      readonly branchId: string
      readonly value: A
    }

    let getState: () => Keyed | undefined = () => undefined
    let setState: (next: Keyed | undefined) => void = () => {}

    const read = (): A | undefined => {
      const state = getState()
      const current = opts.transport.currentSession()
      if (state === undefined || current === undefined) return undefined
      if (state.sessionId !== current.sessionId || state.branchId !== current.branchId) {
        return undefined
      }
      return state.value
    }

    const refetchCaptured = (captured: ActiveClientSession): void => {
      opts.transport.cast(
        opts.fetch(captured).pipe(
          Effect.flatMap((value) =>
            Effect.sync(() => {
              const current = opts.transport.currentSession()
              if (
                current === undefined ||
                current.sessionId !== captured.sessionId ||
                current.branchId !== captured.branchId
              ) {
                return
              }
              setState({
                sessionId: captured.sessionId,
                branchId: captured.branchId,
                value,
              })
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
      const session = opts.transport.currentSession()
      if (session === undefined) return
      refetchCaptured(session)
    }

    createRoot((dispose) => {
      const [state, set] = createSignal<Keyed | undefined>(undefined)
      getState = state
      setState = set
      createEffect(() => {
        const session = opts.transport.currentSession()
        setState(undefined)
        if (session === undefined) return
        refetchCaptured(session)
      })
      opts.lifecycle.addCleanup(dispose)
    })

    if (opts.subscribe !== undefined) {
      opts.lifecycle.addCleanup(opts.subscribe(refetch))
    }

    return { read, refetch }
  })
