// TUI Extension Client Module
//
// Extensions export an Effect-typed `setup` that returns contribution buckets.
// The TUI discovers *.client.{tsx,ts,js,mjs}
// files from extension directories, imports them, runs each `setup` against
// the per-provider `clientRuntime`, and resolves contributions with scope
// precedence (project > user > builtin). Setups yield typed services from
// the runtime (`ClientTransport`, `ClientShell`, `ClientWorkspace`,
// `ClientComposer`, `ClientLifecycle`, `FileSystem`, `Path`) — there is no
// `(ctx) => Array` arm and no imperative context bag.
//
// The `ClientContributions` bucket is the foundational data structure here.
// Adding a new facet means adding an explicit field and resolver path, not
// another stringly runtime tag table. Per-bucket conflict rules are preserved
// by the resolver:
//   - renderers: last (highest scope) wins by tool name
//   - widgets:   last (highest scope) wins by widget id; sorted by priority
//   - commands:  last (highest scope) wins by command id; superseded
//                keybind/slash entries are stripped from prior owners
//   - overlays:  last (highest scope) wins by overlay id
//   - interaction renderers: last (highest scope) wins by metadataType
//   - composer surface: single slot, last (highest scope) wins
//   - border labels: collected (no winner), sorted by priority
//   - autocomplete: collected (no winner), scope-ordered

import { type Effect, type ManagedRuntime } from "effect"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/extensions/api"
import type { ClientDeps, ClientEffect, ClientSetupError } from "./client-effect.js"
import type { ToolRenderer } from "../components/tool-renderers/types"
import type { HeadlessToolRenderer } from "../headless-tool-renderers"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { ClientTransport } from "./client-transport"
import type {
  ClientComposer,
  ClientDriver,
  ClientLifecycle,
  ClientShell,
  ClientWorkspace,
} from "./client-services"

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

/** Props passed to registered overlay components. */
export interface OverlayProps {
  readonly open: boolean
  readonly onClose: () => void
}

export type WidgetComponent = () => JSX.Element
export type OverlayComponent = (props: OverlayProps) => JSX.Element
export type InteractionRendererComponent = (props: InteractionRendererProps) => JSX.Element
export type ComposerSurfaceComponent = (props: ComposerSurfaceProps) => JSX.Element

export type ClientRuntimeServices =
  | ClientDeps
  | ClientTransport
  | ClientWorkspace
  | ClientShell
  | ClientDriver
  | ClientComposer
  | ClientLifecycle

export type ClientRuntime = ManagedRuntime.ManagedRuntime<ClientRuntimeServices, never>

/** Item in an autocomplete popup */
export interface AutocompleteItem {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export type AutocompleteItemsEffect = Effect.Effect<
  ReadonlyArray<AutocompleteItem>,
  Error,
  ClientRuntimeServices
>

// ── Contribution shapes ──

export interface RendererContribution {
  readonly toolNames: ReadonlyArray<string>
  readonly component: ToolRenderer
  readonly headless?: HeadlessToolRenderer
}

export interface WidgetContribution {
  readonly id: string
  readonly slot: WidgetSlot
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly component: WidgetComponent
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

export interface OverlayContribution {
  readonly id: string
  /** Receives `{ open, onClose }` props at render time. */
  readonly component: OverlayComponent
}

export interface InteractionRendererContribution {
  /** Matches against metadata.type. undefined = default fallback renderer. */
  readonly metadataType?: string
  readonly component: InteractionRendererComponent
}

export interface ComposerSurfaceContribution {
  readonly component: ComposerSurfaceComponent
}

export type BorderLabelPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right"
export type BorderLabelColor =
  | RGBA
  | "warning"
  | "info"
  | "success"
  | "primary"
  | "text"
  | "textMuted"

export interface BorderLabelItem {
  readonly text: string
  readonly color: BorderLabelColor
}

export interface BorderLabelContribution {
  readonly position: BorderLabelPosition
  /** Lower = earlier; default 100. */
  readonly priority?: number
  readonly produce: () => ReadonlyArray<BorderLabelItem>
}

export interface AutocompleteContribution {
  readonly prefix: string
  readonly title: string
  /** Fetch items for the given filter. Sync OR Effect (no Promise).
   *  - Sync: returned array used directly.
   *  - Effect: run through the TUI shell's `clientRuntime`. R may be any
   *    subset of services the runtime provides (FileSystem | Path |
   *    ClientTransport | ClientWorkspace | ...).
   *  The popup wraps in `createResource` — undefined while loading, items
   *  when resolved. Async work goes through Effect so client extension code
   *  shares the TUI shell runtime and cancellation semantics. */
  readonly items: (filter: string) => ReadonlyArray<AutocompleteItem> | AutocompleteItemsEffect
  /** Format the selected item id for insertion into the draft. Default: `${prefix}${id} ` */
  readonly formatInsertion?: (id: string) => string
  /** Called after an item is selected. Use for side effects like frecency tracking. */
  readonly onSelect?: (id: string, filter: string) => void
}

// ── Buckets ──

export interface ClientContributions {
  readonly renderers?: ReadonlyArray<RendererContribution>
  readonly widgets?: ReadonlyArray<WidgetContribution>
  readonly commands?: ReadonlyArray<ClientCommandContribution>
  readonly overlays?: ReadonlyArray<OverlayContribution>
  readonly interactionRenderers?: ReadonlyArray<InteractionRendererContribution>
  readonly composerSurface?: ComposerSurfaceContribution
  readonly borderLabels?: ReadonlyArray<BorderLabelContribution>
  readonly autocomplete?: ReadonlyArray<AutocompleteContribution>
}

const append = <A>(
  left: ReadonlyArray<A> | undefined,
  right: ReadonlyArray<A> | undefined,
): ReadonlyArray<A> | undefined => {
  if (right === undefined) return left
  if (left === undefined) return right
  return [...left, ...right]
}

export const clientContributions = (
  ...parts: ReadonlyArray<ClientContributions>
): ClientContributions => {
  const out: {
    renderers?: ReadonlyArray<RendererContribution>
    widgets?: ReadonlyArray<WidgetContribution>
    commands?: ReadonlyArray<ClientCommandContribution>
    overlays?: ReadonlyArray<OverlayContribution>
    interactionRenderers?: ReadonlyArray<InteractionRendererContribution>
    composerSurface?: ComposerSurfaceContribution
    borderLabels?: ReadonlyArray<BorderLabelContribution>
    autocomplete?: ReadonlyArray<AutocompleteContribution>
  } = {}

  for (const part of parts) {
    out.renderers = append(out.renderers, part.renderers)
    out.widgets = append(out.widgets, part.widgets)
    out.commands = append(out.commands, part.commands)
    out.overlays = append(out.overlays, part.overlays)
    out.interactionRenderers = append(out.interactionRenderers, part.interactionRenderers)
    out.composerSurface = part.composerSurface ?? out.composerSurface
    out.borderLabels = append(out.borderLabels, part.borderLabels)
    out.autocomplete = append(out.autocomplete, part.autocomplete)
  }

  return out
}

// ── Smart constructors ──

export const rendererContribution = (
  toolNames: ReadonlyArray<string>,
  component: ToolRenderer,
  options?: { readonly headless?: HeadlessToolRenderer },
): ClientContributions => ({ renderers: [{ toolNames, component, ...options }] })

export const widgetContribution = (opts: {
  readonly id: string
  readonly slot: WidgetSlot
  readonly priority?: number
  readonly component: WidgetComponent
}): ClientContributions => ({ widgets: [opts] })

export const clientCommandContribution = (
  opts: ClientCommandContribution,
): ClientContributions => ({ commands: [opts] })

export const overlayContribution = (opts: {
  readonly id: string
  readonly component: OverlayComponent
}): ClientContributions => ({ overlays: [opts] })

/**
 * Build an interaction renderer contribution. The component must be a function
 * accepting `InteractionRendererProps` — core owns this prop shape (it's what
 * the TUI shell calls renderers with), so we type the factory tightly.
 */
export const interactionRendererContribution = (
  component: InteractionRendererComponent,
  metadataType?: string,
): ClientContributions => ({
  interactionRenderers: [{ ...(metadataType === undefined ? {} : { metadataType }), component }],
})

/**
 * Build a composer-surface contribution. The component must be a function
 * accepting `ComposerSurfaceProps` — core owns this prop shape.
 */
export const composerSurfaceContribution = (
  component: ComposerSurfaceComponent,
): ClientContributions => ({ composerSurface: { component } })

export const borderLabelContribution = (opts: BorderLabelContribution): ClientContributions => ({
  borderLabels: [opts],
})

export const autocompleteContribution = (opts: AutocompleteContribution): ClientContributions => ({
  autocomplete: [opts],
})

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
export type ExtensionClientSetup<R extends ClientRuntimeServices = ClientDeps> = ClientEffect<
  ClientContributions,
  ClientSetupError,
  R
>

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files.
 *
 * `R` defaults to `ClientDeps` (FileSystem | Path). An extension that yields
 * additional services (e.g. a TUI-side `ClientTransport`) widens `R` and
 * relies on the loader's runtime to provide every service it requires.
 */
export interface ExtensionClientModule<R extends ClientRuntimeServices = ClientDeps> {
  readonly id: string
  readonly setup: ExtensionClientSetup<R>
}

export type AnyExtensionClientModule = ExtensionClientModule<ClientRuntimeServices>

/**
 * Create a TUI client extension module with typed contributions. Server
 * extensions and TUI client modules share an id by convention — the TUI
 * loader looks up the module by id when wiring contributions.
 *
 * The setup is an Effect. Read the typed transport via
 * `yield* ClientTransport` and the other services via `yield* ClientShell` /
 * `ClientComposer` / `ClientWorkspace`.
 */
export function defineClientExtension<R extends ClientRuntimeServices = ClientDeps>(
  id: string,
  spec: { readonly setup: ExtensionClientSetup<R> },
): ExtensionClientModule<R> {
  return { id, setup: spec.setup }
}
