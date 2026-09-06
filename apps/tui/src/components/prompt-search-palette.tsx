import { createMemo, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { truncate } from "../utils/format-tool"
import type { ScopedKeyboardEvent } from "../keyboard/context"
import { Option } from "effect"
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

// eslint-disable-next-line effect/noNullish -- keyboard events omit a sequence for control keys.
const isPromptSearchChar = (sequence: string | undefined) => {
  const value = Option.fromNullishOr(sequence)
  if (Option.isNone(value) || value.value.length !== 1) return false
  const code = value.value.charCodeAt(0)
  return code >= 32 && code <= 126
}

// eslint-disable-next-line effect/noNullish -- keyboard events omit a sequence and no event is a valid result.
export const promptSearchEventFromKey = (
  event: ScopedKeyboardEvent,
  hasItems: boolean,
): Option.Option<PromptSearchEvent> => {
  if (event.name === "escape") return Option.some(PromptSearchEvent.cases.Cancel.make({}))
  if (event.name === "backspace") return Option.some(PromptSearchEvent.cases.Backspace.make({}))
  if (event.name === "return" || event.name === "linefeed")
    return Option.some(PromptSearchEvent.cases.Accept.make({}))

  if (hasItems && (event.name === "up" || (event.ctrl === true && event.name === "p"))) {
    return Option.some(PromptSearchEvent.cases.MoveUp.make({}))
  }
  if (hasItems && (event.name === "down" || (event.ctrl === true && event.name === "n"))) {
    return Option.some(PromptSearchEvent.cases.MoveDown.make({}))
  }

  if (
    isPromptSearchChar(event.sequence) &&
    event.ctrl !== true &&
    event.meta !== true &&
    event.super !== true &&
    event.option !== true
  ) {
    return Option.some(PromptSearchEvent.cases.TypeChar.make({ char: event.sequence }))
  }

  return Option.none()
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scrollRef = Option.none<ScrollBoxRenderable>()

  const items = createMemo(() => getPromptSearchItems(props.state, props.entries))
  const selectedIndex = () => {
    if (props.state._tag === "open") return props.state.selectedIndex
    return 0
  }
  const query = () => {
    if (props.state._tag === "open") return props.state.query
    return ""
  }

  useScrollSync(() => `prompt-search-${selectedIndex()}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

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

        <ChromePanel.Body ref={(value) => (scrollRef = Option.some(value))}>
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
                const backgroundColor = () => {
                  if (selected()) return theme.primary
                  return "transparent"
                }
                const textColor = () => {
                  if (selected()) return theme.selectedListItemText
                  return theme.text
                }
                return (
                  <box
                    id={`prompt-search-${index()}`}
                    backgroundColor={backgroundColor()}
                    paddingLeft={1}
                  >
                    <text
                      style={{
                        fg: textColor(),
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
