/**
 * TUI client services — typed Effect services that replace the imperative
 * `ExtensionClientContext` surface for Effect-typed extension setups.
 *
 * Today the legacy `(ctx) => ReadonlyArray<ClientContribution>` shape passes
 * a single `ExtensionClientContext` value with a mix of Promise-typed I/O
 * (`fs`, `ask`) and sync callbacks (`send`, `openOverlay`, `composerState`,
 * `getSnapshotRaw`, etc.). C9.3 deletes the Promise-typed surfaces and
 * publishes the sync ones as Effect services so an Effect-typed setup can
 * `yield* ClientWorkspace`, `yield* ClientShell`, etc., without any `ctx`.
 *
 * Layering: the TUI shell builds a per-provider `ManagedRuntime` whose Layer
 * merges `BunFileSystem | BunPath | ClientTransport.Live(...) |
 * ClientWorkspace.Live(...) | ClientShell.Live(...) | ClientComposer.Live(...) |
 * ClientSnapshots.Live(...)`. The loader's Effect-typed setup runs against
 * that runtime via `runtime.runPromise`. Legacy sync setups receive the
 * `ExtensionClientContext` they always have.
 *
 * Why split into multiple services instead of one big `ClientContext`:
 * each service has a different lifetime/coupling profile.
 * `ClientWorkspace` is process-static (cwd/home don't change). `ClientShell`
 * captures session-bound callbacks (send/sendMessage need an active
 * session). `ClientComposer` is reactive (reads a Solid signal). Splitting
 * lets an Effect setup state precisely what it depends on, and lets future
 * client surfaces (SDK headless, web UI) provide a subset.
 *
 * Per-extension state (`getSnapshotRaw` reads the slot for the calling
 * extension's id) is exposed via a *function* on `ClientSnapshots` that
 * takes the extension id, not via a per-extension Layer. The loader passes
 * the extension's id in via closure when constructing the setup-time
 * Effect's environment — see `loader-boundary.ts`.
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

// ── ClientSnapshots ──────────────────────────────────────────────────────

export interface ClientSnapshotsShape {
  /** Read the latest cached snapshot for `extensionId` (or undefined). */
  readonly read: (extensionId: string) => unknown
}

export class ClientSnapshots extends Context.Service<ClientSnapshots, ClientSnapshotsShape>()(
  "@gent/tui/src/extensions/client-services/ClientSnapshots",
) {}

export const makeClientSnapshotsLayer = (
  payload: ClientSnapshotsShape,
): Layer.Layer<ClientSnapshots> => Layer.succeed(ClientSnapshots, payload)
