/** @jsxImportSource @opentui/solid */

import { createSignal, Show } from "solid-js"
import type { InteractionRendererProps } from "../../extensions/client-facets.js"
import { QuestionSchema } from "@gent/core-internal/domain/event.js"
import { OptionList } from "./option-list"
import { Option, Schema } from "effect"

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("ask-user"), questions: Schema.Array(QuestionSchema) }),
)
const encodeAnswers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
)

type InteractionMetadata = InteractionRendererProps["event"]["metadata"]
const parseMetadata = (metadata: InteractionMetadata) => decodeMetadata(metadata)

export function AskUserRenderer(props: InteractionRendererProps) {
  const meta = () => parseMetadata(props.event.metadata)
  const questions = () =>
    Option.getOrElse(
      Option.map(meta(), (metadata) => metadata.questions),
      () => [],
    )
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [answers, setAnswers] = createSignal<string[][]>([])

  const currentQuestion = () => Option.fromNullishOr(questions()[questionIndex()])

  const handleSubmit = (selections: readonly string[]) => {
    const nextAnswers = [...answers(), [...selections]]
    setAnswers(nextAnswers)

    if (questionIndex() < questions().length - 1) {
      setQuestionIndex((i) => i + 1)
    } else {
      // All questions answered — encode as JSON for structured roundtrip
      props.resolve({ approved: true, notes: encodeAnswers(nextAnswers) })
    }
  }

  const progress = () => {
    if (questions().length <= 1) return Option.none<string>()
    return Option.some(`(${questionIndex() + 1}/${questions().length})`)
  }

  return (
    <Show
      when={Option.getOrUndefined(currentQuestion())}
      keyed
      fallback={
        <OptionList
          header="Question"
          question={props.event.text}
          options={[{ label: "Yes" }, { label: "No" }]}
          onSubmit={(selections) => {
            const selection = Option.map(Option.fromNullishOr(selections[0]), (value) =>
              value.toLowerCase(),
            )
            const selected = Option.getOrElse(selection, () => "no")
            const freeform = Option.fromNullishOr(
              selections.find((value) => !["yes", "no"].includes(value.toLowerCase())),
            )
            if (Option.isSome(freeform)) {
              props.resolve({ approved: selected === "yes", notes: freeform.value })
              return
            }
            props.resolve({ approved: selected === "yes" })
          }}
          onCancel={() => props.resolve({ approved: false })}
        />
      }
    >
      {(q) => (
        <OptionList
          header={q.header}
          question={q.question}
          markdown={q.markdown}
          options={Option.getOrUndefined(
            Option.map(Option.fromNullishOr(q.options), (options) => [...options]),
          )}
          multiple={q.multiple}
          progress={Option.getOrUndefined(progress())}
          onSubmit={handleSubmit}
          onCancel={() => props.resolve({ approved: false })}
        />
      )}
    </Show>
  )
}
