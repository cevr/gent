/**
 * ClientEffect — the Effect-typed authoring surface for TUI client extensions.
 *
 * The legacy `(ctx) => ReadonlyArray<ClientContribution>` shape leaks Promise
 * surfaces (`AsyncFileSystem`, `Promise<reply>` from `ask`, `items` returning
 * sync OR Promise). C9 of the v2 redesign replaces it with an Effect-typed
 * `setup` that reads its dependencies from `ClientDeps` and returns
 * `ReadonlyArray<ClientContribution>` through an Effect, with errors
 * surfaced on the typed `ClientSetupError` channel.
 *
 * The legacy Promise shape continues to compile during C9.1 — both signatures
 * are accepted by `ExtensionClientModule.setup`. C9.2 migrates the 10 builtin
 * client extensions to the new shape; C9.3 deletes `AsyncFileSystem` and the
 * Promise-typed `ask` surface.
 *
 * Solid integration: extensions return contributions; the TUI shell owns one
 * `ManagedRuntime<ClientDeps, never>` (`ClientRuntime`) and runs each setup
 * via `runtime.runPromise`. Async work inside contributions (autocomplete
 * `items`, etc.) is wired via `runtime.runFork(effect, signal.set)` per
 * Solid signal-update lane — the seam is at the rendering edge, not in the
 * Effect surface.
 *
 * Layering: `ClientTransport` is declared here as an opaque service tag —
 * the TUI shell wires it in `apps/tui/src/extensions/client-runtime.ts`
 * because the SDK client types live downstream of `@gent/core`.
 */

import { Context, type Effect, type FileSystem, type Path, Schema } from "effect"

// ── Errors ────────────────────────────────────────────────────────────────

/** Failure surfaced from a client extension's `setup` Effect. */
export class ClientSetupError extends Schema.TaggedErrorClass<ClientSetupError>()(
  "ClientSetupError",
  {
    extensionId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ── Transport ─────────────────────────────────────────────────────────────

/**
 * Opaque transport surface available to client extensions during setup.
 *
 * Core declares the tag; the TUI shell provides the layer with a
 * `GentNamespacedClient` + `GentRuntime` payload. Keeping the interface
 * `unknown` here preserves the package layering (core does not depend on
 * `@gent/sdk`); the TUI exposes a typed re-export via
 * `apps/tui/src/extensions/client-transport.ts` (added in C9.2 when the
 * first Effect-typed client extension needs it).
 */
export interface ClientTransportShape {
  readonly client: unknown
  readonly runtime: unknown
}

export class ClientTransport extends Context.Service<ClientTransport, ClientTransportShape>()(
  "@gent/core/src/domain/client-effect/ClientTransport",
) {}

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * The dependency channel a client extension's setup Effect requires.
 *
 * Intentionally minimal: a client extension does ONLY what the TUI itself
 * does — read files, build paths, call typed transport queries / commands,
 * subscribe to typed events. There is no privileged channel into a paired
 * server extension; everything goes through the same transport surface
 * any client uses.
 *
 * Scope for C9.1: `FileSystem | Path` only. `ClientTransport` joins the
 * union in C9.2 once the TUI shell wires a live transport layer — adding
 * it now would force `ManagedRuntime<ClientDeps, never>` construction in
 * the TUI shell before transport exists.
 */
export type ClientDeps = FileSystem.FileSystem | Path.Path

// ── ClientEffect ──────────────────────────────────────────────────────────

/**
 * An Effect that may read from `ClientDeps` and fail with `ClientSetupError`.
 * The shape every client extension's `setup` returns under the new surface.
 */
export type ClientEffect<A, E = ClientSetupError> = Effect.Effect<A, E, ClientDeps>
