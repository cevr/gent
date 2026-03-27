// TUI Extension Client Module
//
// Extensions export a setup(ctx) factory that returns UI contributions.
// The TUI discovers *.client.{tsx,ts,js,mjs} files from extension directories,
// imports them, and resolves contributions with scope precedence (project > user > builtin).

/** Widget placement slots in the session view */
export type WidgetSlot = "above-messages" | "below-messages" | "above-input" | "below-input"

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
    readonly category?: string
    readonly keybind?: string
    /** Slash command trigger (without the /). When set, /name invokes onSelect. */
    readonly slash?: string
    readonly onSelect: () => void
  }>
  /** Full-screen overlay panels */
  readonly overlays?: ReadonlyArray<{
    readonly id: string
    readonly component: TComponent // receives { open, onClose } props
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
  /** Dispatch a typed intent to a server-side extension actor (fire-and-forget) */
  readonly sendIntent: (extensionId: string, intent: unknown) => void
}

/** A TUI extension module — default export of *.client.{tsx,ts,js,mjs} files */
export interface ExtensionClientModule<TComponent = unknown> {
  readonly id: string
  readonly setup: (ctx: ExtensionClientContext) => ExtensionClientSetup<TComponent>
}

/** Factory helper for defining a TUI extension */
export const defineClientExtension = <TComponent = unknown>(
  mod: ExtensionClientModule<TComponent>,
): ExtensionClientModule<TComponent> => mod
