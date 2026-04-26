import { createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncate } from "../utils/truncate"
import type { ScopedKeyboardEvent } from "../keyboard/context"
import {
  getPromptSearchItems,
  PromptSearchEvent,
  type PromptSearchState,
} from "./prompt-search-state"

export interface PromptSearchPaletteProps {
  state: PromptSearchState
  entries: readonly string[]
  onEvent: (event: PromptSearchEvent) => void
}

const isPromptSearchChar = (sequence: string | undefined) => {
  if (sequence === undefined || sequence.length !== 1) return false
  const code = sequence.charCodeAt(0)
  return code >= 32 && code <= 126
}

export const promptSearchEventFromKey = (
  event: ScopedKeyboardEvent,
  hasItems: boolean,
): PromptSearchEvent | undefined => {
  if (event.name === "escape") return PromptSearchEvent.Cancel.make({})
  if (event.name === "backspace") return PromptSearchEvent.Backspace.make({})
  if (event.name === "return" || event.name === "linefeed") return PromptSearchEvent.Accept.make({})

  if (hasItems && (event.name === "up" || (event.ctrl === true && event.name === "p"))) {
    return PromptSearchEvent.MoveUp.make({})
  }
  if (hasItems && (event.name === "down" || (event.ctrl === true && event.name === "n"))) {
    return PromptSearchEvent.MoveDown.make({})
  }

  if (
    isPromptSearchChar(event.sequence) &&
    event.ctrl !== true &&
    event.meta !== true &&
    event.super !== true &&
    event.option !== true
  ) {
    return PromptSearchEvent.TypeChar.make({ char: event.sequence })
  }

  return undefined
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = createMemo(() => getPromptSearchItems(props.state, props.entries))
  const selectedIndex = () => (props.state._tag === "open" ? props.state.selectedIndex : 0)
  const query = () => (props.state._tag === "open" ? props.state.query : "")

  useScrollSync(() => `prompt-search-${selectedIndex()}`, { getRef: () => scrollRef })

  const panelWidth = () => Math.min(80, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  return (
    <Show when={props.state._tag === "open"}>
      <ChromePanel.Root
        title="Prompt Search"
        width={panelWidth()}
        height={panelHeight()}
        left={left()}
        top={top()}
      >
        <ChromePanel.Section>
          <text style={{ fg: theme.text }}>
            <span style={{ fg: theme.textMuted }}>› </span>
            {query()}
            <span style={{ fg: theme.primary }}>│</span>
          </text>
        </ChromePanel.Section>

        <ChromePanel.Body ref={scrollRef}>
          <Show
            when={items().length > 0}
            fallback={
              <box paddingLeft={1}>
                <text style={{ fg: theme.textMuted }}>No prompt matches</text>
              </box>
            }
          >
            <For each={items()}>
              {(entry, index) => {
                const selected = () => selectedIndex() === index()
                return (
                  <box
                    id={`prompt-search-${index()}`}
                    backgroundColor={selected() ? theme.primary : "transparent"}
                    paddingLeft={1}
                  >
                    <text
                      style={{
                        fg: selected() ? theme.selectedListItemText : theme.text,
                      }}
                    >
                      {truncate(entry.replace(/\s+/g, " "), panelWidth() - 4)}
                    </text>
                  </box>
                )
              }}
            </For>
          </Show>
        </ChromePanel.Body>

        <ChromePanel.Footer>Type | Up/Down | Enter | Esc</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
