import { createSignal, createMemo, For, Show, onMount } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { InputRenderable } from "@opentui/core"
import { useCommand, formatKeybind, type Command } from "../command/index.js"
import { useTheme } from "../theme/index.js"

export function CommandPalette() {
  const command = useCommand()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const [filter, setFilter] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  let inputRef: InputRenderable | null = null

  const filtered = createMemo(() => {
    const query = filter().toLowerCase()
    const cmds = command.commands()
    if (!query) return cmds
    return cmds.filter(
      (cmd) =>
        cmd.title.toLowerCase().includes(query) ||
        cmd.description?.toLowerCase().includes(query) ||
        cmd.category?.toLowerCase().includes(query)
    )
  })

  // Group by category
  const grouped = createMemo(() => {
    const groups = new Map<string, Command[]>()
    for (const cmd of filtered()) {
      const cat = cmd.category ?? "Commands"
      const arr = groups.get(cat) ?? []
      arr.push(cmd)
      groups.set(cat, arr)
    }
    return Array.from(groups.entries())
  })

  // Flat list for keyboard navigation
  const flatList = createMemo(() => filtered())

  // Reset selection when filter changes
  const handleFilterChange = (value: string) => {
    setFilter(value)
    setSelectedIndex(0)
  }

  const handleSelect = () => {
    const items = flatList()
    const item = items[selectedIndex()]
    if (item) {
      command.closePalette()
      item.onSelect()
    }
  }

  useKeyboard((e) => {
    if (!command.paletteOpen()) return

    if (e.name === "escape") {
      command.closePalette()
      return
    }

    if (e.name === "return") {
      handleSelect()
      return
    }

    const items = flatList()
    if (e.name === "up" || (e.ctrl && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : items.length - 1))
      return
    }

    if (e.name === "down" || (e.ctrl && e.name === "n")) {
      setSelectedIndex((i) => (i < items.length - 1 ? i + 1 : 0))
      return
    }
  })

  onMount(() => {
    inputRef?.focus()
  })

  // Calculate palette dimensions
  const paletteWidth = () => Math.min(60, dimensions().width - 4)
  const paletteHeight = () => Math.min(15, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - paletteWidth()) / 2)
  const top = () => Math.floor((dimensions().height - paletteHeight()) / 2)

  return (
    <Show when={command.paletteOpen()}>
      {/* Overlay */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Palette */}
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={paletteWidth()}
        height={paletteHeight()}
        backgroundColor={theme.backgroundMenu}
        border
        borderColor={theme.borderSubtle}
        flexDirection="column"
      >
        {/* Search input */}
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>❯ </text>
          <input
            ref={(r) => {
              inputRef = r
              inputRef?.focus()
            }}
            focused
            onInput={handleFilterChange}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
          />
        </box>

        {/* Separator */}
        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"─".repeat(paletteWidth() - 2)}</text>
        </box>

        {/* Command list */}
        <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
          <Show when={flatList().length === 0}>
            <text style={{ fg: theme.textMuted }}>No commands found</text>
          </Show>
          <For each={grouped()}>
            {([category, cmds]) => (
              <box flexDirection="column">
                <text style={{ fg: theme.textMuted }}>{category}</text>
                <For each={cmds}>
                  {(cmd) => {
                    const isSelected = () => flatList()[selectedIndex()]?.id === cmd.id
                    return (
                      <box
                        backgroundColor={isSelected() ? theme.primary : "transparent"}
                        paddingLeft={1}
                      >
                        <text
                          style={{
                            fg: isSelected() ? theme.selectedListItemText : theme.text,
                          }}
                        >
                          {cmd.title}
                          <Show when={cmd.keybind}>
                            <span style={{ fg: isSelected() ? theme.selectedListItemText : theme.textMuted }}>
                              {" "}
                              {formatKeybind(cmd.keybind ?? "")}
                            </span>
                          </Show>
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </scrollbox>

        {/* Footer hint */}
        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>↑↓ navigate · Enter select · Esc close</text>
        </box>
      </box>
    </Show>
  )
}
