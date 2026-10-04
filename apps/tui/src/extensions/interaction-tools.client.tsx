/** @jsxImportSource @opentui/solid */
import { DateTime, Effect, Option, Schema } from "effect"
import { createSignal, For, Show } from "solid-js"
import { ref } from "@gent/core/extensions/api"
import {
  ASK_USER_INTERACTION_TYPE,
  AskUserAnswers,
  AskUserMetadata,
  INTERACTION_TOOLS_EXTENSION_ID,
  type OpenQuestionType,
  QUESTION_ANSWER_TYPE,
  QuestionAnswerDetails,
  QuestionsRpc,
} from "@gent/extensions/client"
import {
  clientCommandContribution,
  ClientContext,
  clientContributions,
  CollapsedRow,
  defineClientExtension,
  formatDuration,
  HandoffRenderer,
  interactionRendererContribution,
  type InteractionRendererProps,
  keyHint,
  KeyHints,
  messageRendererContribution,
  OptionList,
  PickerFrame,
  PromptRenderer,
  type QueuedMessage,
  sessionQuery,
  textWidth,
  TrayFrame,
  truncate,
  useTerminalDimensions,
  useTheme,
  widgetContribution,
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

// ── background questions ────────────────────────────────────────────────────

/**
 * The questions an `ask_user_async` call left open. The model goes on while
 * they wait, so nothing here takes the focus: a tray line under the status
 * line names them, and `/answer` docks a pane under the composer that asks
 * them one at a time with the same option list and keys as `ask_user`. An
 * answer goes to the server, which sends it to the model as one user message.
 */

const QUESTION_GLYPH = "?"
const ANSWER_COMMAND = "/answer"
const ASSUMED = "assumed"

const labelOf = (question: OpenQuestionType): string => question.header ?? question.question

/** The parts joined by ` · `; past `width` the optional parts drop from the right, and a last one cuts to fit. */
const fitParts = (
  head: string,
  optional: ReadonlyArray<string>,
  tail: string,
  width: number,
): string => {
  const join = (parts: ReadonlyArray<string>) => [head, ...parts, tail].join(" · ")
  let kept = optional.length
  while (kept > 0 && textWidth(join(optional.slice(0, kept))) > width) kept -= 1
  if (kept > 0) return join(optional.slice(0, kept))
  // No optional part fits whole: the first is cut to the room left, if any is worth it.
  const room = width - textWidth(join([])) - 3
  return Option.match(
    Option.filter(Option.fromUndefinedOr(optional[0]), () => room >= 8),
    {
      onNone: () => join([]),
      onSome: (first) => join([truncate(first, room)]),
    },
  )
}

/**
 * The tray line after the glyph: the count, then the one question's label and
 * assumption, or every label; then the command that answers them.
 */
export const questionTrayLine = (
  questions: ReadonlyArray<OpenQuestionType>,
  width: number,
): string => {
  const only = Option.filter(Option.fromUndefinedOr(questions[0]), () => questions.length === 1)
  return Option.match(only, {
    onNone: () =>
      fitParts(
        `${questions.length} open questions`,
        [questions.map(labelOf).join(", ")],
        ANSWER_COMMAND,
        width,
      ),
    onSome: (question) =>
      fitParts(
        "1 open question",
        [labelOf(question), `assuming ${question.assume}`],
        ANSWER_COMMAND,
        width,
      ),
  })
}

export function QuestionTray(props: { readonly questions: () => ReadonlyArray<OpenQuestionType> }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  // The tray pads one column each side, and the glyph takes two.
  const width = () => Math.max(8, dimensions().width - 4)
  return (
    <Show when={props.questions().length > 0}>
      <TrayFrame>
        <text wrapMode="none">
          <span style={{ fg: theme.warning }}>{`${QUESTION_GLYPH} `}</span>
          <span style={{ fg: theme.textMuted }}>
            {questionTrayLine(props.questions(), width())}
          </span>
        </text>
      </TrayFrame>
    </Show>
  )
}

/**
 * The rows of a question: its options with the one the model assumed marked,
 * or the assumption as the first row when no option names it. The cursor
 * starts on the assumption, as the model's own pick.
 */
interface QuestionChoices {
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>
  /** The index of the assumption's row, where the cursor starts. */
  readonly assumed: number
}

export const questionChoices = (question: OpenQuestionType): QuestionChoices => {
  const options = question.options ?? []
  const assumed = options.findIndex((option) => option.label === question.assume)
  if (assumed < 0) {
    return { options: [{ label: question.assume, description: ASSUMED }, ...options], assumed: 0 }
  }
  return {
    options: options.map((option, index) => {
      if (index !== assumed) return option
      const description = Option.match(Option.fromUndefinedOr(option.description), {
        onNone: () => ASSUMED,
        onSome: (text) => `${ASSUMED} · ${text}`,
      })
      return { label: option.label, description }
    }),
    assumed,
  }
}

const formatAsked = (millis: number): string => {
  if (millis < 1000) return "asked just now"
  return `asked ${formatDuration(millis, "compact")} ago`
}

const DISMISS_ARMED = "ctrl+x again to dismiss this question"

/**
 * The `/answer` pane. It asks the oldest open question first. Enter answers
 * the question under the cursor (a choice, or the text typed on the free
 * row); ctrl+x arms a dismiss and a second ctrl+x dismisses; esc closes the
 * pane and the questions stay open. The composer keeps the focus: the list
 * reads its keys through the keyboard scope.
 */
export function QuestionPane(props: {
  readonly open: boolean
  readonly questions: () => ReadonlyArray<OpenQuestionType>
  readonly now: () => number
  readonly onAnswer: (question: OpenQuestionType, answer: string) => void
  readonly onDismiss: (question: OpenQuestionType) => void
  readonly onClose: () => void
}) {
  const current = () => Option.fromUndefinedOr(props.questions()[0])
  const title = (question: OpenQuestionType) =>
    [
      `Question 1/${props.questions().length}`,
      ...Option.toArray(Option.fromUndefinedOr(question.header)),
      formatAsked(props.now() - question.askedAt),
    ].join(" · ")
  return (
    <Show when={props.open && Option.getOrUndefined(current())}>
      {(question) => (
        // Keyed by the question: the next one starts on a fresh list, and an
        // armed dismiss lives in one question's subtree, so it never carries
        // over to the next question or past a close.
        <Show when={question().id} keyed>
          {(_id) => {
            const [armed, setArmed] = createSignal(false)
            const choices = questionChoices(question())
            return (
              <PickerFrame
                error={Option.none()}
                title={title(question())}
                keys={[
                  KeyHints.move,
                  KeyHints.submit,
                  keyHint("ctrl+x", "dismiss"),
                  KeyHints.close,
                ]}
                detail={Option.liftPredicate(DISMISS_ARMED, armed)}
              >
                <OptionList
                  question={question().question}
                  options={choices.options}
                  initialFocus={choices.assumed}
                  extraKeys={(event) => {
                    if (event.name === "escape" && armed()) {
                      setArmed(false)
                      return true
                    }
                    if (event.ctrl === true && event.name === "x") {
                      if (armed()) {
                        setArmed(false)
                        props.onDismiss(question())
                      } else {
                        setArmed(true)
                      }
                      return true
                    }
                    setArmed(false)
                    return false
                  }}
                  onSubmit={(selections) => props.onAnswer(question(), selections.join("; "))}
                  onCancel={props.onClose}
                />
              </PickerFrame>
            )
          }}
        </Show>
      )}
    </Show>
  )
}

// ── answer row ──

const decodeAnswerDetails = Schema.decodeUnknownOption(QuestionAnswerDetails)

const ANSWERED = "↳ answered · "
/** The fewest columns of the question an answered row keeps before it cuts the answer too. */
const QUESTION_MIN_COLUMNS = 12

/**
 * `↳ answered · <question> → <answer>` in one line of `width` columns: the
 * question is cut first, so the answer the user gave stays in view.
 */
export const answeredLabel = (question: string, answer: string, width: number): string => {
  const tail = ` → ${answer}`
  const room = width - textWidth(ANSWERED) - textWidth(tail)
  if (room >= QUESTION_MIN_COLUMNS) return `${ANSWERED}${truncate(question, room)}${tail}`
  return truncate(`${ANSWERED}${truncate(question, QUESTION_MIN_COLUMNS)}${tail}`, width)
}

/**
 * A waiting answer in the queue widget: `↳ answer · <question>`, the
 * questions it answers and not the answer text the model reads.
 */
const questionQueueLabel = (message: QueuedMessage): string =>
  Option.match(decodeAnswerDetails(message.details), {
    onNone: () => "↳ answer",
    onSome: ({ answers }) => {
      const questions = answers.map((entry) => entry.question)
      if (questions.length === 1) return `↳ answer · ${questions.join("")}`
      return [`↳ ${questions.length} answers`, ...questions].join(" · ")
    },
  })

/** One collapsed row per answer: the question and what the user said. */
export function QuestionAnswerRows(props: { readonly details: unknown }) {
  const dimensions = useTerminalDimensions()
  // The rail, its gap and the transcript's side margins.
  const width = () => Math.max(QUESTION_MIN_COLUMNS * 2, dimensions().width - 4)
  const rows = () =>
    Option.match(decodeAnswerDetails(props.details), {
      onNone: () => ["↳ answered a background question"],
      onSome: (details) =>
        details.answers.map((entry) => answeredLabel(entry.question, entry.answer, width())),
    })
  return <For each={rows()}>{(label) => <CollapsedRow label={label} />}</For>
}

// ── extension ───────────────────────────────────────────────────────────────

/** The questions pane's name in the host's one pane slot. */
const QUESTIONS_PANE = "questions.pane"

/** A finished `ask_user_async` call, an answer or a turn's end can change the open list. */
const refreshesQuestions = (event: { readonly _tag: string; readonly toolName?: string }) =>
  event._tag === "MessageReceived" ||
  event._tag === "TurnCompleted" ||
  (event._tag === "ToolCallSucceeded" && event.toolName === "ask_user_async")

/** The views of `@gent/interaction-tools`: its prompt, ask-user and handoff asks, and its background questions. */
export default defineClientExtension(INTERACTION_TOOLS_EXTENSION_ID, {
  setup: Effect.gen(function* () {
    const { transport, shell, lifecycle } = yield* ClientContext
    const none: ReadonlyArray<OpenQuestionType> = []
    const open = yield* sessionQuery({
      initial: none,
      follow: true,
      fetch: (session) =>
        transport
          .request(ref(QuestionsRpc.Open), {}, session)
          .pipe(Effect.map((result) => result.questions)),
    })
    lifecycle.addCleanup(
      transport.onSessionEvent((envelope) => {
        if (refreshesQuestions(envelope.event)) open.refresh()
      }),
    )
    // The server pulses the extension when an answer or a dismiss closes a question.
    lifecycle.addCleanup(
      transport.onExtensionStateChanged((pulse) => {
        if (pulse.extensionId === INTERACTION_TOOLS_EXTENSION_ID) open.refresh()
      }),
    )
    // A question sent from the pane leaves it at once, before the server's reply.
    const [sent, setSent] = createSignal<ReadonlySet<string>>(new Set())
    const questions = () => open.value().filter((question) => !sent().has(question.id))
    const paneOpen = () => shell.pane.isOpen(QUESTIONS_PANE)
    const close = (input: {
      readonly question: OpenQuestionType
      readonly answers: ReadonlyArray<{ readonly id: string; readonly answer: string }>
      readonly dismiss: ReadonlyArray<string>
    }) => {
      const session = transport.currentSession()
      setSent((ids) => new Set([...ids, input.question.id]))
      if (questions().length === 0) shell.pane.close(QUESTIONS_PANE)
      shell.cast(
        transport
          .request(
            ref(QuestionsRpc.Answer),
            { answers: input.answers, dismiss: input.dismiss },
            session,
          )
          .pipe(
            Effect.catch((failure) =>
              Effect.sync(() => {
                // The question is still open on the server: it comes back.
                setSent((ids) => new Set([...ids].filter((id) => id !== input.question.id)))
                shell.notify(`answer: not sent: ${failure.message}`)
              }),
            ),
            Effect.ensuring(Effect.sync(open.refresh)),
          ),
      )
    }
    const show = () => {
      if (questions().length === 0) {
        shell.notify("answer: no open questions on this branch")
        return
      }
      shell.pane.open(QUESTIONS_PANE)
      open.refresh()
    }
    const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())
    return clientContributions(
      interactionRendererContribution(PromptRenderer, "prompt"),
      interactionRendererContribution(AskUserRenderer, ASK_USER_INTERACTION_TYPE),
      interactionRendererContribution(HandoffRenderer, "handoff"),
      clientCommandContribution({
        id: "answer",
        title: "Answer questions",
        description: "Answer the questions the agent asked in the background",
        category: "Session",
        slash: "answer",
        onSelect: show,
        onSlash: show,
      }),
      messageRendererContribution(
        QUESTION_ANSWER_TYPE,
        (props) => <QuestionAnswerRows details={props.details} />,
        { queueLabel: questionQueueLabel },
      ),
      widgetContribution({
        id: "questions.tray",
        slot: "below-input",
        priority: 40,
        component: () => <QuestionTray questions={questions} />,
      }),
      widgetContribution({
        id: QUESTIONS_PANE,
        slot: "below-input",
        component: () => (
          <QuestionPane
            open={paneOpen()}
            questions={questions}
            now={nowMillis}
            onAnswer={(question, answer) =>
              close({ question, answers: [{ id: question.id, answer }], dismiss: [] })
            }
            onDismiss={(question) => close({ question, answers: [], dismiss: [question.id] })}
            onClose={() => shell.pane.close(QUESTIONS_PANE)}
          />
        ),
      }),
    )
  }),
})
