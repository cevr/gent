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

// ── Dependencies ──────────────────────────────────────────────────────────

/**
 * The dependency channel a client extension's setup Effect MAY require.
 *
 * `ClientDeps` is the universal core-level set: file system and path
 * services. It's a *floor*, not a ceiling — an individual client surface
 * (the TUI shell, a future SDK headless, a web UI) augments its runtime
 * with additional services like transport, theming, or platform-specific
 * APIs, and an extension that yields one of those declares a wider `R`.
 *
 * Core does NOT declare `ClientTransport` because its payload type lives
 * downstream of `@gent/core` (`GentNamespacedClient` + `GentRuntime` are
 * SDK types). The TUI declares its own `ClientTransport` tag with a typed
 * payload at `apps/tui/src/extensions/client-transport.ts` (C9.2). Other
 * client surfaces would do the same with whatever transport they speak.
 */
export type ClientDeps = FileSystem.FileSystem | Path.Path

// ── ClientEffect ──────────────────────────────────────────────────────────

/**
 * An Effect that returns a value, may fail with `ClientSetupError`, and may
 * read from any subset of services its runtime provides. `R` defaults to
 * `ClientDeps` — the floor — so a setup that only needs `FileSystem`/`Path`
 * compiles without ceremony. Extensions needing more (transport, theme,
 * shell-specific services) widen `R` themselves; the loader's runtime
 * provides whatever services the extension yields.
 */
export type ClientEffect<A, E = ClientSetupError, R = ClientDeps> = Effect.Effect<A, E, R>

// `Context` import retained for downstream tag declarations re-exporting
// from this module (currently none — kept for API stability).
export { Context }
