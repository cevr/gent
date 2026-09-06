import { createEffect, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import type { Message } from "./message-list"
import { MessageId } from "@gent/core-internal/domain/ids.js"
import { truncate } from "../utils/format-tool"
import { useScopedKeyboard } from "../keyboard/context"
import { Option } from "effect"

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
    let rolePrefix = "A"
    if (m.role === "user") rolePrefix = "U"
    let labelContent = m.content.replace(/\s+/g, " ")
    if (labelContent.length === 0 && m.images.length > 0) {
      let imageCount = ""
      if (m.images.length > 1) imageCount = ` x${m.images.length}`
      labelContent = `[Image${imageCount}]`
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
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const items = () => buildItems(props.messages)

  useScrollSync(() => `message-picker-${selectedIndex()}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

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
        const item = Option.fromNullishOr(list[selectedIndex()])
        // SAFETY: PickerItem.id originates from domain Message.id which is a MessageId
        if (Option.isSome(item)) props.onSelect(MessageId.make(item.value.id))
        return true
      }

      if (e.name === "up") {
        setSelectedIndex((i) => {
          if (i > 0) return i - 1
          return list.length - 1
        })
        return true
      }

      if (e.name === "down") {
        setSelectedIndex((i) => {
          if (i < list.length - 1) return i + 1
          return 0
        })
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
        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
          <For each={items()}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              const backgroundColor = () => {
                if (isSelected()) return theme.primary
                return "transparent"
              }
              const textColor = () => {
                if (isSelected()) return theme.selectedListItemText
                return theme.text
              }
              return (
                <box
                  id={`message-picker-${index()}`}
                  backgroundColor={backgroundColor()}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: textColor(),
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
