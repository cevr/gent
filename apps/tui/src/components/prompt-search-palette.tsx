import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { usePromptHistory } from "../hooks/use-prompt-history"
import { truncate } from "../utils/truncate"

const fuzzyMatch = (text: string, query: string): boolean => {
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  let j = 0
  for (let i = 0; i < lower.length && j < q.length; i++) {
    if (lower[i] === q[j]) j++
  }
  return j === q.length
}

export interface PromptSearchPaletteProps {
  open: boolean
  onPreview: (prompt: string | undefined) => void
  onAccept: () => void
  onClose: () => void
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const history = usePromptHistory()
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [query, setQuery] = createSignal("")
  let scrollRef: ScrollBoxRenderable | undefined = undefined

  const items = createMemo(() => {
    const currentQuery = query().trim()
    const entries = history.entries()
    if (currentQuery.length === 0) return entries
    return entries.filter((entry) => fuzzyMatch(entry, currentQuery))
  })

  const selectedPrompt = createMemo(() => {
    const visible = items()
    if (visible.length === 0) return undefined
    const index = Math.min(selectedIndex(), visible.length - 1)
    return visible[index]
  })

  useScrollSync(() => `prompt-search-${selectedIndex()}`, { getRef: () => scrollRef })

  createEffect(() => {
    if (!props.open) return
    setSelectedIndex(0)
    setQuery("")
  })

  createEffect(() => {
    const visible = items()
    if (visible.length === 0) {
      setSelectedIndex(0)
      props.onPreview(undefined)
      return
    }

    const nextIndex = Math.min(selectedIndex(), visible.length - 1)
    if (nextIndex !== selectedIndex()) {
      setSelectedIndex(nextIndex)
      return
    }

    props.onPreview(visible[nextIndex])
  })

  useKeyboard((e) => {
    if (!props.open) return

    if (e.name === "escape") {
      props.onClose()
      return
    }

    if (e.name === "backspace") {
      setQuery((current) => current.slice(0, -1))
      setSelectedIndex(0)
      return
    }

    if (e.name === "return") {
      if (selectedPrompt() !== undefined) {
        props.onAccept()
      }
      return
    }

    const visible = items()

    if (visible.length > 0 && (e.name === "up" || (e.ctrl === true && e.name === "p"))) {
      setSelectedIndex((index) => (index > 0 ? index - 1 : visible.length - 1))
      return
    }

    if (visible.length > 0 && (e.name === "down" || (e.ctrl === true && e.name === "n"))) {
      setSelectedIndex((index) => (index < visible.length - 1 ? index + 1 : 0))
      return
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
        setQuery((current) => current + char)
        setSelectedIndex(0)
      }
    }
  })

  const panelWidth = () => Math.min(80, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  return (
    <Show when={props.open}>
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
