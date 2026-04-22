// TUI Extension Client Module
//
// Extensions export an Effect-typed `setup` that returns a flat
// `ClientContribution[]` array. The TUI discovers *.client.{tsx,ts,js,mjs}
// files from extension directories, imports them, runs each `setup` against
// the per-provider `clientRuntime`, and resolves contributions with scope
// precedence (project > user > builtin). Setups yield typed services from
// the runtime (`ClientTransport`, `ClientShell`, `ClientWorkspace`,
// `ClientComposer`, `ClientLifecycle`, `FileSystem`, `Path`) — there is no
// `(ctx) => Array` arm and no imperative context bag.
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

import type { Effect } from "effect"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/domain/event.js"
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
  /** Fetch items for the given filter. Sync OR Effect (no Promise).
   *  - Sync: returned array used directly.
   *  - Effect: run through the TUI shell's `clientRuntime`. R may be any
   *    subset of services the runtime provides (FileSystem | Path |
   *    ClientTransport | ClientWorkspace | ...).
   *  The popup wraps in `createResource` — undefined while loading, items
   *  when resolved. C9.3 deleted the Promise variant per
   *  `migrate-callers-then-delete-legacy-apis`; async work goes through
   *  Effect now. */
  readonly items: (filter: string) =>
    | ReadonlyArray<AutocompleteItem>
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

/** Overlay identifier (registered in `OverlayContribution`). */
export type OverlayId = string

/** Snapshot of the active composer at a point in time. */
export interface ComposerState {
  readonly draft: string
  readonly mode: "editing" | "shell"
  readonly inputFocused: boolean
  readonly autocompleteOpen: boolean
}

/**
 * A client extension's setup is an Effect that yields its dependencies
 * from the per-provider TUI runtime — `ClientDeps` (FileSystem | Path) by
 * default, widened by every TUI service the extension yields
 * (`ClientWorkspace`, `ClientShell`, `ClientComposer`, `ClientTransport`).
 *
 * The TUI shell publishes its typed `ClientTransport` tag at
 * `apps/tui/src/extensions/client-transport.ts`; an extension that needs
 * the transport yields it and the per-provider `ManagedRuntime` provides
 * it. Errors flow on the typed `ClientSetupError` channel.
 */
export type ExtensionClientSetup<TComponent = unknown, R = ClientDeps> = ClientEffect<
  ReadonlyArray<ClientContribution<TComponent>>,
  ClientSetupError,
  R
>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path). An extension that yields
 * additional services (e.g. a TUI-side `ClientTransport`) widens `R` and
 * relies on the loader's runtime to provide every service it requires.
 */
export interface ExtensionClientModule<TComponent = unknown, R = ClientDeps> {
  readonly id: string
  readonly setup: ExtensionClientSetup<TComponent, R>
}

/**
 * Standalone factory for TUI client modules. Server extensions and TUI
 * client modules share an id by convention — the TUI loader looks up the
 * module by id when wiring contributions.
 *
 * The setup is an Effect; legacy sync `(ctx) => Array` shape is gone (B11.6).
 * Read the typed transport via `yield* ClientTransport` and the other
 * services via `yield* ClientShell` / `ClientComposer` / `ClientWorkspace`.
 */
function standaloneClientModule<TComponent = unknown, R = unknown>(
  id: string,
  spec: { readonly setup: ExtensionClientSetup<TComponent, R> },
): ExtensionClientModule<TComponent, R> {
  return { id, setup: spec.setup }
}

/** Create a TUI client extension module with typed contributions. */
export const defineClientExtension = standaloneClientModule

/** @deprecated Use `defineClientExtension` directly. */
export const ExtensionPackage = {
  tui: standaloneClientModule,
}
