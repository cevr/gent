import { Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme"
import { ChromePanel } from "./chrome-panel"
import { MessageId, type Message } from "@gent/core/protocol"
import { extractImages, extractText } from "@gent/sdk"
import { truncate } from "../utils"
import { SelectList, selectable, type SelectListRow } from "./select-list"

interface PickerItem {
  id: string
  label: string
}

interface MessagePickerProps {
  open: boolean
  messages: readonly Message[]
  onSelect: (messageId: MessageId) => void
  onClose: () => void
}

const buildItems = (messages: readonly Message[]): PickerItem[] =>
  messages.map((m) => {
    let rolePrefix = "A"
    if (m.role === "user") rolePrefix = "U"
    let labelContent = extractText(m.parts).replace(/\s+/g, " ")
    const images = extractImages(m.parts)
    if (labelContent.length === 0 && images.length > 0) {
      let imageCount = ""
      if (images.length > 1) imageCount = ` x${images.length}`
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

  const panelWidth = () => Math.min(70, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const rows = (): ReadonlyArray<SelectListRow<PickerItem>> =>
    buildItems(props.messages).map((item) =>
      selectable(item, (isSelected, id) => {
        const backgroundColor = () => {
          if (isSelected()) return theme.primary
          return "transparent"
        }
        const textColor = () => {
          if (isSelected()) return theme.selectedListItemText
          return theme.text
        }
        return (
          <box id={id} backgroundColor={backgroundColor()} paddingLeft={1}>
            <text
              style={{
                fg: textColor(),
              }}
            >
              {truncate(item.label, panelWidth() - 4)}
            </text>
          </box>
        )
      }),
    )

  return (
    <Show when={props.open}>
      <ChromePanel.Root
        title="Fork From Message"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <SelectList
          id="message-picker"
          open={props.open}
          rows={rows}
          // SAFETY: PickerItem.id originates from domain Message.id which is a MessageId
          onSelect={(item) => props.onSelect(MessageId.make(item.id))}
          onDismiss={props.onClose}
        />

        <ChromePanel.Footer>Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
