/** @jsxImportSource @opentui/solid */

import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { OptionList } from "./option-list"
import { Effect, Option, Schema } from "effect"
import { createEffect, createSignal, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useEnv } from "../../env/context"
import { useRuntime } from "../../hooks/use-runtime"
import { useTheme } from "../../theme/index"
import { openExternalEditor, resolveEditor } from "../../utils/external-editor"

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
  const renderer = useRenderer()
  const env = useEnv()
  const runtime = useRuntime()
  const { theme } = useTheme()
  const [editing, setEditing] = createSignal(false)
  const [editorError, setEditorError] = createSignal("")
  const meta = () => parseMetadata(props.event.metadata)
  const mode = () => meta()?.mode ?? "confirm"
  const title = () => meta()?.title

  createEffect(() => {
    if (!editing()) return
    runtime.call(
      openExternalEditor(
        props.event.text,
        () => renderer.suspend(),
        () => renderer.resume(),
        resolveEditor(env.visual, env.editor),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result._tag === "applied") {
              props.resolve({ approved: true, notes: "edit", editedContent: result.content })
            } else if (result._tag === "error") {
              setEditorError(result.message)
            }
            setEditing(false)
          }),
        ),
      ),
    )
  })

  const options = () => {
    if (mode() === "review") {
      return [{ label: "Yes" }, { label: "No" }, { label: "Edit" }]
    }
    return [{ label: "Yes" }, { label: "No" }]
  }

  return (
    <>
      <Show when={editorError().length > 0}>
        <text style={{ fg: theme.error }}>{editorError()}</text>
      </Show>
      <Show
        when={!editing()}
        fallback={<text style={{ fg: theme.textMuted }}>Opening editor…</text>}
      >
        <OptionList
          header={title() ?? "Prompt"}
          question={props.event.text}
          options={options()}
          onSubmit={(selections) => {
            const sel = Option.fromNullishOr(selections[0]).pipe(
              Option.map((value) => value.toLowerCase()),
              Option.getOrElse(() => "no"),
            )
            if (sel === "edit" && mode() === "review") {
              setEditorError("")
              setEditing(true)
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
      </Show>
    </>
  )
}
