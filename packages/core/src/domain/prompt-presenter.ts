import { ServiceMap, Effect, Layer, FileSystem, Path } from "effect"
import type { PlatformError } from "effect"
import type { SessionId, BranchId } from "./ids"
import type { EventStoreError, PromptDecision } from "./event"
import { PromptHandler } from "./interaction-handlers"

// PromptPresenter — reusable presentation service for workflows
// Extracts review/confirm/present from PromptTool so workflows can present
// without tool-calls-tool.

export interface PromptPresenterService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<void, EventStoreError>

  readonly confirm: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<"yes" | "no", EventStoreError>

  readonly review: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
    fileNameSeed: string
  }) => Effect.Effect<
    { decision: "yes" | "no" | "edit"; path: string; content?: string },
    EventStoreError | PlatformError.PlatformError
  >
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const defaultPromptPath = (title: string | undefined, fileNameSeed: string) => {
  const slug = title !== undefined ? slugify(title) : "prompt"
  return `${process.cwd()}/.gent/prompts/${slug}-${fileNameSeed}.md`
}

export class PromptPresenter extends ServiceMap.Service<PromptPresenter, PromptPresenterService>()(
  "@gent/core/src/domain/PromptPresenter",
) {
  static Live: Layer.Layer<
    PromptPresenter,
    never,
    PromptHandler | FileSystem.FileSystem | Path.Path
  > = Layer.effect(
    PromptPresenter,
    Effect.gen(function* () {
      const promptHandler = yield* PromptHandler
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      return PromptPresenter.of({
        present: Effect.fn("PromptPresenter.present")(function* (params) {
          yield* promptHandler.present({
            sessionId: params.sessionId,
            branchId: params.branchId,
            mode: "present",
            content: params.content,
            title: params.title,
          })
        }),

        confirm: Effect.fn("PromptPresenter.confirm")(function* (params) {
          const decision = yield* promptHandler.present({
            sessionId: params.sessionId,
            branchId: params.branchId,
            mode: "confirm",
            content: params.content,
            title: params.title,
          })
          return decision === "yes" ? ("yes" as const) : ("no" as const)
        }),

        review: Effect.fn("PromptPresenter.review")(function* (params) {
          const resolvedPath = path.resolve(defaultPromptPath(params.title, params.fileNameSeed))
          const text =
            params.title !== undefined ? `# ${params.title}\n\n${params.content}` : params.content

          yield* fs.makeDirectory(path.dirname(resolvedPath), { recursive: true })
          yield* fs.writeFileString(resolvedPath, text)

          const decision: PromptDecision = yield* promptHandler.present({
            sessionId: params.sessionId,
            branchId: params.branchId,
            mode: "review",
            path: resolvedPath,
            content: text,
            title: params.title,
          })

          if (decision === "edit") {
            const editedContent = yield* fs
              .readFileString(resolvedPath)
              .pipe(Effect.catchEager(() => Effect.succeed(text)))
            return {
              decision: "edit" as const,
              path: resolvedPath,
              content: editedContent,
            }
          }

          return {
            decision: decision === "yes" ? ("yes" as const) : ("no" as const),
            path: resolvedPath,
          }
        }),
      })
    }),
  )

  static Test = (
    confirmDecisions: ReadonlyArray<"yes" | "no"> = ["yes"],
    reviewDecisions: ReadonlyArray<"yes" | "no" | "edit"> = ["yes"],
  ): Layer.Layer<PromptPresenter> => {
    let confirmIdx = 0
    let reviewIdx = 0
    return Layer.succeed(PromptPresenter, {
      present: () => Effect.void,
      confirm: () => Effect.succeed(confirmDecisions[confirmIdx++] ?? "yes"),
      review: () =>
        Effect.succeed({
          decision: reviewDecisions[reviewIdx++] ?? "yes",
          path: "/tmp/test-prompt.md",
        }),
    })
  }
}
