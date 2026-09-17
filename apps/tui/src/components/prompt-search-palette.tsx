/** @jsxImportSource @opentui/solid */
/**
 * Prompt search palette — the `ctrl+r` list over prompt history.
 *
 * The list owns the query and the cursor and reports the entry under the
 * cursor; the palette turns those reports into the events the session's
 * prompt-search state understands. The composer previews the highlighted
 * entry, so the palette holds the first report back: the list opens on the
 * first entry, but the reader has not chosen it until they move or type.
 */

import { createMemo, createSignal, Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { ChromePanel } from "./chrome-panel"
import { useTheme } from "../theme/index"
import { truncate } from "../utils/truncate"
import { SelectList, selectable, type SelectListRow } from "./select-list"
import {
  filterPromptEntries,
  PromptSearchEvent,
  type PromptSearchState,
} from "./prompt-search-state"

interface PromptSearchPaletteProps {
  state: PromptSearchState
  entries: readonly string[]
  onEvent: (event: PromptSearchEvent) => void
}

export function PromptSearchPalette(props: PromptSearchPaletteProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const panelWidth = () => Math.min(80, dimensions().width - 6)
  const panelHeight = () => Math.min(16, dimensions().height - 6)
  const left = () => Math.floor((dimensions().width - panelWidth()) / 2)
  const top = () => Math.floor((dimensions().height - panelHeight()) / 2)

  const emptyRow = () => (
    <box paddingLeft={1}>
      <text style={{ fg: theme.textMuted }}>No prompt matches</text>
    </box>
  )

  return (
    <Show when={props.state._tag === "open"}>
      {(_open) => {
        // Per opening: the query and the touched flag start over each time.
        const [query, setQuery] = createSignal("")
        let touched = false
        const items = createMemo(() => filterPromptEntries(props.entries, query()))

        const rows = (): ReadonlyArray<SelectListRow<string>> =>
          items().map((entry) =>
            selectable(entry, (isSelected, id) => {
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
                  <text style={{ fg: textColor() }}>
                    {truncate(entry.replace(/\s+/g, " "), panelWidth() - 4)}
                  </text>
                </box>
              )
            }),
          )

        return (
          <ChromePanel.Root
            title="Prompt Search"
            width={panelWidth()}
            height={panelHeight()}
            left={left()}
            top={top()}
          >
            <SelectList
              id="prompt-search"
              open={true}
              rows={rows}
              filter={{ onQueryChange: setQuery }}
              empty={emptyRow}
              extraKeys={(event) => {
                // Enter accepts whatever the composer previews, an empty list
                // included; the list would swallow it with nothing selected.
                if (event.name === "return" || event.name === "linefeed") {
                  props.onEvent(PromptSearchEvent.cases.Accept.make({}))
                  return true
                }
                touched = true
                return false
              }}
              onCursor={(entry) => {
                if (!touched) return
                props.onEvent(PromptSearchEvent.cases.Highlight.make({ entry }))
              }}
              onSelect={() => props.onEvent(PromptSearchEvent.cases.Accept.make({}))}
              onDismiss={() => props.onEvent(PromptSearchEvent.cases.Cancel.make({}))}
            />

            <ChromePanel.Footer>Type | Up/Down | Enter | Esc</ChromePanel.Footer>
          </ChromePanel.Root>
        )
      }}
    </Show>
  )
}
