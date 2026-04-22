/** @jsxImportSource @opentui/solid */

import { isRecord } from "@gent/core/domain/guards.js"
import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { OptionList } from "./option-list"

interface PromptMetadata {
  type: "prompt"
  mode?: "present" | "confirm" | "review"
  title?: string
  path?: string
}

const parseMetadata = (metadata: unknown): PromptMetadata | undefined => {
  if (!isRecord(metadata) || metadata["type"] !== "prompt") return undefined
  return {
    type: "prompt",
    mode:
      metadata["mode"] === "present" ||
      metadata["mode"] === "confirm" ||
      metadata["mode"] === "review"
        ? metadata["mode"]
        : undefined,
    title: typeof metadata["title"] === "string" ? metadata["title"] : undefined,
    path: typeof metadata["path"] === "string" ? metadata["path"] : undefined,
  }
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
