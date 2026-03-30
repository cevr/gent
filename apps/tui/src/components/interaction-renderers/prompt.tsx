/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

export function PromptRenderer(props: InteractionRendererProps<"PromptPresented">) {
  const title =
    props.event.title ?? (props.event.path !== undefined ? `Review: ${props.event.path}` : "Review")

  const options =
    props.event.mode === "review"
      ? [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
      : [{ label: "Yes" }, { label: "No" }]

  const markdown =
    props.event.content !== undefined && props.event.content.length > 0
      ? props.event.content
      : undefined

  return (
    <OptionList
      header="Prompt"
      question={title}
      markdown={markdown}
      options={options}
      onSubmit={(selections) => {
        const sel = selections[0]?.toLowerCase() ?? "no"
        if (sel === "yes") return props.resolve({ _tag: "yes" })
        if (sel === "edit") return props.resolve({ _tag: "edit" })
        const freeform = selections.find((s) => !["yes", "no", "edit"].includes(s.toLowerCase()))
        props.resolve({ _tag: "no", ...(freeform !== undefined ? { reason: freeform } : {}) })
      }}
      onCancel={() => props.resolve({ _tag: "no" })}
    />
  )
}
