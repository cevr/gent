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

import type { Effect, FileSystem, Path, Schema } from "effect"
import type { ActiveInteraction, ApprovalResult } from "./event"
import type {
  AnyExtensionCommandMessage,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "./extension-protocol.js"

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
  /** Fetch items for the given filter. Sync or async.
   *  Popup wraps in createResource — undefined while loading, items when resolved. */
  readonly items: (
    filter: string,
  ) => ReadonlyArray<AutocompleteItem> | Promise<ReadonlyArray<AutocompleteItem>>
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
  /** Read and decode a server-projected snapshot for an extension. Returns undefined if missing or decode fails. */
  readonly getSnapshot: <A>(extensionId: string, schema: Schema.Decoder<A>) => A | undefined
  /** Send a user message to the active session */
  readonly sendMessage: (content: string) => void
  /** Reactive composer state */
  readonly composerState: () => {
    readonly draft: string
    readonly mode: "editing" | "shell"
    readonly inputFocused: boolean
    readonly autocompleteOpen: boolean
  }
}

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files */
export interface ExtensionClientModule<TComponent = unknown> {
  readonly id: string
  readonly setup: (ctx: ExtensionClientContext) => ReadonlyArray<ClientContribution<TComponent>>
}
