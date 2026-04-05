/** @jsxImportSource @opentui/solid */

import { createSignal, Show } from "solid-js"
import type { InteractionRendererProps } from "@gent/core/domain/extension-client.js"
import type { Question } from "@gent/core/domain/event.js"
import { OptionList } from "./option-list"

interface AskUserMetadata {
  type: "ask-user"
  questions: ReadonlyArray<Question>
}

const parseMetadata = (metadata: unknown): AskUserMetadata | undefined => {
  if (metadata === null || metadata === undefined || typeof metadata !== "object") return undefined
  const m = metadata as Record<string, unknown>
  if (m["type"] !== "ask-user" || !Array.isArray(m["questions"])) return undefined
  return m as unknown as AskUserMetadata
}

export function AskUserRenderer(props: InteractionRendererProps) {
  const meta = () => parseMetadata(props.event.metadata)
  const questions = () => meta()?.questions ?? []
  const [questionIndex, setQuestionIndex] = createSignal(0)
  const [answers, setAnswers] = createSignal<string[][]>([])

  const currentQuestion = () => questions()[questionIndex()]

  const handleSubmit = (selections: readonly string[]) => {
    const nextAnswers = [...answers(), [...selections]]
    setAnswers(nextAnswers)

    if (questionIndex() < questions().length - 1) {
      setQuestionIndex((i) => i + 1)
    } else {
      // All questions answered — encode as JSON for structured roundtrip
      props.resolve({ approved: true, notes: JSON.stringify(nextAnswers) })
    }
  }

  return (
    <Show
      when={currentQuestion()}
      keyed
      fallback={
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
      }
    >
      {(q) => (
        <OptionList
          header={q.header}
          question={q.question}
          markdown={q.markdown}
          options={q.options ? [...q.options] : undefined}
          multiple={q.multiple}
          progress={
            questions().length > 1 ? `(${questionIndex() + 1}/${questions().length})` : undefined
          }
          onSubmit={handleSubmit}
          onCancel={() => props.resolve({ approved: false })}
        />
      )}
    </Show>
  )
}
