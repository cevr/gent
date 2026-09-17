import { Effect, Option, Schema } from "effect"
import { ExtensionContext, tool } from "@gent/core/extensions/api"

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
    const path = ctx.Files.resolve(ctx.cwd, ".gent", "prompts", `${slug}-${seed}.md`)
    const text = withTitle(title, params.content)
    yield* ctx.Files.makeDirectory(ctx.Files.dirname(path), { recursive: true })
    yield* ctx.Files.write(path, text)

    const decision = yield* ctx.Interaction.approve({
      text,
      metadata: { type: "prompt", mode: "review", path, title: params.title },
    })
    if (!decision.approved) return { mode: "review", decision: "no", path }
    if (decision.notes !== "edit") return { mode: "review", decision: "yes", path }

    const submitted = Option.fromUndefinedOr(decision.editedContent)
    if (Option.isSome(submitted)) {
      yield* ctx.Files.write(path, submitted.value)
      return { mode: "review", decision: "edit", path, content: submitted.value }
    }
    const edited = yield* ctx.Files.read(path).pipe(Effect.catchEager(() => Effect.succeed(text)))
    return { mode: "review", decision: "edit", path, content: edited }
  }),
})
