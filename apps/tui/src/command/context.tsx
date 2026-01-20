import { createContext, useContext, createSignal, type Accessor, type JSX } from "solid-js"
import type { Command } from "./types.js"
import { parseKeybind, matchKeybind } from "./types.js"

interface CommandContextValue {
  commands: Accessor<Command[]>
  register: (commands: Command[]) => () => void
  trigger: (id: string) => void
  handleKeybind: (event: {
    name: string
    ctrl?: boolean
    shift?: boolean
    meta?: boolean
  }) => boolean
  paletteOpen: Accessor<boolean>
  openPalette: () => void
  closePalette: () => void
}

const CommandContext = createContext<CommandContextValue>()

export function useCommand(): CommandContextValue {
  const ctx = useContext(CommandContext)
  if (!ctx) throw new Error("useCommand must be used within CommandProvider")
  return ctx
}

interface CommandProviderProps {
  children: JSX.Element
}

export function CommandProvider(props: CommandProviderProps) {
  const [registrations, setRegistrations] = createSignal<Command[][]>([])
  const [paletteOpen, setPaletteOpen] = createSignal(false)

  const commands = () => {
    const seen = new Set<string>()
    const all: Command[] = []
    for (const reg of registrations()) {
      for (const cmd of reg) {
        if (seen.has(cmd.id)) continue
        seen.add(cmd.id)
        all.push(cmd)
      }
    }
    return all
  }

  const register = (cmds: Command[]) => {
    setRegistrations((arr) => [...arr, cmds])
    return () => {
      setRegistrations((arr) => arr.filter((x) => x !== cmds))
    }
  }

  const trigger = (id: string) => {
    const cmd = commands().find((c) => c.id === id)
    cmd?.onSelect()
  }

  const handleKeybind = (event: {
    name: string
    ctrl?: boolean
    shift?: boolean
    meta?: boolean
  }): boolean => {
    // Check for palette keybind (Ctrl+P)
    if (event.ctrl && event.name === "p" && !event.shift && !event.meta) {
      setPaletteOpen(true)
      return true
    }

    // Don't process keybinds when palette is open
    if (paletteOpen()) return false

    for (const cmd of commands()) {
      if (!cmd.keybind) continue
      const kb = parseKeybind(cmd.keybind)
      if (kb && matchKeybind(kb, event)) {
        cmd.onSelect()
        return true
      }
    }
    return false
  }

  const value: CommandContextValue = {
    commands,
    register,
    trigger,
    handleKeybind,
    paletteOpen,
    openPalette: () => setPaletteOpen(true),
    closePalette: () => setPaletteOpen(false),
  }

  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>
}
