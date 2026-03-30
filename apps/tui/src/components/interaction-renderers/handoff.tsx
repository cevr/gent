/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

export function HandoffRenderer(props: InteractionRendererProps<"HandoffPresented">) {
  const reason =
    props.event.reason !== undefined && props.event.reason.length > 0
      ? ` (${props.event.reason})`
      : ""

  const summary =
    props.event.summary.length > 200
      ? props.event.summary.slice(0, 200) + "..."
      : props.event.summary

  return (
    <OptionList
      header="Handoff"
      question={`Handoff to new session?${reason}`}
      markdown={summary}
      options={[{ label: "Yes" }, { label: "No" }]}
      onSubmit={(selections) => {
        const sel = selections[0]?.toLowerCase() ?? "no"
        if (sel === "yes") return props.resolve({ _tag: "confirm" })
        const freeform = selections.find((s) => !["yes", "no"].includes(s.toLowerCase()))
        props.resolve({ _tag: "reject", ...(freeform !== undefined ? { reason: freeform } : {}) })
      }}
      onCancel={() => props.resolve({ _tag: "reject" })}
    />
  )
}
