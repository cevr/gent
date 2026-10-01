/** @jsxImportSource @opentui/solid */
import { Effect, Option, Schema } from "effect"
import { createSignal, Show } from "solid-js"
import { ASK_USER_INTERACTION_TYPE, AskUserAnswers, AskUserMetadata } from "@gent/extensions/client"
import {
  clientContributions,
  defineClientExtension,
  HandoffRenderer,
  interactionRendererContribution,
  type InteractionRendererProps,
  OptionList,
  PromptRenderer,
  yesNoAnswer,
} from "@gent/tui/extensions"

// ── ask user renderer ───────────────────────────────────────────────────────

/**
 * The questions of an `ask_user` call, one at a time. The answer is one array
 * of picks per question, in the notes the tool decodes. An interaction whose
 * metadata is not the extension's ask-user shape is a plain yes/no question.
 */

const decodeAskUserMetadata = Schema.decodeUnknownOption(AskUserMetadata)
const encodeAnswers = Schema.encodeSync(AskUserAnswers)

export function AskUserRenderer(props: InteractionRendererProps) {
  const meta = () => decodeAskUserMetadata(props.event.metadata)
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
      return
    }
    props.resolve({ approved: true, notes: encodeAnswers(nextAnswers) })
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
          onSubmit={(selections) => props.resolve(yesNoAnswer(selections, ["yes", "no"]))}
          onCancel={() => props.resolve({ approved: false })}
        />
      }
    >
      {(q) => (
        <OptionList
          header={q.header}
          question={q.question}
          markdown={q.markdown}
          options={q.options}
          multiple={q.multiple}
          progress={Option.getOrUndefined(progress())}
          onSubmit={handleSubmit}
          onCancel={() => props.resolve({ approved: false })}
        />
      )}
    </Show>
  )
}

// ── extension ───────────────────────────────────────────────────────────────

/** The views of `@gent/interaction-tools`: its prompt, ask-user and handoff asks. */
export default defineClientExtension("@gent/interaction-tools", {
  setup: Effect.succeed(
    clientContributions(
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, ASK_USER_INTERACTION_TYPE),
      interactionRendererContribution(HandoffRenderer, "handoff"),
    ),
  ),
})
