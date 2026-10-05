/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Option, Schema } from "effect"
import { createRoot, createSignal } from "solid-js"
import { type OpenQuestionType, QUESTION_ANSWER_TYPE } from "@gent/extensions/client"
import { MessageId } from "@gent/core/protocol"
import { QueueWidget } from "../../src/app"
import interactionToolsExtension, {
  answeredLabel,
  QuestionAnswerRows,
  QuestionPane,
  QuestionTray,
  questionChoices,
  questionTrayLine,
} from "../../src/extensions/interaction-tools.client"
import { createMockClient, renderFrame, renderScoped } from "../render-harness-boundary"
import { waitForFrame, waitUntil } from "../helpers-boundary"
import {
  makeClientExtensionRuntime,
  makeClientTestTransport,
  runClientExtensionSetup,
} from "../extension-test-harness-boundary"

// ── background questions ────────────────────────────────────────────────────

class RequestRefused extends Schema.TaggedError<RequestRefused>()("RequestRefused", {
  message: Schema.String,
}) {}

/**
 * The open `ask_user_async` questions: a tray line names them, and the
 * `/answer` pane asks them one at a time with the `ask_user` option list.
 */

const cache: OpenQuestionType = {
  id: "call-1:0",
  question: "Which cache backend do you want in production?",
  header: "cache",
  options: [
    { label: "in-memory LRU" },
    { label: "Redis", description: "shared across instances" },
    { label: "SQLite file", description: "survives a restart" },
  ],
  assume: "in-memory LRU",
  askedAt: 1_000_000,
}

const database: OpenQuestionType = {
  id: "call-2:0",
  question: "Which database should the tests use?",
  header: "db",
  assume: "SQLite in memory",
  askedAt: 1_060_000,
}

describe("questionTrayLine", () => {
  it.live("one question names its label and assumption, and drops the assumption first", () =>
    Effect.sync(() => {
      expect(questionTrayLine([cache], 116)).toBe(
        "1 open question · cache · assuming in-memory LRU · /answer",
      )
      expect(questionTrayLine([cache], 56)).toBe("1 open question · cache · /answer")
      // A question with no header shows its text, cut to the room left.
      const bare: OpenQuestionType = {
        id: cache.id,
        question: cache.question,
        assume: cache.assume,
        askedAt: cache.askedAt,
      }
      const line = questionTrayLine([bare], 40)
      expect(line.startsWith("1 open question · Which cache")).toBe(true)
      expect(line.endsWith("… · /answer")).toBe(true)
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40)
    }),
  )

  it.live("several questions name every label", () =>
    Effect.sync(() => {
      expect(questionTrayLine([cache, database], 116)).toBe(
        "2 open questions · cache, db · /answer",
      )
      expect(questionTrayLine([cache, database], 30)).toBe("2 open questions · /answer")
    }),
  )
})

describe("questionChoices", () => {
  it.live("the option the model assumed is marked and the cursor starts on it", () =>
    Effect.sync(() => {
      const choices = questionChoices({ ...cache, assume: "Redis" })
      expect(choices.assumed).toBe(1)
      expect(choices.options[1]).toEqual({
        label: "Redis",
        description: "assumed · shared across instances",
      })
      expect(choices.options).toHaveLength(3)
    }),
  )

  it.live("an assumption no option names is the first row", () =>
    Effect.sync(() => {
      const choices = questionChoices(database)
      expect(choices.assumed).toBe(0)
      expect(choices.options).toEqual([{ label: "SQLite in memory", description: "assumed" }])
    }),
  )
})

describe("QuestionTray", () => {
  it.scopedLive("shows the open questions at 120 and 60 columns and hides with none", () =>
    Effect.gen(function* () {
      const [questions, setQuestions] = createRoot(() =>
        createSignal<ReadonlyArray<OpenQuestionType>>([cache]),
      )
      const wide = yield* renderScoped(() => <QuestionTray questions={questions} />, {
        width: 120,
        height: 6,
      })
      yield* waitForFrame(wide, (frame) => frame.includes("/answer"), "the wide tray")
      expect(renderFrame(wide)).toContain(
        "? 1 open question · cache · assuming in-memory LRU · /answer",
      )
      const narrow = yield* renderScoped(() => <QuestionTray questions={questions} />, {
        width: 60,
        height: 6,
      })
      yield* waitForFrame(narrow, (frame) => frame.includes("/answer"), "the narrow tray")
      expect(renderFrame(narrow)).toContain("? 1 open question · cache · /answer")
      setQuestions([])
      yield* waitForFrame(wide, (frame) => !frame.includes("/answer"), "the tray hidden")
    }).pipe(Effect.timeout("6 seconds")),
  )
})

describe("QuestionPane", () => {
  const renderPane = Effect.gen(function* () {
    const answered: Array<string> = []
    const dismissed: Array<string> = []
    let closed = 0
    const [questions, setQuestions] = createRoot(() =>
      createSignal<ReadonlyArray<OpenQuestionType>>([cache, database]),
    )
    const [open, setOpen] = createRoot(() => createSignal(true))
    const setup = yield* renderScoped(
      () => (
        <QuestionPane
          open={open()}
          questions={questions}
          now={() => 1_120_000}
          onAnswer={(question, answer) => answered.push(`${question.id}=${answer}`)}
          onDismiss={(question) => dismissed.push(question.id)}
          onClose={() => (closed += 1)}
        />
      ),
      { width: 120, height: 40 },
    )
    yield* waitForFrame(setup, (frame) => frame.includes("Question 1/2"), "the pane")
    return { setup, answered, dismissed, closed: () => closed, setQuestions, setOpen }
  })

  it.scopedLive("enter answers with the assumed choice the cursor starts on", () =>
    Effect.gen(function* () {
      const { setup, answered } = yield* renderPane
      const frame = renderFrame(setup)
      expect(frame).toContain("Question 1/2 · cache · asked 2m 0s ago")
      expect(frame).toContain("> ( ) in-memory LRU - assumed")
      expect(frame).toContain("enter submit · ctrl+x dismiss · esc close")
      setup.mockInput.pressEnter()
      yield* waitUntil(() => answered.length === 1, "the answer")
      expect(answered).toEqual(["call-1:0=in-memory LRU"])
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("typed text from a choice row is the answer", () =>
    Effect.gen(function* () {
      const { setup, answered } = yield* renderPane
      yield* Effect.promise(() => setup.mockInput.typeText("Redis, we run it"))
      yield* waitForFrame(setup, (frame) => frame.includes("> Other: Redis, we run it"), "typed")
      setup.mockInput.pressEnter()
      yield* waitUntil(() => answered.length === 1, "the answer")
      expect(answered).toEqual(["call-1:0=Redis, we run it"])
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("ctrl+x arms, another key disarms, and a second ctrl+x dismisses", () =>
    Effect.gen(function* () {
      const { setup, dismissed, answered } = yield* renderPane
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to dismiss"), "armed")
      setup.mockInput.pressArrow("down")
      yield* waitForFrame(setup, (frame) => !frame.includes("ctrl+x again"), "disarmed")
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitUntil(() => dismissed.length === 1, "the dismiss")
      expect(dismissed).toEqual(["call-1:0"])
      expect(answered).toEqual([])
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive(
    "an armed dismiss stays with its question: a new question or a reopen starts unarmed",
    () =>
      Effect.gen(function* () {
        const { setup, dismissed, setQuestions, setOpen } = yield* renderPane
        setup.mockInput.pressKey("x", { ctrl: true })
        yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to dismiss"), "armed")
        // Another client answers the first question: the second takes the pane.
        setQuestions([database])
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("Question 1/1 · db"),
          "the next question",
        )
        expect(renderFrame(setup)).not.toContain("ctrl+x again")
        setup.mockInput.pressKey("x", { ctrl: true })
        yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to dismiss"), "re-armed")
        expect(dismissed).toEqual([])
        // A closed pane forgets the arm.
        setOpen(false)
        yield* waitForFrame(setup, (frame) => !frame.includes("Question 1/1"), "the pane closed")
        setOpen(true)
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("Question 1/1 · db"),
          "the pane reopened",
        )
        expect(renderFrame(setup)).not.toContain("ctrl+x again")
        setup.mockInput.pressKey("x", { ctrl: true })
        yield* waitForFrame(
          setup,
          (frame) => frame.includes("ctrl+x again to dismiss"),
          "armed again",
        )
        expect(dismissed).toEqual([])
      }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("esc closes the pane and answers nothing; esc while armed only disarms", () =>
    Effect.gen(function* () {
      const { setup, answered, dismissed, closed } = yield* renderPane
      setup.mockInput.pressKey("x", { ctrl: true })
      yield* waitForFrame(setup, (frame) => frame.includes("ctrl+x again to dismiss"), "armed")
      setup.mockInput.pressEscape()
      yield* waitForFrame(setup, (frame) => !frame.includes("ctrl+x again"), "disarmed")
      expect(closed()).toBe(0)
      setup.mockInput.pressEscape()
      yield* waitUntil(() => closed() === 1, "the close")
      expect(answered).toEqual([])
      expect(dismissed).toEqual([])
    }).pipe(Effect.timeout("6 seconds")),
  )

  it.scopedLive("the next question takes the pane once the first leaves the list", () =>
    Effect.gen(function* () {
      const { setup, setQuestions } = yield* renderPane
      yield* Effect.promise(() => setup.mockInput.typeText("draft"))
      setQuestions([database])
      const frame = yield* waitForFrame(setup, (f) => f.includes("Question 1/1 · db"), "next")
      expect(frame).toContain("> ( ) SQLite in memory - assumed")
      expect(frame).not.toContain("draft")
    }).pipe(Effect.timeout("6 seconds")),
  )
})

describe("answeredLabel", () => {
  it.live("a narrow row cuts the question first and keeps the answer", () =>
    Effect.sync(() => {
      expect(answeredLabel(cache.question, "Redis", 114)).toBe(
        `answered · ${cache.question} → Redis`,
      )
      const narrow = answeredLabel(cache.question, "Redis, we already run it", 54)
      expect(narrow).toBe("answered · Which cache bac… → Redis, we already run it")
      expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(54)
      // A long answer is cut too, past a short head of the question.
      const long = answeredLabel(cache.question, "x".repeat(80), 54)
      expect(long.startsWith("answered · Which cache…")).toBe(true)
      expect(Bun.stringWidth(long)).toBeLessThanOrEqual(54)
    }),
  )
})

describe("QuestionAnswerRows", () => {
  it.scopedLive("an answer message draws one collapsed row per answer", () =>
    Effect.gen(function* () {
      const setup = yield* renderScoped(
        () => (
          <QuestionAnswerRows
            details={{
              answers: [
                {
                  id: cache.id,
                  question: cache.question,
                  assume: cache.assume,
                  answer: "Redis",
                },
              ],
            }}
          />
        ),
        { width: 120, height: 6 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("answered"), "the row")
      expect(frame).toContain(`↳ answered · ${cache.question} → Redis`)
    }).pipe(Effect.timeout("6 seconds")),
  )
})

// ── extension wiring ────────────────────────────────────────────────────────

describe("a waiting answer in the queue", () => {
  it.scopedLive("shows as the question it answers, not as the answer text", () =>
    Effect.gen(function* () {
      const runtime = makeClientExtensionRuntime({
        transport: { ...makeClientTestTransport(), client: createMockClient() },
      })
      const contributions = yield* runClientExtensionSetup(runtime, interactionToolsExtension)
      const renderers = new Map(
        (contributions.messageRenderers ?? []).map((entry) => [entry.customType, entry]),
      )
      const content = "Answer to your background question (asked …):\nQ: …\nA: Redis"
      const setup = yield* renderScoped(
        () => (
          <QueueWidget
            steerMessages={[
              {
                _tag: "Steering",
                id: MessageId.make("answer-1"),
                content,
                createdAt: 0,
                // The reader's answer: only the reader's waiting messages draw.
                metadata: {
                  fromClient: true,
                  customType: QUESTION_ANSWER_TYPE,
                  details: {
                    answers: [
                      {
                        id: cache.id,
                        question: cache.question,
                        assume: cache.assume,
                        answer: "Redis",
                      },
                    ],
                  },
                },
              },
            ]}
            queuedMessages={[]}
            messageRenderers={renderers}
          />
        ),
        { width: 120, height: 6 },
      )
      const frame = yield* waitForFrame(setup, (f) => f.includes("┊ next step"), "the queue")
      expect(frame).toContain(`┊ next step · ↳ answer · ${cache.question}`)
      expect(frame).not.toContain("Answer to your background question")
      expect(frame).toContain("alt+up edit")
    }).pipe(Effect.timeout("6 seconds")),
  )
})

describe("/answer", () => {
  it.scopedLive("opens the pane, sends the answer, and brings a failed one back", () =>
    Effect.gen(function* () {
      const sent: Array<unknown> = []
      const notices: Array<string> = []
      let fail = true
      let open: ReadonlyArray<OpenQuestionType> = [cache]
      const client = createMockClient({
        extension: {
          request: (input: { capabilityId: string; input: unknown }) =>
            Effect.gen(function* () {
              if (input.capabilityId === "questions.open") return { questions: open }
              sent.push(input.input)
              if (fail) {
                fail = false
                return yield* new RequestRefused({ message: "offline" })
              }
              open = []
              return { answered: [cache.id], dismissed: [] }
            }),
        },
      })
      const runtime = makeClientExtensionRuntime({
        transport: { ...makeClientTestTransport(), client },
        shell: { notify: (message) => notices.push(message) },
      })
      const contributions = yield* runClientExtensionSetup(runtime, interactionToolsExtension)
      const answer = Option.getOrThrow(
        Option.fromUndefinedOr(contributions.commands?.find((command) => command.id === "answer")),
      )
      const widgets = contributions.widgets ?? []
      const setup = yield* renderScoped(
        () => <box flexDirection="column">{widgets.map((widget) => widget.component())}</box>,
        { width: 120, height: 30 },
      )
      yield* waitForFrame(setup, (frame) => frame.includes("1 open question"), "the tray")
      answer.onSelect()
      yield* waitForFrame(setup, (frame) => frame.includes("Question 1/1"), "the pane")
      setup.mockInput.pressEnter()
      // The send fails: the question comes back, and the reader is told.
      yield* waitUntil(() => notices.length === 1, "the failure notice")
      expect(notices[0]).toContain("offline")
      yield* waitForFrame(setup, (frame) => frame.includes("1 open question"), "the question back")
      answer.onSelect()
      yield* waitForFrame(setup, (frame) => frame.includes("Question 1/1"), "the pane again")
      setup.mockInput.pressEnter()
      yield* waitForFrame(
        setup,
        (frame) => !frame.includes("open question") && !frame.includes("Question 1/1"),
        "no question left",
      )
      expect(sent).toEqual([
        { answers: [{ id: cache.id, answer: "in-memory LRU" }], dismiss: [] },
        { answers: [{ id: cache.id, answer: "in-memory LRU" }], dismiss: [] },
      ])
      // With nothing open, /answer says so instead of opening an empty pane.
      answer.onSelect()
      expect(notices.at(-1)).toBe("answer: no open questions on this branch")
      yield* Effect.promise(() => runtime.dispose())
    }).pipe(Effect.timeout("8 seconds")),
  )
})
