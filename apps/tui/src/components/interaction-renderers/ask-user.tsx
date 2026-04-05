/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

export function AskUserRenderer(props: InteractionRendererProps) {
  return (
    <OptionList
      header="Question"
      question={props.event.text}
      options={[{ label: "Yes" }, { label: "No" }]}
      onSubmit={(selections) => {
        const sel = selections[0]?.toLowerCase() ?? "no"
        const freeform = selections.find((s) => !["yes", "no"].includes(s.toLowerCase()))
        props.resolve({
          approved: sel === "yes",
          ...(freeform !== undefined ? { notes: freeform } : {}),
        })
      }}
      onCancel={() => props.resolve({ approved: false })}
    />
  )
}
