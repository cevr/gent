/**
 * ExtensionWidgets — renders resolved extension widgets for a given slot.
 */

import { For } from "solid-js"
import type { WidgetSlot } from "../extensions/client-facets.js"
import { useExtensionUI } from "../extensions/context"

export function ExtensionWidgets(props: { slot: WidgetSlot }) {
  const ext = useExtensionUI()
  const slotWidgets = () => ext.widgets().filter((w) => w.slot === props.slot)

  return (
    <For each={slotWidgets()}>
      {(widget) => {
        const Widget = widget.component
        return <Widget />
      }}
    </For>
  )
}
