// TUI Extension Client Module
//
// Extensions export a setup(ctx) factory that returns UI contributions.
// The TUI discovers *.client.{tsx,ts,js,mjs} files from extension directories,
// imports them, and resolves contributions with scope precedence (project > user > builtin).

import type { Schema } from "effect"
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

/** Interaction renderer contribution */
export interface InteractionRendererContribution {
  /** Matches against metadata.type to route to the right renderer. undefined = default renderer. */
  readonly metadataType?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly component: (props: InteractionRendererProps) => unknown
}

/** Factory for defining an interaction renderer */
export const defineInteractionRenderer = (
  component: (props: InteractionRendererProps) => unknown,
  metadataType?: string,
): InteractionRendererContribution => ({ metadataType, component })

/** Item in an autocomplete popup */
export interface AutocompleteItem {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** Autocomplete popup contribution — registers a prefix trigger and item source */
export interface AutocompleteContribution {
  readonly prefix: string
  readonly title: string
  /** Trigger mode:
   *  - "inline": detected anywhere in text after whitespace (like $ and @)
   *  - "start": only at cursor position 0 (like /) */
  readonly trigger: "inline" | "start"
  /** Fetch items for the given filter. Sync or async.
   *  Popup wraps in createResource — undefined while loading, items when resolved. */
  readonly items: (
    filter: string,
  ) => ReadonlyArray<AutocompleteItem> | Promise<ReadonlyArray<AutocompleteItem>>
  /** Format the selected item id for insertion into the draft.
   *  Default: `${prefix}${id} ` */
  readonly formatInsertion?: (id: string) => string
}

/** What a TUI extension contributes after setup */
export interface ExtensionClientSetup<TComponent = unknown> {
  /** Tool renderers keyed by tool name(s) */
  readonly tools?: ReadonlyArray<{
    readonly toolNames: ReadonlyArray<string>
    readonly component: TComponent
  }>
  /** Persistent widgets placed at fixed slots */
  readonly widgets?: ReadonlyArray<{
    readonly id: string
    readonly slot: WidgetSlot
    readonly priority?: number // Lower = earlier, default 100
    readonly component: TComponent
  }>
  /** Command palette entries */
  readonly commands?: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly description?: string
    readonly category?: string
    readonly keybind?: string
    /** Slash command trigger (without the /). When set, /name invokes onSlash (or onSelect if no onSlash). */
    readonly slash?: string
    /** Slash command priority. Lower wins. Builtins are 0, default extension is 10. Set < 0 to override builtins. */
    readonly slashPriority?: number
    readonly onSelect: () => void
    /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
    readonly onSlash?: (args: string) => void
    /** When set, selecting in the palette pushes a sub-level instead of calling onSelect.
     *  Return a factory function — called lazily when the user navigates into the level. */
    readonly paletteLevel?: () => {
      readonly id: string
      readonly title: string
      readonly source: () =>
        | ReadonlyArray<{
            readonly id: string
            readonly title: string
            readonly description?: string
            readonly category?: string
            readonly onSelect: () => void
          }>
        | undefined
      readonly onEnter?: () => void
    }
  }>
  /** Full-screen overlay panels */
  readonly overlays?: ReadonlyArray<{
    readonly id: string
    readonly component: TComponent // receives { open, onClose } props
  }>
  /** Interaction renderers — take over composer during interactive prompts.
   *  Use defineInteractionRenderer() for type-safe coupling. */
  readonly interactionRenderers?: ReadonlyArray<InteractionRendererContribution>
  /** Custom composer surface — replaces the default textarea */
  readonly composerSurface?: TComponent
  /** Border label producers — called each render to contribute labels to the session border */
  readonly borderLabels?: ReadonlyArray<{
    readonly position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
    readonly priority?: number
    readonly produce: () => ReadonlyArray<{ text: string; color: unknown }>
  }>
  /** Autocomplete popup contributions — register prefix triggers and item sources */
  readonly autocompleteItems?: ReadonlyArray<AutocompleteContribution>
}

/** Runtime API provided to extensions during setup */
export interface ExtensionClientContext {
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
  readonly setup: (ctx: ExtensionClientContext) => ExtensionClientSetup<TComponent>
}
