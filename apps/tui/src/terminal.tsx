/** @jsxImportSource @opentui/solid */
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions as useRendererTerminalDimensions,
} from "@opentui/solid"
import { Option } from "effect"
import {
  type Accessor,
  createContext,
  createMemo,
  onCleanup,
  onMount,
  type ParentProps,
  useContext,
} from "solid-js"
import { useRequiredContext } from "./utils"

// ── terminal dimensions ─────────────────────────────────────────────────────

interface TerminalDimensions {
  readonly width: number
  readonly height: number
}

const TerminalDimensionsContext = createContext<Option.Option<Accessor<TerminalDimensions>>>(
  Option.none(),
)

export function TerminalDimensionsProvider(props: ParentProps) {
  const renderer = useRenderer()
  const surfaceDimensions = useRendererTerminalDimensions()
  const dimensions = createMemo(() => {
    surfaceDimensions()
    return { width: renderer.terminalWidth, height: renderer.terminalHeight }
  })
  return (
    <TerminalDimensionsContext.Provider value={Option.some(dimensions)}>
      {props.children}
    </TerminalDimensionsContext.Provider>
  )
}

export const useTerminalDimensions = (): Accessor<TerminalDimensions> =>
  Option.getOrThrow(useContext(TerminalDimensionsContext))

// ── keyboard provider ───────────────────────────────────────────────────────

type KeyInput = Parameters<Parameters<typeof useKeyboard>[0]>[0]
type ScopedKeyHandler = (event: KeyInput) => boolean | void
/** Takes the pasted text; `true` means the scope took it. */
type ScopedPasteHandler = (text: string) => boolean
export type ScopedKeyboardEvent = KeyInput

interface KeyboardScopeEntry {
  order: number
  when?: () => boolean
  capture?: boolean
  handler: ScopedKeyHandler
  paste?: ScopedPasteHandler
}

/** Sees every key and paste before any scope does, and never takes one. */
interface InputWatch {
  readonly key: (event: KeyInput) => void
  readonly paste: () => void
}

interface KeyboardScopeContextValue {
  register: (entry: Omit<KeyboardScopeEntry, "order">) => () => void
  watch: (watch: InputWatch) => () => void
}

const KeyboardScopeContext = createContext<KeyboardScopeContextValue>()

interface ScopedKeyboardOptions {
  when?: () => boolean
  capture?: boolean
  /**
   * A paste arrives as its own event, not as keys. A scope that types text
   * takes it here; the terminal otherwise hands it to the focused composer.
   */
  paste?: ScopedPasteHandler
}

export function KeyboardScopeProvider(props: ParentProps) {
  const entries: KeyboardScopeEntry[] = []
  const watches: InputWatch[] = []
  let order = 0

  useKeyboard((event) => {
    for (const watch of [...watches]) watch.key(event)
    const stack = [...entries].sort((left, right) => right.order - left.order)
    for (const entry of stack) {
      if (entry.when?.() === false) continue
      const handled = entry.handler(event) === true
      if (handled || entry.capture === true) {
        event.stopPropagation()
        return
      }
    }
  })

  // The same stack, newest first: the first live scope that takes the paste
  // keeps it from the focused renderable.
  usePaste((event) => {
    for (const watch of [...watches]) watch.paste()
    const stack = [...entries].sort((left, right) => right.order - left.order)
    const text = new TextDecoder().decode(event.bytes)
    for (const entry of stack) {
      if (entry.when?.() === false) continue
      if (entry.paste?.(text) !== true) continue
      event.preventDefault()
      event.stopPropagation()
      return
    }
  })

  const register = (entry: Omit<KeyboardScopeEntry, "order">) => {
    const scopedEntry: KeyboardScopeEntry = {
      ...entry,
      order: ++order,
    }
    entries.push(scopedEntry)
    return () => {
      const index = entries.indexOf(scopedEntry)
      if (index >= 0) entries.splice(index, 1)
    }
  }

  const watch = (entry: InputWatch) => {
    watches.push(entry)
    return () => {
      const index = watches.indexOf(entry)
      if (index >= 0) watches.splice(index, 1)
    }
  }

  return (
    <KeyboardScopeContext.Provider value={{ register, watch }}>
      {props.children}
    </KeyboardScopeContext.Provider>
  )
}

/**
 * Whether the scopes under it take keys and pastes. A pane that draws no
 * row gates its scopes off, so a key the reader cannot see acted on goes
 * past it. Gates nest: a scope takes input only while every gate over it is open.
 */
const KeyboardGateContext = createContext<() => boolean>(() => true)

export function KeyboardGate(props: ParentProps<{ open: () => boolean }>) {
  const outer = useContext(KeyboardGateContext)
  const open = () => outer() && props.open()
  return <KeyboardGateContext.Provider value={open}>{props.children}</KeyboardGateContext.Provider>
}

export function useScopedKeyboard(handler: ScopedKeyHandler, options?: ScopedKeyboardOptions) {
  const context = useRequiredContext(
    KeyboardScopeContext,
    "useScopedKeyboard must be used within KeyboardScopeProvider",
  )
  const gate = useContext(KeyboardGateContext)

  onMount(() => {
    const unregister = context.register({
      handler,
      when: () => gate() && options?.when?.() !== false,
      capture: options?.capture,
      paste: options?.paste,
    })
    onCleanup(unregister)
  })
}

/**
 * Watches every key and paste, also those a scope takes, before any scope
 * runs. It cannot take one: a gesture a docked pane consumes still reaches it.
 */
export function useInputWatch(watch: InputWatch) {
  const context = useRequiredContext(
    KeyboardScopeContext,
    "useInputWatch must be used within KeyboardScopeProvider",
  )

  onMount(() => {
    onCleanup(context.watch(watch))
  })
}
