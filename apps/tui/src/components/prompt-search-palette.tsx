import { createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncate } from "../utils/truncate"
import { useScopedKeyboard } from "../keyboard/context"
import {
  getPromptSearchItems,
  type PromptSearchEvent,
  type PromptSearchState,
} from "./prompt-search-state"

export interface PromptSearchPaletteProps {
  state: PromptSearchState
  entries: readonly string[]
  onEvent: (event: PromptSearchEvent) => void
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = createMemo(() => getPromptSearchItems(props.state, props.entries))
  const selectedIndex = () => (props.state._tag === "open" ? props.state.selectedIndex : 0)
  const query = () => (props.state._tag === "open" ? props.state.query : "")

  useScrollSync(() => `prompt-search-${selectedIndex()}`, { getRef: () => scrollRef })

  useScopedKeyboard(
    (e) => {
      if (e.name === "escape") {
        props.onEvent({ _tag: "Cancel" })
        return true
      }

      if (e.name === "backspace") {
        props.onEvent({ _tag: "Backspace" })
        return true
      }

      if (e.name === "return" || e.name === "linefeed") {
        props.onEvent({ _tag: "Accept" })
        return true
      }

      const visible = items()

      if (visible.length > 0 && (e.name === "up" || (e.ctrl === true && e.name === "p"))) {
        props.onEvent({ _tag: "MoveUp" })
        return true
      }

      if (visible.length > 0 && (e.name === "down" || (e.ctrl === true && e.name === "n"))) {
        props.onEvent({ _tag: "MoveDown" })
        return true
      }

      if (
        e.sequence !== undefined &&
        e.sequence.length === 1 &&
        e.ctrl !== true &&
        e.meta !== true &&
        e.super !== true &&
        e.option !== true
      ) {
        const char = e.sequence
        if (char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126) {
          props.onEvent({ _tag: "TypeChar", char })
          return true
        }
      }
      return false
    },
    { when: () => props.state._tag === "open", capture: true },
  )

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
