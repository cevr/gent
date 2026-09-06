/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { OptionList } from "./option-list"
import { Option, Schema } from "effect"

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("prompt"),
    mode: Schema.optional(Schema.Literals(["present", "confirm", "review"])),
    title: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
)

type InteractionMetadata = InteractionRendererProps["event"]["metadata"]
const parseMetadata = (metadata: InteractionMetadata) =>
  Option.getOrUndefined(decodeMetadata(metadata))

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
        const sel = Option.fromNullishOr(selections[0]).pipe(
          Option.map((value) => value.toLowerCase()),
          Option.getOrElse(() => "no"),
        )
        if (sel === "edit") {
          props.resolve({ approved: true, notes: "edit" })
          return
        }
        const freeform = Option.fromNullishOr(
          selections.find((value) => !["yes", "no", "edit"].includes(value.toLowerCase())),
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
