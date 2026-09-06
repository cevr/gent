/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { Option } from "effect"
import { OptionList } from "./option-list"

export function HandoffRenderer(props: InteractionRendererProps) {
  return (
    <OptionList
      header="Handoff"
      question={props.event.text}
      options={[{ label: "Yes" }, { label: "No" }]}
      onSubmit={(selections) => {
        const sel = Option.fromNullishOr(selections[0]).pipe(
          Option.map((value) => value.toLowerCase()),
          Option.getOrElse(() => "no"),
        )
        const freeform = Option.fromNullishOr(
          selections.find((value) => !["yes", "no"].includes(value.toLowerCase())),
        )
        if (Option.isSome(freeform)) {
          props.resolve({ approved: sel === "yes", notes: freeform.value })
          return
        }
        props.resolve({ approved: sel === "yes" })
      }}
      onCancel={() => props.resolve({ approved: false })}
    />
  )
}
