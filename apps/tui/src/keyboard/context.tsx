import { createContext, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { useKeyboard } from "@opentui/solid"

type KeyInput = Parameters<Parameters<typeof useKeyboard>[0]>[0]
type ScopedKeyHandler = (event: KeyInput) => boolean | void

interface KeyboardScopeEntry {
  order: number
  when?: () => boolean
  capture?: boolean
  handler: ScopedKeyHandler
}

interface KeyboardScopeContextValue {
  register: (entry: Omit<KeyboardScopeEntry, "order">) => () => void
}

const KeyboardScopeContext = createContext<KeyboardScopeContextValue>()

export interface ScopedKeyboardOptions {
  when?: () => boolean
  capture?: boolean
}

export function KeyboardScopeProvider(props: ParentProps) {
  const entries: KeyboardScopeEntry[] = []
  let order = 0

  useKeyboard((event) => {
    const stack = [...entries].sort((left, right) => right.order - left.order)
    for (const entry of stack) {
      if (entry.when?.() === false) continue
      const handled = entry.handler(event) === true
      if (handled || entry.capture === true) return
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
  const context = useContext(KeyboardScopeContext)
  if (context === undefined) {
    throw new Error("useScopedKeyboard must be used within KeyboardScopeProvider")
  }

  onMount(() => {
    const unregister = context.register({
      handler,
      when: options?.when,
      capture: options?.capture,
    })
    onCleanup(unregister)
  })
}
