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

// ── typed and pasted text ───────────────────────────────────────────────────

const ESC = "\u001b"
const BEL = "\u0007"
/** 8-bit CSI, OSC and ST: C1 controls that open or end a sequence. */
const CSI_8BIT = "\u009b"
const OSC_8BIT = "\u009d"
const ST_8BIT = "\u009c"

/** A C0 or C1 control, or DEL: never text a line keeps. */
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/** A CSI final byte (`@` through `~`) ends the sequence. */
const isFinalByte = (char: string): boolean => char >= "@" && char <= "~"

/**
 * Text a key types into a one-line field: printable, never a control
 * sequence. A key that sends a control byte (Tab, Esc, a C1 control) types
 * nothing.
 */
export const typedText = (sequence: Option.Option<string>): Option.Option<string> =>
  Option.filter(sequence, (text) => text.length > 0 && ![...text].some(isControl))

/** The index after a string sequence's end: BEL, ESC then backslash, or 8-bit ST. */
const skipString = (chars: ReadonlyArray<string>, from: number): number => {
  let at = from
  while (at < chars.length) {
    const char = chars[at]
    if (char === BEL || char === ST_8BIT) return at + 1
    if (char === ESC && chars[at + 1] === "\\") return at + 2
    at += 1
  }
  return at
}

/** The index after a CSI's parameters, intermediates and final byte. */
const skipCsi = (chars: ReadonlyArray<string>, from: number): number => {
  let at = from
  while (at < chars.length && !isFinalByte(chars[at] ?? "")) at += 1
  return at + 1
}

/** ESC opens a CSI (`[`), a string sequence (OSC, DCS, SOS, PM, APC), or a two-character pair. */
const STRING_OPENERS = new Set(["]", "P", "X", "^", "_"])

/** The index after the 7-bit sequence that starts at the ESC at `at`. */
const skipEscape = (chars: ReadonlyArray<string>, at: number): number => {
  const next = chars[at + 1] ?? ""
  if (next === "[") return skipCsi(chars, at + 2)
  if (STRING_OPENERS.has(next)) return skipString(chars, at + 2)
  return at + 2
}

/** One step of a paste: the index after what starts at `at`, and the text it adds. */
const pasteStep = (
  chars: ReadonlyArray<string>,
  at: number,
  lineBreak: string,
): readonly [number, string] => {
  const char = chars[at] ?? ""
  if (char === "\r" && chars[at + 1] === "\n") return [at + 2, lineBreak]
  if (char === "\n" || char === "\r") return [at + 1, lineBreak]
  if (char === ESC) return [skipEscape(chars, at), ""]
  if (char === CSI_8BIT) return [skipCsi(chars, at + 1), ""]
  if (char === OSC_8BIT) return [skipString(chars, at + 1), ""]
  if (isControl(char)) return [at + 1, ""]
  return [at + 1, char]
}

/**
 * A paste into a one-line field, as text. Line breaks become `lineBreak`;
 * whole escape sequences drop (CSI, OSC and the other string sequences, in
 * their 7-bit and 8-bit forms), and so does every other C0 or C1 control. A
 * pasted colour code never reaches a key or a question as residue.
 */
export const pastedLine = (text: string, lineBreak: string): string => {
  const chars = [...text]
  let line = ""
  let index = 0
  while (index < chars.length) {
    const [next, added] = pasteStep(chars, index, lineBreak)
    line += added
    index = next
  }
  return line
}
