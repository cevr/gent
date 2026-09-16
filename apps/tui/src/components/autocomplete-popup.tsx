/**
 * Autocomplete popup — generic, contribution-driven.
 *
 * Extensions register prefixes and item sources via autocompleteItems.
 * The popup looks up contributions by the active prefix, fetches items
 * via createResource, and renders them through the shared list.
 *
 * The popup sits under the composer and shares its keys with it: while it
 * has nothing to select, enter still sends the draft and the arrows still
 * move the caret. The list is open only while it has rows, which is what
 * binds and unbinds those keys; escape closes the popup either way.
 */

import { createMemo, createResource, Show } from "solid-js"
import { useTerminalDimensions } from "../terminal-dimensions"
import { useTheme } from "../theme/index"
import { ChromePanel } from "./chrome-panel"
import { PickerFrame, pickerHeight } from "./picker-frame"
import { SelectList, selectable, type SelectListRow } from "./select-list"
import { truncate } from "../utils/truncate"
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
  /**
   * Enter on the selected row. A slash command name completed this way runs;
   * see the composer controller for why the two keys differ.
   */
  onSelect: (value: string) => void
  /** Tab on the selected row: completes the text and stops there. */
  onComplete: (value: string) => void
  onClose: () => void
}

export function AutocompletePopup(props: AutocompletePopupProps) {
  const { theme } = useTheme()
  const extensionUI = useExtensionUI()
  const { log } = useClient()

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
    ([_prefix, filter]): Promise<AutocompleteItem[]> =>
      runAutocompleteContributions(
        contributions(),
        filter,
        extensionUI.clientRuntime,
        (prefix, reason) => {
          log.error("autocomplete.contribution.failed", { prefix, error: reason })
        },
      ),
  )

  // Use .latest for stale-while-revalidate: keeps showing previous results
  // during refetch instead of flashing "Loading..."
  const visibleItems = () => Option.getOrElse(Option.fromNullishOr(items.latest), () => [])
  const hasItems = () => visibleItems().length > 0

  // The list binds escape only while it has rows; the popup closes on it always.
  useScopedKeyboard((e) => {
    if (e.name !== "escape") return false
    props.onClose()
    return true
  })

  const dimensions = useTerminalDimensions()

  const popupHeight = () => pickerHeight(visibleItems().length, dimensions().height)

  // Title from the first matching contribution
  const title = () =>
    Option.getOrElse(Option.fromNullishOr(contributions()[0]), () => ({ title: props.state.type }))
      .title

  const loading = () => items.loading && !hasItems()
  const labelWidth = () => Math.max(8, Math.min(24, Math.floor(dimensions().width * 0.28)))

  const footerHint = () => {
    if (dimensions().width < 44) return "↑↓ Move · ↵ Run · ⇥ Complete · Esc"
    return "↑↓ Navigate   Enter Run   Tab Complete   Esc Close"
  }

  const rows = (): ReadonlyArray<SelectListRow<AutocompleteItem>> =>
    visibleItems().map((item) =>
      selectable(item, (isSelected, id) => {
        const textColor = () => {
          if (isSelected()) return theme.primary
          return theme.text
        }
        const descriptionColor = () => {
          if (isSelected()) return theme.primary
          return theme.textMuted
        }
        const description = () => Option.fromNullishOr(item.description)
        return (
          <box id={id} paddingLeft={1} flexDirection="row" height={1} gap={2}>
            <text
              width={labelWidth() - 2}
              flexShrink={0}
              wrapMode="none"
              truncate
              style={{
                fg: textColor(),
              }}
            >
              <span style={{ bold: isSelected() }}>{truncate(item.label, labelWidth() - 2)}</span>
            </text>
            <text flexGrow={1} wrapMode="none" truncate style={{ fg: descriptionColor() }}>
              {/* Optional description is supplied by the external extension contribution. */}
              <Show when={Option.getOrUndefined(description())}>
                {(text) => (
                  <span
                    style={{
                      fg: descriptionColor(),
                      dim: !isSelected(),
                    }}
                  >
                    {truncate(text(), dimensions().width - labelWidth() - 2)}
                  </span>
                )}
              </Show>
            </text>
          </box>
        )
      }),
    )

  const emptyRow = () => {
    let label = "No matches"
    if (loading()) label = "Loading…"
    return (
      <box paddingLeft={1}>
        <text style={{ fg: theme.textMuted }}>{label}</text>
      </box>
    )
  }

  return (
    <PickerFrame height={popupHeight()} title={title()} footer={footerHint()}>
      {/* Filter display */}
      <ChromePanel.Section>
        <text style={{ fg: theme.textMuted }}>
          <Show when={props.state.filter.length > 0}>
            › <span style={{ fg: theme.text }}>{props.state.filter}</span>
          </Show>
        </text>
      </ChromePanel.Section>

      <SelectList
        id="autocomplete"
        open={hasItems()}
        rows={rows}
        sticky={() => Option.some(0)}
        empty={emptyRow}
        extraKeys={(event, selected) => {
          // Tab completes without running. The popup is the last place that
          // still knows which key arrived, so it is where the two intents part
          // company; downstream both look like "the reader chose this row".
          if (event.name !== "tab") return false
          Option.match(selected, {
            onNone: () => {},
            onSome: (item) => props.onComplete(item.id),
          })
          return true
        }}
        onSelect={(item) => props.onSelect(item.id)}
        onDismiss={props.onClose}
      />
    </PickerFrame>
  )
}
