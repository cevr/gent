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

import { Context, Layer } from "effect"
import type { OverlayId, ComposerState } from "./client-facets.js"

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
