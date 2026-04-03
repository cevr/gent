// TUI Extension Client Module
//
// Extensions export a setup(ctx) factory that returns UI contributions.
// The TUI discovers *.client.{tsx,ts,js,mjs} files from extension directories,
// imports them, and resolves contributions with scope precedence (project > user > builtin).

import type { InteractionEventTag, ActiveInteractionOf, InteractionResolution } from "./event"
import type {
  AnyExtensionCommandMessage,
  ExtensionProtocol,
  AnyExtensionRequestMessage,
  ExtractExtensionReply,
} from "./extension-protocol.js"

/** Widget placement slots in the session view */
export type WidgetSlot = "below-messages" | "above-input" | "below-input"

/** Props passed to an interaction renderer component */
export interface InteractionRendererProps<T extends InteractionEventTag = InteractionEventTag> {
  readonly event: ActiveInteractionOf<T>
  readonly resolve: (result: InteractionResolution<T>) => void
}

/** Props passed to a custom composer surface component */
export interface ComposerSurfaceProps {
  readonly draft: string
  readonly setDraft: (text: string) => void
  readonly submit: () => void
  readonly focused: boolean
  readonly mode: "editing" | "shell"
}

/** Base interaction renderer contribution — erased tag for heterogeneous arrays */
export interface AnyInteractionRendererContribution {
  readonly eventTag: InteractionEventTag
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly component: (props: any) => unknown
}

/**
 * Type-safe interaction renderer contribution.
 * Links event tag to component props at compile time.
 */
export interface InteractionRendererContribution<
  T extends InteractionEventTag,
> extends AnyInteractionRendererContribution {
  readonly eventTag: T
  readonly component: (props: InteractionRendererProps<T>) => unknown
}

/** Factory that enforces tag–component type coupling */
export const defineInteractionRenderer = <T extends InteractionEventTag>(
  eventTag: T,
  component: (props: InteractionRendererProps<T>) => unknown,
): InteractionRendererContribution<T> => ({ eventTag, component })

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
    readonly onSelect: () => void
    /** Arg-aware slash handler. Called with the args string when invoked via /command args. */
    readonly onSlash?: (args: string) => void
  }>
  /** Full-screen overlay panels */
  readonly overlays?: ReadonlyArray<{
    readonly id: string
    readonly component: TComponent // receives { open, onClose } props
  }>
  /** Interaction renderers — take over composer during interactive prompts.
   *  Use defineInteractionRenderer() for type-safe tag–component coupling. */
  readonly interactionRenderers?: ReadonlyArray<AnyInteractionRendererContribution>
  /** Custom composer surface — replaces the default textarea */
  readonly composerSurface?: TComponent
  /** Border label producers — called each render to contribute labels to the session border */
  readonly borderLabels?: ReadonlyArray<{
    readonly position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
    readonly priority?: number
    readonly produce: () => ReadonlyArray<{ text: string; color: unknown }>
  }>
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
  /** Read the current server-projected snapshot for an extension */
  readonly getSnapshot: (extensionId: string) => { model: unknown } | undefined
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
  readonly protocol?: ExtensionProtocol
  readonly setup: (ctx: ExtensionClientContext) => ExtensionClientSetup<TComponent>
}

/** Factory helper for defining a TUI extension */
export const defineClientExtension = <TComponent = unknown>(
  mod: ExtensionClientModule<TComponent>,
): ExtensionClientModule<TComponent> => mod
