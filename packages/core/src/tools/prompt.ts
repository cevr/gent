import { Effect, Schema, FileSystem, Path } from "effect"
import { defineTool } from "../domain/tool.js"
import { PromptHandler } from "../domain/interaction-handlers.js"

// Prompt Params — discriminated union on mode

const PresentParams = Schema.Struct({
  mode: Schema.Literal("present"),
  content: Schema.String.annotate({
    description: "Markdown content to display",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

const ConfirmParams = Schema.Struct({
  mode: Schema.Literal("confirm"),
  content: Schema.String.annotate({
    description: "Markdown content requiring yes/no confirmation",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

const ReviewParams = Schema.Struct({
  mode: Schema.Literal("review"),
  content: Schema.String.annotate({
    description: "Markdown content for review (persisted to disk, editable)",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "Optional title",
  }),
})

export const PromptParams = Schema.Union([PresentParams, ConfirmParams, ReviewParams])

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

export const PromptResult = Schema.Union([PresentResult, ConfirmResult, ReviewResult])

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const defaultPromptPath = (title: string | undefined, toolCallId: string) => {
  const slug = title !== undefined ? slugify(title) : "prompt"
  return `${process.cwd()}/.gent/prompts/${slug}-${toolCallId}.md`
}

export const PromptTool = defineTool({
  name: "prompt",
  action: "interact",
  concurrency: "serial",
  description:
    "Present content to the user for review, confirmation, or informational display. " +
    "Use mode=present for informational content (no response needed), " +
    "mode=confirm for yes/no decisions, " +
    "mode=review for content that should be persisted and can be edited by the user.",
  params: PromptParams,
  execute: Effect.fn("PromptTool.execute")(function* (params, ctx) {
    const promptHandler = yield* PromptHandler

    if (params.mode === "present") {
      yield* promptHandler.present({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        mode: "present",
        content: params.content,
        title: params.title,
      })
      return { mode: "present" as const, status: "shown" as const }
    }

    if (params.mode === "confirm") {
      const decision = yield* promptHandler.present({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        mode: "confirm",
        content: params.content,
        title: params.title,
      })
      return {
        mode: "confirm" as const,
        decision: decision === "yes" ? ("yes" as const) : ("no" as const),
      }
    }

    // review mode — persist to disk
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const resolvedPath = path.resolve(defaultPromptPath(params.title, ctx.toolCallId))
    const text =
      params.title !== undefined ? `# ${params.title}\n\n${params.content}` : params.content

    yield* fs.makeDirectory(path.dirname(resolvedPath), { recursive: true })
    yield* fs.writeFileString(resolvedPath, text)

    const decision = yield* promptHandler.present({
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      mode: "review",
      path: resolvedPath,
      content: text,
      title: params.title,
    })

    if (decision === "edit") {
      // Read back the edited file
      const editedContent = yield* fs
        .readFileString(resolvedPath)
        .pipe(Effect.catchEager(() => Effect.succeed(text)))
      return {
        mode: "review" as const,
        decision: "edit" as const,
        path: resolvedPath,
        content: editedContent,
      }
    }

    return {
      mode: "review" as const,
      decision: decision === "yes" ? ("yes" as const) : ("no" as const),
      path: resolvedPath,
    }
  }),
})
