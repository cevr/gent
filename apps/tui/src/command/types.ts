export interface Command {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  onSelect: () => void
}

export interface Keybind {
  key: string
  ctrl: boolean
  shift: boolean
  meta: boolean
}

export function parseKeybind(config: string): Keybind | null {
  if (config.length === 0) return null

  const parts = config.toLowerCase().split("+")
  const keybind: Keybind = {
    key: "",
    ctrl: false,
    shift: false,
    meta: false,
  }

  for (const part of parts) {
    switch (part) {
      case "ctrl":
      case "control":
        keybind.ctrl = true
        break
      case "shift":
        keybind.shift = true
        break
      case "meta":
      case "cmd":
      case "command":
        keybind.meta = true
        break
      default:
        keybind.key = part
        break
    }
  }

  return keybind
}

export function matchKeybind(
  keybind: Keybind,
  event: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean },
): boolean {
  return (
    keybind.key === event.name.toLowerCase() &&
    keybind.ctrl === (event.ctrl ?? false) &&
    keybind.shift === (event.shift ?? false) &&
    keybind.meta === (event.meta ?? false)
  )
}

export function formatKeybind(config: string): string {
  const kb = parseKeybind(config)
  if (kb === null) return ""

  const parts: string[] = []
  if (kb.ctrl) parts.push("Ctrl")
  if (kb.shift) parts.push("Shift")
  if (kb.meta) parts.push("Cmd")
  if (kb.key.length > 0) parts.push(kb.key.toUpperCase())

  return parts.join("+")
}
