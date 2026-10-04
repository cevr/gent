import {
  Cause,
  Clock,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
} from "effect"
import { Hex } from "effect/encoding"
import {
  defineExtension,
  defineRequests,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  omitUndefined,
  request,
  tool,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import { makeBranchStateStore } from "./branch-state-store.js"

// Test seam: only tests read these exports. AskUserTool, PromptTool,
// HandoffTool and AskUserAsyncTool are the capabilities the tool and cell
// signature tests drive.

// ── ask-user ────────────────────────────────────────────────────────────────

// The ask-user wire, which the TUI's client extension reads through
// `@gent/extensions/client`. The interaction metadata carries the questions;
// the answer's notes carry one array of picks per question, as JSON. A
// question stored in an interaction before a limit was added must still
// decode, so these schemas check shape only; the tool's params add the limits.

const AskUserOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

const AskUserQuestion = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  markdown: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(AskUserOption)),
  multiple: Schema.optionalKey(Schema.Boolean),
})
type AskUserQuestion = typeof AskUserQuestion.Type

export const ASK_USER_INTERACTION_TYPE = "ask-user"

/** The metadata of an ask-user interaction. */
export const AskUserMetadata = Schema.Struct({
  type: Schema.Literal(ASK_USER_INTERACTION_TYPE),
  questions: Schema.Array(AskUserQuestion),
})

/** The answer notes: one array of picks per question, JSON-encoded. */
export const AskUserAnswers = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String)))
const decodeAnswers = Schema.decodeUnknownEffect(AskUserAnswers)

/** Exactly one answer list per question: pad with empty lists, drop extras. */
const alignAnswers = (
  answers: ReadonlyArray<ReadonlyArray<string>>,
  questionCount: number,
): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: questionCount }, (_, index) => answers[index] ?? [])

/**
 * Notes that are not a JSON answer list are a free-text answer to the first
 * question. Either way the result has one answer list per question.
 */
const parseAnswers = (
  notes: string,
  questionCount: number,
): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>> =>
  decodeAnswers(notes).pipe(
    Effect.orElseSucceed((): ReadonlyArray<ReadonlyArray<string>> => [[notes]]),
    Effect.map((answers) => alignAnswers(answers, questionCount)),
  )

// AskUser Params — the wire question with the limits a new call must keep.

const AskUserQuestionSchema = Schema.Struct({
  ...AskUserQuestion.fields,
  header: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  options: Schema.optionalKey(
    Schema.Array(AskUserOption)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for user to choose from" }),
  ),
})

const AskUserParams = Schema.Struct({
  questions: Schema.Array(AskUserQuestionSchema)
    .check(Schema.isMinLength(1), Schema.isMaxLength(5))
    .annotate({ description: "1-5 questions to ask the user" }),
})

// AskUser Result — canonical answers[][] output

const AskUserResult = Schema.Struct({
  answers: Schema.Array(Schema.Array(Schema.String)).annotate({
    description: "Selected labels for each question",
  }),
  cancelled: Schema.optional(Schema.Boolean).annotate({
    description: "True when the user cancelled the interaction",
  }),
})

// AskUser Tool — uses ExtensionContext.Interaction.approve() with structured question metadata

const formatQuestionsText = (questions: ReadonlyArray<AskUserQuestion>): string =>
  questions
    .map((q, i) => {
      const header = Option.fromNullishOr(q.header).pipe(
        Option.map((value) => `[${value}] `),
        Option.getOrElse(() => ""),
      )
      const options = Option.fromNullishOr(q.options).pipe(
        Option.map((values) => `\nOptions: ${values.map((option) => option.label).join(", ")}`),
        Option.getOrElse(() => ""),
      )
      return `${i + 1}. ${header}${q.question}${options}`
    })
    .join("\n")

export const AskUserTool = tool({
  id: "ask_user",
  interactive: true,
  description:
    "Ask user questions with optional predefined options. Supports single or multi-select. Use for gathering preferences, clarifying requirements, or validating assumptions.",
  promptSnippet: "Ask the user questions with optional predefined options",
  params: AskUserParams,
  output: AskUserResult,
  execute: Effect.fn("AskUserTool.execute")(function* (params: typeof AskUserParams.Type) {
    const ctx = yield* ExtensionContext
    const decision = yield* ctx.Interaction.approve({
      text: formatQuestionsText(params.questions),
      metadata: {
        type: ASK_USER_INTERACTION_TYPE,
        questions: params.questions,
      } satisfies typeof AskUserMetadata.Type,
    })
    if (!decision.approved) {
      return { answers: [], cancelled: true }
    }
    const notes = Option.fromNullishOr(decision.notes)
    let answers = alignAnswers([], params.questions.length)
    if (Option.isSome(notes)) {
      answers = yield* parseAnswers(notes.value, params.questions.length)
    }
    return { answers }
  }),
})

// ── prompt ──────────────────────────────────────────────────────────────────

// Prompt Params — single object shape because Anthropic rejects top-level anyOf tool inputs.

const PromptParams = Schema.Struct({
  mode: Schema.Literals(["present", "confirm", "review"]).annotate({
    description: "present: show information, confirm: ask yes/no, review: persist editable content",
  }),
  content: Schema.String.annotate({
    description: "Markdown content to display, confirm, or review",
  }),
  title: Schema.optionalKey(Schema.String).annotate({
    description: "Optional title",
  }),
})

// Prompt Result — discriminated union on mode

const PresentResult = Schema.Struct({
  mode: Schema.Literal("present"),
  status: Schema.Literal("shown"),
})

const ConfirmResult = Schema.Struct({
  mode: Schema.Literal("confirm"),
  decision: Schema.Literals(["yes", "no"]),
})

const ReviewResult = Schema.Struct({
  mode: Schema.Literal("review"),
  decision: Schema.Literals(["yes", "no", "edit"]),
  path: Schema.String,
  content: Schema.optional(Schema.String),
})

const PromptResult = Schema.Union([PresentResult, ConfirmResult, ReviewResult])

/** A file-name slug; a title with no ASCII letter or digit falls back to `prompt`. */
const slugify = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
  if (slug.length === 0) return "prompt"
  return slug
}

const withTitle = (title: Option.Option<string>, content: string): string =>
  Option.match(title, {
    onNone: () => content,
    onSome: (heading) => `# ${heading}\n\n${content}`,
  })

export const PromptTool = tool({
  id: "prompt",
  // A confirm or a review waits on the user; a non-interactive turn has none.
  interactive: true,
  description:
    "Present content to the user for review, confirmation, or informational display. " +
    "Use mode=present for informational content (no response needed), " +
    "mode=confirm for yes/no decisions, " +
    "mode=review for content that should be persisted and can be edited by the user.",
  params: PromptParams,
  output: PromptResult,
  execute: Effect.fn("PromptTool.execute")(function* (params: typeof PromptParams.Type) {
    const ctx = yield* ExtensionContext
    const title = Option.fromUndefinedOr(params.title)
    if (params.mode === "present") {
      yield* ctx.Interaction.present({ content: params.content, title: params.title })
      return { mode: "present", status: "shown" }
    }

    if (params.mode === "confirm") {
      const decision = yield* ctx.Interaction.approve({
        text: params.content,
        metadata: { type: "prompt", mode: "confirm", title: params.title },
      })
      if (decision.approved) return { mode: "confirm", decision: "yes" }
      return { mode: "confirm", decision: "no" }
    }

    // review: persist the content to a file the user can edit, then ask.
    const slug = Option.match(title, { onNone: () => "prompt", onSome: slugify })
    const seed = Option.getOrElse(Option.fromUndefinedOr(ctx.toolCallId), () => "prompt")
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const path = pathService.resolve(ctx.cwd, ".gent", "prompts", `${slug}-${seed}.md`)
    const text = withTitle(title, params.content)
    yield* fs.makeDirectory(pathService.dirname(path), { recursive: true })
    yield* writeFileAtomic(path, text)

    const decision = yield* ctx.Interaction.approve({
      text,
      metadata: { type: "prompt", mode: "review", path, title: params.title },
    })
    if (!decision.approved) return { mode: "review", decision: "no", path }
    if (decision.notes !== "edit") return { mode: "review", decision: "yes", path }

    const submitted = Option.fromUndefinedOr(decision.editedContent)
    if (Option.isSome(submitted)) {
      yield* writeFileAtomic(path, submitted.value)
      return { mode: "review", decision: "edit", path, content: submitted.value }
    }
    const edited = yield* fs
      .readFileString(path)
      .pipe(Effect.catchEager(() => Effect.succeed(text)))
    return { mode: "review", decision: "edit", path, content: edited }
  }),
})

// ── handoff ─────────────────────────────────────────────────────────────────

const HandoffParams = Schema.Struct({
  context: Schema.String.annotate({
    description:
      "Distilled context for the new session. Include: current task, key decisions, relevant files, open questions, and any state that needs to carry over. This becomes the initial prompt.",
  }),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description: "Why the user wants the handoff",
    }),
  ),
})

const HandoffResult = Schema.Struct({
  handoff: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  parentSessionId: Schema.optional(Schema.String),
})

/** One approval with `metadata.type: "handoff"`; on yes the client opens the new session. */
export const HandoffTool = tool({
  id: "handoff",
  interactive: true,
  description:
    "Create a new session with distilled context from the current one. Blocks until the user confirms. Context pressure is not a reason: the runtime compacts the window by itself.",
  promptSnippet: "Transfer context to a new session",
  promptGuidelines: [
    "ONLY use when the user asks for a handoff (the /handoff command); never on your own because the context is large",
    "Include all essential context — the new session starts fresh",
  ],
  params: HandoffParams,
  output: HandoffResult,
  execute: Effect.fn("HandoffTool.execute")(function* (params: typeof HandoffParams.Type) {
    const ctx = yield* ExtensionContext
    const decision = yield* ctx.Interaction.approve({
      text: params.context,
      metadata: { type: "handoff", reason: params.reason },
    })
    if (!decision.approved) return { handoff: false, reason: "User rejected handoff" }
    return {
      handoff: true,
      summary: params.context,
      reason: params.reason,
      parentSessionId: ctx.sessionId,
    }
  }),
})

// ── background questions ────────────────────────────────────────────────────

/**
 * `ask_user_async`: a question the turn does not wait for. The call stores
 * each question with the assumption the model works on until an answer
 * comes, and returns at once; it never takes the branch's one interaction
 * slot, so it never parks the turn. The user answers later through
 * `questions.answer`, and the answer reaches the model as one user message:
 * a steer that joins the running turn at its next step, or a turn of its own
 * on an idle branch. It is appended, so the cached prefix stays the same.
 *
 * The store holds only the open questions, one file per branch under
 * `<data dir>/questions`. An answered question is in the transcript as its
 * answer message, and a dismissed one is gone, so no closed row is kept.
 */

export const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")
/** `metadata.customType` on the user message that carries the answers. */
export const QUESTION_ANSWER_TYPE = "question-answer"

/** At most this many questions stay open on a branch; a new one past it drops the oldest. */
const MAX_OPEN_QUESTIONS = 8

/** One open question as the store keeps it and the tray and pane read it. */
export const OpenQuestion = Schema.Struct({
  /** `<toolCallId>:<index>`: a replay of the same call writes the same row. */
  id: Schema.String,
  question: Schema.String,
  header: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(AskUserOption)),
  /** What the model does until an answer arrives. */
  assume: Schema.String,
  /** Epoch milliseconds. */
  askedAt: Schema.Finite,
})
export type OpenQuestion = typeof OpenQuestion.Type

/**
 * A question as the branch file keeps it. `answered` is written once, before
 * the answer is sent, and never changes: the first answer recorded is the one
 * the model reads. `batch` is the request id of the send that carries it, so a
 * send repeated after a failed removal sends nothing new. A row with an answer
 * is closed for the reader; it leaves the file once its batch was sent.
 */
export const QuestionRow = Schema.Struct({
  ...OpenQuestion.fields,
  answered: Schema.optionalKey(Schema.Struct({ answer: Schema.String, batch: Schema.String })),
})
export type QuestionRow = typeof QuestionRow.Type

/** What `questions.open` answers: the open questions of the branch, oldest first. */
export const OpenQuestions = Schema.Struct({ questions: Schema.Array(OpenQuestion) })
export type OpenQuestions = typeof OpenQuestions.Type

/** `details` on an answer message; the transcript row reads it. */
export const QuestionAnswerDetails = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      question: Schema.String,
      header: Schema.optionalKey(Schema.String),
      assume: Schema.String,
      answer: Schema.String,
    }),
  ),
})
export type QuestionAnswerDetails = typeof QuestionAnswerDetails.Type

class QuestionsError extends Schema.TaggedError<QuestionsError>()("QuestionsError", {
  message: Schema.String,
}) {}

const questionStore = makeBranchStateStore({
  name: "QuestionStore",
  directory: "questions",
  codec: Schema.fromJsonString(Schema.Array(QuestionRow)),
  empty: [],
  invalid: (file, cause) =>
    new QuestionsError({ message: `Question file ${file} is invalid: ${cause.message}` }),
})

const isAnswered = (row: QuestionRow): boolean => Predicate.isNotUndefined(row.answered)

/**
 * The stored rows with `asked` added: an open row with the same id is
 * replaced (a replay of the same call), and so is an open row with the same
 * question text (the model asked it again). A row with a recorded answer
 * stays as it is, and a replay does not open it again. Past the cap the
 * oldest open question goes, with no message: the model already works on its
 * assumption. An answered row waits for its send and does not count.
 */
export const addOpenQuestions = (
  rows: ReadonlyArray<QuestionRow>,
  asked: ReadonlyArray<OpenQuestion>,
): ReadonlyArray<QuestionRow> => {
  const answeredIds = new Set(
    rows
      .values()
      .filter(isAnswered)
      .map((row) => row.id),
  )
  const fresh = asked.filter((row) => !answeredIds.has(row.id))
  const ids = new Set(fresh.map((row) => row.id))
  const texts = new Set(fresh.map((row) => row.question))
  const kept = rows.filter(
    (row) => isAnswered(row) || (!ids.has(row.id) && !texts.has(row.question)),
  )
  const next: ReadonlyArray<QuestionRow> = [...kept, ...fresh]
  const open = next.filter((row) => !isAnswered(row))
  const dropped = new Set(
    open.slice(0, Math.max(0, open.length - MAX_OPEN_QUESTIONS)).map((row) => row.id),
  )
  return next.filter((row) => !dropped.has(row.id))
}

/** The rows the reader can still answer: those with no recorded answer. */
const openRows = (rows: ReadonlyArray<QuestionRow>): ReadonlyArray<OpenQuestion> =>
  rows.filter((row) => !isAnswered(row))

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis))

/**
 * The answers as the model reads them: self-contained, so it needs no lookup.
 * The question's id stays in the message details; the model needs only the
 * question, and an id from a cell call is long.
 */
export const questionAnswerText = (
  answers: ReadonlyArray<{ readonly row: OpenQuestion; readonly answer: string }>,
): string =>
  answers
    .map(({ row, answer }) =>
      [
        `Answer to your background question (asked ${isoOf(row.askedAt)}):`,
        `Q: ${row.question}`,
        `You assumed: ${row.assume}`,
        `A: ${answer}`,
      ].join("\n"),
    )
    .join("\n\n")

/**
 * The request id of one batch of answers: it names the questions the batch
 * answers. Each question is in one batch only, because its answer is
 * recorded once, so a send repeated for the batch sends nothing new. Hashed:
 * tool call ids are long, and a request id holds at most 128 characters.
 */
const answerRequestId = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode([...ids].sort().join("\n")))
      .pipe(Effect.orDie)
    return `question-answer:${Hex.encode(digest)}`
  })

const AskUserAsyncQuestion = Schema.Struct({
  question: Schema.String.annotate({ description: "The question, self-contained" }),
  header: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  options: Schema.optionalKey(
    Schema.Array(AskUserOption)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for the user to choose from" }),
  ),
  assume: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "What you do until an answer arrives; you continue on it now",
  }),
})

const AskUserAsyncParams = Schema.Struct({
  questions: Schema.Array(AskUserAsyncQuestion)
    .check(Schema.isMinLength(1), Schema.isMaxLength(3))
    .annotate({ description: "1-3 questions to ask in the background" }),
})

const AskUserAsyncResult = Schema.Struct({
  asked: Schema.Array(Schema.Struct({ id: Schema.String, assume: Schema.String })),
  note: Schema.String,
})

const ASKED_NOTE =
  "Continue on your assumption. An answer arrives as a user message if the user gives one."

/** What a client shows for the call: each question's label and what it assumed. */
const askedSummary = (input: typeof AskUserAsyncParams.Encoded): string =>
  input.questions
    .map((question) => {
      const label = Option.getOrElse(
        Option.fromUndefinedOr(question.header),
        () => question.question,
      )
      return `${label} · assuming ${question.assume}`
    })
    .join("; ")

export const AskUserAsyncTool = tool({
  id: "ask_user_async",
  // A spawned child's turn has no user to answer; it uses `session.send`.
  interactive: true,
  description:
    "Ask the user questions in the background and continue at once on a stated assumption. Returns immediately; the turn does not wait. An answer arrives later as a user message, if the user gives one.",
  promptSnippet: "Ask the user questions without waiting; continue on an assumption",
  promptGuidelines: [
    "Use ask_user_async when you can continue on a reasonable assumption; use ask_user when you cannot",
    "While a background question is open, state the assumption in your final answer",
  ],
  params: AskUserAsyncParams,
  output: AskUserAsyncResult,
  summary: (input) => askedSummary(input),
  execute: Effect.fn("AskUserAsyncTool.execute")(function* (
    params: typeof AskUserAsyncParams.Type,
  ) {
    const ctx = yield* ExtensionContext
    const askedAt = yield* Clock.currentTimeMillis
    // A call always has an id when the loop runs it; a direct run gets a fresh one.
    const crypto = yield* Crypto.Crypto
    const callId = yield* Option.match(Option.fromUndefinedOr(ctx.toolCallId), {
      onNone: () => crypto.randomUUIDv7,
      onSome: (id) => Effect.succeed(String(id)),
    })
    const asked = params.questions.map((question, index): OpenQuestion => ({
      id: `${callId}:${index}`,
      question: question.question,
      ...omitUndefined({ header: question.header, options: question.options }),
      assume: question.assume,
      askedAt,
    }))
    yield* questionStore.update((open) => addOpenQuestions(open, asked))
    return {
      asked: asked.map((row) => ({ id: row.id, assume: row.assume })),
      note: ASKED_NOTE,
    }
  }),
})

const AnswerQuestionsInput = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({ id: Schema.String, answer: Schema.String.check(Schema.isMinLength(1)) }),
  ),
  dismiss: Schema.optionalKey(Schema.Array(Schema.String)),
})

const AnswerQuestionsResult = Schema.Struct({
  answered: Schema.Array(Schema.String),
  dismissed: Schema.Array(Schema.String),
})

/**
 * Sends every batch of recorded answers the branch file holds, each as one
 * steer under its stored request id, then removes its rows; reports whether
 * any batch went. A batch a failed send or a failed removal left behind goes
 * again with the same request id, and the session sends nothing new, so this
 * runs wherever an earlier step may have stopped short: after each record,
 * at each `questions.open`, and when the branch's loop opens (a restart).
 */
const sendRecordedAnswers = Effect.fn("QuestionsRpc.sendRecorded")(function* () {
  const ctx = yield* ExtensionContext
  const sent = yield* questionStore.modify((rows) =>
    Effect.gen(function* () {
      const batches = new Map<
        string,
        Array<{ readonly row: QuestionRow; readonly answer: string }>
      >()
      for (const row of rows) {
        if (Predicate.isUndefined(row.answered)) continue
        const entries = batches.get(row.answered.batch) ?? []
        entries.push({ row, answer: row.answered.answer })
        batches.set(row.answered.batch, entries)
      }
      for (const [batch, answers] of batches) {
        yield* ctx.Session.send({
          delivery: "steer",
          wake: true,
          requestId: batch,
          content: questionAnswerText(answers),
          metadata: {
            customType: QUESTION_ANSWER_TYPE,
            details: {
              answers: answers.map(({ row, answer }) => ({
                id: row.id,
                question: row.question,
                ...omitUndefined({ header: row.header }),
                assume: row.assume,
                answer,
              })),
            } satisfies QuestionAnswerDetails,
          },
        })
      }
      if (batches.size === 0) return { next: rows, result: false }
      return { next: rows.filter((row) => !isAnswered(row)), result: true }
    }),
  )
  if (sent) yield* ctx.State.changed()
  return sent
})

/**
 * Answers and dismisses in two steps, each under the branch file's lock.
 *
 * 1. Record: an answer to a question that has none is written to its row,
 *    with the batch it goes in, before anything is sent. A recorded answer
 *    never changes, so the first one wins: a retry that answers it again, or
 *    answers fewer questions, adds nothing. A dismissed open row goes.
 * 2. Send: every batch the file holds goes as one steer under its request id,
 *    then its rows leave the file (`sendRecordedAnswers`).
 *
 * An id that is not open (answered already, dismissed, or dropped past the
 * cap) is skipped.
 */
const answerQuestions = Effect.fn("QuestionsRpc.answer")(function* (
  input: typeof AnswerQuestionsInput.Type,
) {
  const ctx = yield* ExtensionContext
  const dismiss = new Set(input.dismiss ?? [])
  const recorded = yield* questionStore.modify((rows) =>
    Effect.gen(function* () {
      const open = new Map(openRows(rows).map((row) => [row.id, row]))
      const fresh = new Map<string, string>()
      for (const { id, answer } of input.answers) {
        if (open.has(id) && !fresh.has(id)) fresh.set(id, answer)
      }
      const dismissed = [...open.keys()].filter((id) => dismiss.has(id) && !fresh.has(id))
      if (fresh.size === 0 && dismissed.length === 0) {
        return { next: rows, result: { answered: [], dismissed } }
      }
      const batch = yield* answerRequestId([...fresh.keys()])
      const next = rows
        .filter((row) => !dismissed.includes(row.id))
        .map((row): QuestionRow =>
          Option.match(Option.fromUndefinedOr(fresh.get(row.id)), {
            onNone: () => row,
            onSome: (answer) => ({ ...row, answered: { answer, batch } }),
          }),
        )
      return { next, result: { answered: [...fresh.keys()], dismissed } }
    }),
  )
  const sent = yield* sendRecordedAnswers()
  if (recorded.dismissed.length > 0 && !sent) yield* ctx.State.changed()
  return recorded
})

export const QuestionsRpc = defineRequests(INTERACTION_TOOLS_EXTENSION_ID, {
  Open: request({
    id: "questions.open",
    description: "The background questions still open on the current branch, oldest first",
    answersDuringTurn: true,
    input: Schema.Struct({}),
    output: OpenQuestions,
    // An answer recorded and not yet sent goes first: the reader no longer
    // sees its question, so nothing else would send it.
    execute: () =>
      sendRecordedAnswers().pipe(
        Effect.andThen(questionStore.read()),
        Effect.map((rows) => ({ questions: openRows(rows) })),
      ),
  }),
  Answer: request({
    id: "questions.answer",
    description:
      "Answer or dismiss open background questions; the answers reach the model as one user message",
    answersDuringTurn: true,
    input: AnswerQuestionsInput,
    output: AnswerQuestionsResult,
    execute: answerQuestions,
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", AskUserTool, PromptTool, HandoffTool, AskUserAsyncTool)
    yield* host.register("request", QuestionsRpc.Open, QuestionsRpc.Answer)
    yield* host.on("sessionDeleted", ({ branchIds }) => questionStore.removeBranches(branchIds))
    // A restart between an answer's record and its send leaves it in the
    // file, hidden from the reader: the branch's loop open sends it.
    yield* host.on("loopOpen", () =>
      sendRecordedAnswers().pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("questions.recorded.send.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
  }),
})
