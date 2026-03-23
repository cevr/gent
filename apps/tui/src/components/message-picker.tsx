import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { Message } from "./message-list"
import type { MessageId } from "@gent/core/domain/ids.js"
import { truncate } from "../utils/truncate"
import { useScopedKeyboard } from "../keyboard/context"

interface PickerItem {
  id: string
  label: string
}

export interface MessagePickerProps {
  open: boolean
  messages: readonly Message[]
  onSelect: (messageId: MessageId) => void
  onClose: () => void
}

const buildItems = (messages: readonly Message[]): PickerItem[] =>
  messages.map((m) => {
    const rolePrefix = m.role === "user" ? "U" : "A"
    let labelContent = m.content.replace(/\s+/g, " ")
    if (labelContent.length === 0 && m.images.length > 0) {
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

  useScopedKeyboard(
    (e) => {
      if (e.name === "escape") {
        props.onClose()
        return true
      }

      const list = items()
      if (list.length === 0) return false

      if (e.name === "return") {
        const item = list[selectedIndex()]
        // SAFETY: PickerItem.id originates from MessageInfoReadonly.id which is a MessageId
        if (item !== undefined) props.onSelect(item.id as MessageId)
        return true
      }

      if (e.name === "up") {
        setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
        return true
      }

      if (e.name === "down") {
        setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
        return true
      }
      return false
    },
    { when: () => props.open },
  )

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title="Fork From Message"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Body ref={scrollRef}>
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
        </ChromePanel.Body>

        <ChromePanel.Footer>Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
