/**
 * Autocomplete popup — generic, contribution-driven.
 *
 * Extensions register prefixes and item sources via autocompleteItems.
 * The popup looks up contributions by the active prefix, fetches items
 * via createResource, and renders them uniformly.
 */

import { createSignal, createMemo, createResource, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useScopedKeyboard } from "../keyboard/context"
import { useExtensionUI } from "../extensions/context"
import type {
  AutocompleteContribution,
  AutocompleteItem,
} from "@gent/core/domain/extension-client.js"
import type { AutocompleteState } from "./composer-interaction-state"

export type { AutocompleteState }

export interface AutocompletePopupProps {
  state: AutocompleteState
  onSelect: (value: string) => void
  onClose: () => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const extensionUI = useExtensionUI()

  const [rawSelectedIndex, setSelectedIndex] = createSignal(0)

  let scrollRef: ScrollBoxRenderable | undefined = undefined

  // Find contributions matching the active prefix.
  // For "/" prefix, also synthesize a contribution from extension commands with .slash fields.
  const contributions = createMemo((): AutocompleteContribution[] => {
    const registered = extensionUI.autocompleteItems().filter((c) => c.prefix === props.state.type)
    if (props.state.type !== "/") return [...registered]

    // Synthesize slash command contribution from extension commands
    const slashContribution: AutocompleteContribution = {
      prefix: "/",
      title: "Commands",
      trigger: "start",
      items: (filter: string) => {
        const lowerFilter = filter.toLowerCase()
        const items: AutocompleteItem[] = []
        for (const c of extensionUI.commands()) {
          if (c.slash === undefined) continue
          if (
            c.slash.toLowerCase().includes(lowerFilter) ||
            c.title.toLowerCase().includes(lowerFilter)
          ) {
            items.push({
              id: c.slash,
              label: `/${c.slash}`,
              description: c.description ?? c.title,
            })
          }
        }
        return items
      },
    }
    return [...registered, slashContribution]
  })

  // Fetch items from all contributions for this prefix, keyed on [prefix, filter]
  const [items] = createResource(
    () => [props.state.type, props.state.filter] as const,
    async ([_prefix, filter]): Promise<AutocompleteItem[]> => {
      const results = await Promise.all(
        contributions().map((c) => Promise.resolve(c.items(filter))),
      )
      // Dedupe by id, first-win (scope-ordered from resolve)
      const seen = new Set<string>()
      const deduped: AutocompleteItem[] = []
      for (const batch of results) {
        for (const item of batch) {
          if (!seen.has(item.id)) {
            seen.add(item.id)
            deduped.push(item)
          }
        }
      }
      return deduped
    },
  )

  // Clamp index reactively
  const selectedIndex = createMemo(() => {
    const list = items() ?? []
    const idx = rawSelectedIndex()
    return idx >= list.length ? Math.max(0, list.length - 1) : idx
  })

  useScrollSync(() => `ac-item-${selectedIndex()}`, { getRef: () => scrollRef })

  // Handle keyboard navigation
  useScopedKeyboard((e) => {
    const list = items() ?? []
    if (list.length === 0) return false

    if (e.name === "escape") {
      props.onClose()
      return true
    }

    if (e.name === "return" || e.name === "tab") {
      const item = list[selectedIndex()]
      if (item !== undefined) {
        props.onSelect(item.id)
      }
      return true
    }

    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : list.length - 1))
      return true
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((i) => (i < list.length - 1 ? i + 1 : 0))
      return true
    }
    return false
  })

  const dimensions = useTerminalDimensions()

  // Content-driven height with floor/cap
  const popupHeight = () => {
    const list = items() ?? []
    const contentH = list.length + 3 // items + header + filter hint + footer
    return Math.min(14, Math.max(5, contentH))
  }

  const popupWidth = () => Math.min(60, dimensions().width - 2)
  const popupLeft = () => Math.floor((dimensions().width - popupWidth()) / 2)

  // Title from the first matching contribution
  const title = () => contributions()[0]?.title ?? props.state.type

  return (
    <Show when={(items() ?? []).length > 0}>
      <ChromePanel.Root
        title={title()}
        width={popupWidth()}
        height={popupHeight()}
        left={popupLeft()}
        bottom={3}
      >
        {/* Filter display */}
        <Show when={props.state.filter.length > 0}>
          <ChromePanel.Section>
            <text style={{ fg: theme.textMuted }}>
              › <span style={{ fg: theme.text }}>{props.state.filter}</span>
            </text>
          </ChromePanel.Section>
        </Show>

        {/* Items */}
        <ChromePanel.Body ref={scrollRef} paddingLeft={0} paddingRight={0}>
          <For each={items() ?? []}>
            {(item, index) => {
              const isSelected = () => selectedIndex() === index()
              return (
                <box
                  id={`ac-item-${index()}`}
                  backgroundColor={isSelected() ? theme.primary : "transparent"}
                  paddingLeft={1}
                >
                  <text
                    style={{
                      fg: isSelected() ? theme.selectedListItemText : theme.text,
                    }}
                  >
                    {item.label}
                    <Show when={item.description !== undefined}>
                      <span
                        style={{
                          fg: isSelected() ? theme.selectedListItemText : theme.textMuted,
                          dim: !isSelected(),
                        }}
                      >
                        {"  "}
                        {item.description}
                      </span>
                    </Show>
                  </text>
                </box>
              )
            }}
          </For>
        </ChromePanel.Body>

        <ChromePanel.Footer>↑↓ navigate · enter select · esc close</ChromePanel.Footer>
      </ChromePanel.Root>
    </Show>
  )
}
