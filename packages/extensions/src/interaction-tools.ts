import { Effect, FileSystem, Option, Path, Schema } from "effect"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type Question,
  tool,
} from "@gent/core/extensions/api"

// ── ask-user ────────────────────────────────────────────────────────────────

const AnswersSchema = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String)))
const decodeAnswers = Schema.decodeUnknownEffect(AnswersSchema)

/**
 * Notes that are not a JSON answer list are a free-text answer to the first
 * question; the other questions get an empty answer, one list per question.
 */
const parseAnswers = (
  notes: string,
  questionCount: number,
): Effect.Effect<ReadonlyArray<ReadonlyArray<string>>> =>
  decodeAnswers(notes).pipe(
    Effect.orElseSucceed((): ReadonlyArray<ReadonlyArray<string>> => [
      [notes],
      ...Array.from({ length: questionCount - 1 }, () => []),
    ]),
  )

// AskUser Params — canonical questions[] input
// Mirrors QuestionSchema with exact-optional fields for provider tool schemas.

const AskUserQuestionOptionSchema = Schema.Struct({
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
})
const AskUserQuestionSchema = Schema.Struct({
  question: Schema.String,
  header: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(30)).annotate({
      description: "Short label for the question (max 30 chars)",
    }),
  ),
  markdown: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(
    Schema.Array(AskUserQuestionOptionSchema)
      .check(Schema.isMaxLength(4))
      .annotate({ description: "Options for user to choose from" }),
  ),
  multiple: Schema.optionalKey(Schema.Boolean),
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

const formatQuestionsText = (questions: ReadonlyArray<Question>): string =>
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
      metadata: { type: "ask-user", questions: params.questions },
    })
    if (!decision.approved) {
      return { answers: [], cancelled: true }
    }
    const notes = Option.fromNullishOr(decision.notes)
    let answers: ReadonlyArray<ReadonlyArray<string>> = params.questions.map(() => [])
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

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const withTitle = (title: Option.Option<string>, content: string): string =>
  Option.match(title, {
    onNone: () => content,
    onSome: (heading) => `# ${heading}\n\n${content}`,
  })

export const PromptTool = tool({
  id: "prompt",
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
    yield* fs.writeFileString(path, text)

    const decision = yield* ctx.Interaction.approve({
      text,
      metadata: { type: "prompt", mode: "review", path, title: params.title },
    })
    if (!decision.approved) return { mode: "review", decision: "no", path }
    if (decision.notes !== "edit") return { mode: "review", decision: "yes", path }

    const submitted = Option.fromUndefinedOr(decision.editedContent)
    if (Option.isSome(submitted)) {
      yield* fs.writeFileString(path, submitted.value)
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

// ── extension ───────────────────────────────────────────────────────────────

const INTERACTION_TOOLS_EXTENSION_ID = ExtensionId.make("@gent/interaction-tools")

export const InteractionToolsExtension = defineExtension({
  id: INTERACTION_TOOLS_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", AskUserTool, PromptTool, HandoffTool)
  }),
})
