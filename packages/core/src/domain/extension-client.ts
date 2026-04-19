// TUI Extension Client Module
//
// Extensions export a setup(ctx) factory that returns a flat
// `ClientContribution[]` array. The TUI discovers *.client.{tsx,ts,js,mjs}
// files from extension directories, imports them, and resolves contributions
// with scope precedence (project > user > builtin).
//
// The `ClientContribution` union is the foundational data structure here —
// adding a new kind requires registering it in the resolver's HANDLED_KINDS set
// (apps/tui/src/extensions/resolve.ts) and adding a per-kind resolver, otherwise
// the resolver throws at the entry guard for any unknown _kind.
// Per-kind conflict rules are preserved by the resolver:
//   - renderers: last (highest scope) wins by tool name
//   - widgets:   last (highest scope) wins by widget id; sorted by priority
//   - commands:  last (highest scope) wins by command id; superseded
//                keybind/slash entries are stripped from prior owners
//   - overlays:  last (highest scope) wins by overlay id
//   - interaction renderers: last (highest scope) wins by metadataType
//   - composer surface: single slot, last (highest scope) wins
//   - border labels: collected (no winner), sorted by priority
//   - autocomplete: collected (no winner), scope-ordered

import type { Effect, FileSystem, Path } from "effect"
import type { ActiveInteraction, ApprovalResult } from "./event"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "./extension-protocol.js"
import type { QueryRef } from "./query.js"
import type { ClientDeps, ClientEffect, ClientSetupError } from "./client-effect.js"

/** Widget placement slots in the session view */
export type WidgetSlot = "below-messages" | "above-input" | "below-input"

/** Props passed to an interaction renderer component */
export interface InteractionRendererProps {
  readonly event: ActiveInteraction
  readonly resolve: (result: ApprovalResult) => void
}

/** Props passed to a custom composer surface component */
export interface ComposerSurfaceProps {
  readonly draft: string
  readonly setDraft: (text: string) => void
  readonly submit: () => void
  readonly focused: boolean
  readonly mode: "editing" | "shell"
}

/** Item in an autocomplete popup */
export interface AutocompleteItem {
  readonly id: string
  readonly label: string
  readonly description?: string
}

// ── Per-kind contribution shapes ──

export interface RendererContribution<TComponent = unknown> {
  readonly _kind: "renderer"
  readonly toolNames: ReadonlyArray<string>
  readonly component: TComponent
}

export interface WidgetContribution<TComponent = unknown> {
  readonly _kind: "widget"
  readonly id: string
  readonly slot: WidgetSlot
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly component: TComponent
}

export interface PaletteLevelEntry {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly onSelect: () => void
}

export interface PaletteLevel {
  readonly id: string
  readonly title: string
  readonly source: () => ReadonlyArray<PaletteLevelEntry> | undefined
  readonly onEnter?: () => void
}

export interface ClientCommandContribution {
  readonly _kind: "command"
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly category?: string
  readonly keybind?: string
  /** Slash command trigger (without the /). When set, /name invokes onSlash (or onSelect if no onSlash). */
  readonly slash?: string
  /** Additional slash names that resolve to this command */
  readonly aliases?: ReadonlyArray<string>
  /** Slash command priority. Lower wins. Builtins are 0, default extension is 10. Set < 0 to override builtins. */
  readonly slashPriority?: number
  readonly onSelect: () => void
  /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
  readonly onSlash?: (args: string) => void
  /** When set, selecting in the palette pushes a sub-level instead of calling onSelect. */
  readonly paletteLevel?: () => PaletteLevel
}

export interface OverlayContribution<TComponent = unknown> {
  readonly _kind: "overlay"
  readonly id: string
  /** Receives `{ open, onClose }` props at render time. */
  readonly component: TComponent
}

export interface InteractionRendererContribution<TComponent = unknown> {
  readonly _kind: "interaction-renderer"
  /** Matches against metadata.type. undefined = default fallback renderer. */
  readonly metadataType?: string
  readonly component: TComponent
}

export interface ComposerSurfaceContribution<TComponent = unknown> {
  readonly _kind: "composer-surface"
  readonly component: TComponent
}

export type BorderLabelPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right"

export interface BorderLabelContribution {
  readonly _kind: "border-label"
  readonly position: BorderLabelPosition
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly produce: () => ReadonlyArray<{ text: string; color: unknown }>
}

export interface AutocompleteContribution {
  readonly _kind: "autocomplete"
  readonly prefix: string
  readonly title: string
  /** Fetch items for the given filter. Sync, Promise, or Effect.
   *  - Sync: returned array used directly.
   *  - Promise: awaited.
   *  - Effect: run via the popup's `runtime.runFork(...)` adapter. R may be
   *    any subset of services the TUI shell's `clientRuntime` provides
   *    (FileSystem | Path | ClientTransport).
   *  The popup wraps in `createResource` — undefined while loading, items
   *  when resolved. */
  readonly items: (filter: string) =>
    | ReadonlyArray<AutocompleteItem>
    | Promise<ReadonlyArray<AutocompleteItem>>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | Effect.Effect<ReadonlyArray<AutocompleteItem>, any, any>
  /** Format the selected item id for insertion into the draft. Default: `${prefix}${id} ` */
  readonly formatInsertion?: (id: string) => string
  /** Called after an item is selected. Use for side effects like frecency tracking. */
  readonly onSelect?: (id: string, filter: string) => void
}

// ── Union ──

export type ClientContribution<TComponent = unknown> =
  | RendererContribution<TComponent>
  | WidgetContribution<TComponent>
  | ClientCommandContribution
  | OverlayContribution<TComponent>
  | InteractionRendererContribution<TComponent>
  | ComposerSurfaceContribution<TComponent>
  | BorderLabelContribution
  | AutocompleteContribution

export type ClientContributionKind = ClientContribution["_kind"]

// ── Smart constructors ──

export const rendererContribution = <TComponent>(
  toolNames: ReadonlyArray<string>,
  component: TComponent,
): RendererContribution<TComponent> => ({ _kind: "renderer", toolNames, component })

export const widgetContribution = <TComponent>(opts: {
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority?: number
  readonly component: TComponent
}): WidgetContribution<TComponent> => ({ _kind: "widget", ...opts })

export const clientCommandContribution = (
  opts: Omit<ClientCommandContribution, "_kind">,
): ClientCommandContribution => ({ _kind: "command", ...opts })

export const overlayContribution = <TComponent>(opts: {
  readonly id: string
  readonly component: TComponent
}): OverlayContribution<TComponent> => ({ _kind: "overlay", ...opts })

/**
 * Build an interaction renderer contribution. The component must be a function
 * accepting `InteractionRendererProps` — core owns this prop shape (it's what
 * the TUI shell calls renderers with), so we type the factory tightly.
 */
export const interactionRendererContribution = <
  TComponent extends (props: InteractionRendererProps) => unknown,
>(
  component: TComponent,
  metadataType?: string,
): InteractionRendererContribution<TComponent> => ({
  _kind: "interaction-renderer",
  metadataType,
  component,
})

/** Backwards-compatible alias for the old `defineInteractionRenderer` factory. */
export const defineInteractionRenderer = interactionRendererContribution

/**
 * Build a composer-surface contribution. The component must be a function
 * accepting `ComposerSurfaceProps` — core owns this prop shape.
 */
export const composerSurfaceContribution = <
  TComponent extends (props: ComposerSurfaceProps) => unknown,
>(
  component: TComponent,
): ComposerSurfaceContribution<TComponent> => ({ _kind: "composer-surface", component })

export const borderLabelContribution = (
  opts: Omit<BorderLabelContribution, "_kind">,
): BorderLabelContribution => ({ _kind: "border-label", ...opts })

export const autocompleteContribution = (
  opts: Omit<AutocompleteContribution, "_kind">,
): AutocompleteContribution => ({ _kind: "autocomplete", ...opts })

/**
 * Async filesystem proxy — every method that returns Effect<A, E> returns Promise<A> instead.
 * Built via `new Proxy` over Effect's FileSystem at setup time.
 */
export type AsyncFileSystem = {
  [K in keyof FileSystem.FileSystem]: FileSystem.FileSystem[K] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer _E, infer _R>
    ? (...args: Args) => Promise<A>
    : FileSystem.FileSystem[K]
}

/** Overlay identifier (registered in `OverlayContribution`). */
export type OverlayId = string

/** Snapshot of the active composer at a point in time. */
export interface ComposerState {
  readonly draft: string
  readonly mode: "editing" | "shell"
  readonly inputFocused: boolean
  readonly autocompleteOpen: boolean
}

/** Runtime API provided to extensions during setup */
export interface ExtensionClientContext {
  /** Working directory for the current workspace */
  readonly cwd: string
  /** User home directory */
  readonly home: string
  /** Async file system — same shape as Effect FileSystem, but returns Promises. */
  readonly fs: AsyncFileSystem
  /** Sync path utilities (join, resolve, dirname, basename, etc). */
  readonly path: Path.Path
  readonly openOverlay: (id: string) => void
  readonly closeOverlay: () => void
  /** Current session ID (reactive — may be undefined before session is active) */
  readonly sessionId?: string
  /** Current branch ID (reactive — may be undefined before session is active) */
  readonly branchId?: string
  /** Send a protocol command to a server-side extension actor (fire-and-forget) */
  readonly send: (message: AnyExtensionCommandMessage) => void
  /** Ask a protocol request of a server-side extension actor */
  readonly ask: <M extends AnyExtensionRequestMessage>(
    message: M,
  ) => Promise<ExtractExtensionReply<M>>
  /** Sync read of the latest cached snapshot for this extension, if the
   *  package declared a `snapshotRequest` or `snapshotQuery`. The cache is
   *  populated by the TUI provider on every `ExtensionStateChanged` pulse.
   *  Returns `undefined` if the package did not declare a snapshot source or
   *  no pulse has been received yet. */
  readonly getSnapshotRaw: () => unknown
  /** Send a user message to the active session */
  readonly sendMessage: (content: string) => void
  /** Reactive composer state */
  readonly composerState: () => ComposerState
}

/**
 * A client extension's setup signature.
 *
 * Two shapes are accepted during the C9 transition:
 *   - **Legacy** (Promise surface): `(ctx) => ReadonlyArray<ClientContribution>`.
 *     Reads dependencies off the imperative `ExtensionClientContext` (with
 *     `AsyncFileSystem`, Promise-typed `ask`, etc.). Sync only — async work
 *     must happen inside contributions, not during setup.
 *   - **Effect** (C9 target): `ClientEffect<ReadonlyArray<ClientContribution>>`.
 *     Reads dependencies off `ClientDeps` (Effect's `FileSystem`, `Path`)
 *     plus any extra services the extension widens `R` with. The TUI shell
 *     publishes its typed `ClientTransport` tag at
 *     `apps/tui/src/extensions/client-transport.ts`; an extension that
 *     needs the transport yields it from its setup and the TUI's
 *     per-provider `ManagedRuntime` provides it. Errors flow on the typed
 *     `ClientSetupError` channel.
 *
 * The loader detects which shape was returned and dispatches accordingly.
 * C9.2 proved the Effect shape with `skills.client.ts`; C9.3 deletes
 * `AsyncFileSystem` and the Promise-typed `ask` and migrates the
 * remaining builtins.
 */
export type ExtensionClientSetup<TComponent = unknown, R = ClientDeps> =
  | ((ctx: ExtensionClientContext) => ReadonlyArray<ClientContribution<TComponent>>)
  | ClientEffect<ReadonlyArray<ClientContribution<TComponent>>, ClientSetupError, R>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path). An extension that yields
 * additional services (e.g. a TUI-side `ClientTransport`) widens `R` and
 * relies on the loader's runtime to provide every service it requires.
 */
export interface ExtensionClientModule<TComponent = unknown, R = ClientDeps> {
  readonly id: string
  readonly setup: ExtensionClientSetup<TComponent, R>
  /** Optional snapshot source published by the paired `defineExtensionPackage`.
   *  The TUI provider uses this to refetch on `ExtensionStateChanged` pulses
   *  and populate the cache that backs `ctx.getSnapshotRaw()`.
   *  Exactly one of `request` / `query` is set when present. */
  readonly snapshotSource?: SnapshotSource
}

export type SnapshotSource =
  | { readonly _tag: "request"; readonly request: () => AnyExtensionRequestMessage }
  | { readonly _tag: "query"; readonly query: QueryRef }
