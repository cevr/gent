/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

interface PromptMetadata {
  type: "prompt"
  mode?: "present" | "confirm" | "review"
  title?: string
  path?: string
}

const parseMetadata = (metadata: unknown): PromptMetadata | undefined => {
  if (metadata === null || metadata === undefined || typeof metadata !== "object") return undefined
  const m = metadata as Record<string, unknown>
  if (m["type"] !== "prompt") return undefined
  return m as unknown as PromptMetadata
}

export function PromptRenderer(props: InteractionRendererProps) {
  const meta = () => parseMetadata(props.event.metadata)
  const mode = () => meta()?.mode ?? "confirm"
  const title = () => meta()?.title

  const options = () => {
    if (mode() === "review") {
      return [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
    }
    return [{ label: "Yes" }, { label: "No" }]
  }

  return (
    <OptionList
      header={title() ?? "Prompt"}
      question={props.event.text}
      options={options()}
      onSubmit={(selections) => {
        const sel = selections[0]?.toLowerCase() ?? "no"
        if (sel === "edit") {
          props.resolve({ approved: true, notes: "edit" })
          return
        }
        const freeform = selections.find((s) => !["yes", "no", "edit"].includes(s.toLowerCase()))
        props.resolve({
          approved: sel === "yes",
          ...(freeform !== undefined ? { notes: freeform } : {}),
        })
      }}
      onCancel={() => props.resolve({ approved: false })}
    />
  )
}
