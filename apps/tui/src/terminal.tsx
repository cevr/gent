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

interface KeyboardScopeContextValue {
  register: (entry: Omit<KeyboardScopeEntry, "order">) => () => void
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
  let order = 0

  useKeyboard((event) => {
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

  return (
    <KeyboardScopeContext.Provider value={{ register }}>
      {props.children}
    </KeyboardScopeContext.Provider>
  )
}

export function useScopedKeyboard(handler: ScopedKeyHandler, options?: ScopedKeyboardOptions) {
  const context = useRequiredContext(
    KeyboardScopeContext,
    "useScopedKeyboard must be used within KeyboardScopeProvider",
  )

  onMount(() => {
    const unregister = context.register({
      handler,
      when: options?.when,
      capture: options?.capture,
      paste: options?.paste,
    })
    onCleanup(unregister)
  })
}
