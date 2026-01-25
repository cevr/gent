import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { Message } from "./message-list"

interface PickerItem {
  id: string
  label: string
}

export interface MessagePickerProps {
  open: boolean
  messages: readonly Message[]
  onSelect: (messageId: string) => void
  onClose: () => void
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value

const buildItems = (messages: readonly Message[]): PickerItem[] =>
  messages.map((m) => {
    const rolePrefix = m.role === "user" ? "U" : "A"
    let labelContent = m.content.replace(/\s+/g, " ")
    if (!labelContent && m.images.length > 0) {
      labelContent = `[Image${m.images.length > 1 ? ` x${m.images.length}` : ""}]`
    }
    return {
      id: m.id,
      label: `${rolePrefix}: ${labelContent}`,
    }
  })

export function MessagePicker(props: MessagePickerProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = () => buildItems(props.messages)

  useScrollSync(() => `message-picker-${selectedIndex()}`, { getRef: () => scrollRef })

  createEffect(() => {
    if (props.open) {
      setSelectedIndex(0)
    }
  })

  useKeyboard((e) => {
    if (!props.open) return

    if (e.name === "escape") {
      props.onClose()
      return
    }

    const list = items()
    if (list.length === 0) return

    if (e.name === "return") {
      const item = list[selectedIndex()]
      if (item) props.onSelect(item.id)
      return
    }

    if (e.name === "up") {
      setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
      return
    }

    if (e.name === "down") {
      setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
      return
    }
  })

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  return (
    <Show when={props.open}>
      {/* Overlay */}
      <box
        position="absolute"
        left={0}
        top={0}
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor="transparent"
      />

      {/* Panel */}
      <box
        position="absolute"
        left={left()}
        top={top()}
        width={panelWidth()}
        height={panelHeight()}
        backgroundColor={theme.backgroundMenu}
        border
        borderColor={theme.borderSubtle}
        flexDirection="column"
      >
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <text style={{ fg: theme.text }}>Fork From Message</text>
        </box>

        <box flexShrink={0}>
          <text style={{ fg: theme.textMuted }}>{"-".repeat(panelWidth() - 2)}</text>
        </box>

        <scrollbox ref={scrollRef} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              return (
                <box
                  id={`message-picker-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {truncate(item.label, panelWidth() - 4)}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>

        <box flexShrink={0} paddingLeft={1}>
          <text style={{ fg: theme.textMuted }}>Up/Down | Enter | Esc</text>
        </box>
      </box>
    </Show>
  )
}
