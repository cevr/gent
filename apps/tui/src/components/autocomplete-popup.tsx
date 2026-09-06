/**
 * Autocomplete popup — generic, contribution-driven.
 *
 * Extensions register prefixes and item sources via autocompleteItems.
 * The popup looks up contributions by the active prefix, fetches items
 * via createResource, and renders them uniformly.
 */

import { createSignal, createMemo, createResource, For, Show } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { useScrollSync } from "../hooks/use-scroll-sync"
import { useScopedKeyboard } from "../keyboard/context"
import { useExtensionUI } from "../extensions/context"
import { useClient } from "../client/index"
import type { AutocompleteContribution, AutocompleteItem } from "../extensions/client-facets.js"
import type { AutocompleteState } from "./composer-interaction-state"
import { runAutocompleteContributions } from "./autocomplete-popup-boundary"
import { Option } from "effect"

export type { AutocompleteState }

export interface AutocompletePopupProps {
  state: AutocompleteState
  onSelect: (value: string) => void
  onClose: () => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const extensionUI = useExtensionUI()
  const { log } = useClient()

  const [rawSelectedIndex, setSelectedIndex] = createSignal(0)

  let scrollRef = Option.none<ScrollBoxRenderable>()

  // Find contributions matching the active prefix
  const contributions = createMemo((): AutocompleteContribution[] =>
    extensionUI.autocompleteItems().filter((c) => c.prefix === props.state.type),
  )

  // Autocomplete items return a sync array or an Effect (Promise variant deleted).
  // Effect is run through `runAutocompleteItems` (boundary helper) so the
  // result behaves identically to a sync resolution from the resource's POV.
  // Errors are normalized to an empty array per contribution and logged once.

  // Fetch items from all contributions for this prefix, keyed on [prefix, filter]
  const [items] = createResource(
    (): readonly [string, string] => [props.state.type, props.state.filter],
    ([_prefix, filter]): Promise<AutocompleteItem[]> => {
      setSelectedIndex(0)
      return runAutocompleteContributions(
        contributions(),
        filter,
        extensionUI.clientRuntime,
        (prefix, reason) => {
          log.error("autocomplete.contribution.failed", { prefix, error: reason })
        },
      )
    },
  )

  // Use .latest for stale-while-revalidate: keeps showing previous results
  // during refetch instead of flashing "Loading..."
  const visibleItems = () => Option.getOrElse(Option.fromNullishOr(items.latest), () => [])

  // Clamp index reactively
  const selectedIndex = createMemo(() => {
    const list = visibleItems()
    const idx = rawSelectedIndex()
    if (idx >= list.length) return Math.max(0, list.length - 1)
    return idx
  })

  useScrollSync(() => `ac-item-${selectedIndex()}`, {
    getRef: () => Option.getOrUndefined(scrollRef),
  })

  // Handle keyboard navigation
  useScopedKeyboard((e) => {
    const list = visibleItems()
    if (list.length === 0) return false

    if (e.name === "escape") {
      props.onClose()
      return true
    }

    if (e.name === "return" || e.name === "tab") {
      const item = Option.fromNullishOr(list[selectedIndex()])
      if (Option.isSome(item)) props.onSelect(item.value.id)
      return true
    }

    if (e.name === "up" || (e.ctrl === true && e.name === "p")) {
      setSelectedIndex((i) => {
        if (i > 0) return i - 1
        return list.length - 1
      })
      return true
    }

    if (e.name === "down" || (e.ctrl === true && e.name === "n")) {
      setSelectedIndex((i) => {
        if (i < list.length - 1) return i + 1
        return 0
      })
      return true
    }
    return false
  })

  const dimensions = useTerminalDimensions()

  const popupHeight = () => 14

  const popupWidth = () => Math.min(60, dimensions().width - 2)
  const popupLeft = () => Math.floor((dimensions().width - popupWidth()) / 2)

  // Title from the first matching contribution
  const title = () =>
    Option.getOrElse(Option.fromNullishOr(contributions()[0]), () => ({ title: props.state.type }))
      .title

  const loading = () => items.loading && visibleItems().length === 0
  const empty = () => !items.loading && visibleItems().length === 0

  return (
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

      {/* Items / Loading / Empty */}
      <ChromePanel.Body
        ref={(value) => (scrollRef = Option.some(value))}
        paddingLeft={0}
        paddingRight={0}
      >
        <Show when={loading()}>
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }}>Loading…</text>
          </box>
        </Show>
        <Show when={empty()}>
          <box paddingLeft={1}>
            <text style={{ fg: theme.textMuted }}>No matches</text>
          </box>
        </Show>
        <For each={visibleItems()}>
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
            const descriptionColor = () => {
              if (isSelected()) return theme.selectedListItemText
              return theme.textMuted
            }
            return (
              <box id={`ac-item-${index()}`} backgroundColor={backgroundColor()} paddingLeft={1}>
                <text
                  style={{
                    fg: textColor(),
                  }}
                >
                  {item.label}
                  {/* Optional description is supplied by the external extension contribution. */}
                  <Show when={Option.getOrUndefined(Option.fromNullishOr(item.description))}>
                    <span
                      style={{
                        fg: descriptionColor(),
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
  )
}
