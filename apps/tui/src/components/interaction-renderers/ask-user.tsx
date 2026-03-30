/** @jsxImportSource @opentui/solid */

import { createSignal, Show } from "solid-js"
import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import { OptionList } from "./option-list"

export function AskUserRenderer(props: InteractionRendererProps<"QuestionsAsked">) {
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [accumulatedAnswers, setAccumulatedAnswers] = createSignal<readonly (readonly string[])[]>(
    [],
  )

  const questions = () => props.event.questions
  const current = () => questions()[questionIndex()]
  const total = () => questions().length

  const handleSubmit = (selections: readonly string[]) => {
    const nextAnswers = [...accumulatedAnswers(), selections]
    const nextIndex = questionIndex() + 1

    if (nextIndex >= total()) {
      props.resolve({ _tag: "answered", answers: nextAnswers })
    } else {
      setAccumulatedAnswers(nextAnswers)
      setQuestionIndex(nextIndex)
    }
  }

  // Key on questionIndex to force OptionList remount (resets selected/freeform/focus)
  return (
    <Show when={current()} keyed>
      {(q) => (
        <OptionList
          header={q.header}
          question={q.question}
          markdown={q.markdown}
          options={q.options}
          multiple={q.multiple}
          progress={total() > 1 ? `(${questionIndex() + 1}/${total()})` : undefined}
          onSubmit={handleSubmit}
          onCancel={() => props.resolve({ _tag: "cancelled" })}
        />
      )}
    </Show>
  )
}
