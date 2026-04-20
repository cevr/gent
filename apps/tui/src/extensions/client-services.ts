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
import type { AnyExtensionCommandMessage } from "@gent/core/domain/extension-protocol.js"
import type { OverlayId, ComposerState } from "@gent/core/domain/extension-client.js"

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
  /** Fire an extension protocol message at the active session (no reply). */
  readonly send: (message: AnyExtensionCommandMessage) => void
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
