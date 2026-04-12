import { Context, Effect, Layer, FileSystem, Path } from "effect"
import type { PlatformError } from "effect"
import type { SessionId, BranchId } from "./ids"
import type { EventStoreError } from "./event"
import type { InteractionPendingError } from "./interaction-request"
import { ApprovalService } from "../runtime/approval-service"
import { RuntimePlatform } from "../runtime/runtime-platform"

// PromptPresenter — reusable presentation service for delegate tools
// Extracts review/confirm/present from PromptTool so tools can present
// without tool-calls-tool.

export interface PromptPresenterService {
  readonly present: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<void, EventStoreError | InteractionPendingError>

  readonly confirm: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
  }) => Effect.Effect<"yes" | "no", EventStoreError | InteractionPendingError>

  readonly review: (params: {
    sessionId: SessionId
    branchId: BranchId
    content: string
    title?: string
    fileNameSeed: string
  }) => Effect.Effect<
    { decision: "yes" | "no" | "edit"; path: string; content?: string },
    EventStoreError | PlatformError.PlatformError | InteractionPendingError
  >
}

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const defaultPromptPath = (cwd: string, title: string | undefined, fileNameSeed: string) => {
  const slug = title !== undefined ? slugify(title) : "prompt"
  return `${cwd}/.gent/prompts/${slug}-${fileNameSeed}.md`
}

export class PromptPresenter extends Context.Service<PromptPresenter, PromptPresenterService>()(
  "@gent/core/src/domain/prompt-presenter/PromptPresenter",
) {
  static Live: Layer.Layer<
    PromptPresenter,
    never,
    ApprovalService | FileSystem.FileSystem | Path.Path | RuntimePlatform
  > = Layer.effect(
    PromptPresenter,
    Effect.gen(function* () {
      const approvalService = yield* ApprovalService
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const platform = yield* RuntimePlatform

      return PromptPresenter.of({
        present: Effect.fn("PromptPresenter.present")(function* (params) {
          yield* approvalService.present(
            {
              text: params.content,
              metadata: { type: "prompt", mode: "present", title: params.title },
            },
            { sessionId: params.sessionId, branchId: params.branchId },
          )
        }),

        confirm: Effect.fn("PromptPresenter.confirm")(function* (params) {
          const decision = yield* approvalService.present(
            {
              text: params.content,
              metadata: { type: "prompt", mode: "confirm", title: params.title },
            },
            { sessionId: params.sessionId, branchId: params.branchId },
          )
          return decision.approved ? ("yes" as const) : ("no" as const)
        }),

        review: Effect.fn("PromptPresenter.review")(function* (params) {
          const resolvedPath = path.resolve(
            defaultPromptPath(platform.cwd, params.title, params.fileNameSeed),
          )
          const text =
            params.title !== undefined ? `# ${params.title}\n\n${params.content}` : params.content

          yield* fs.makeDirectory(path.dirname(resolvedPath), { recursive: true })
          yield* fs.writeFileString(resolvedPath, text)

          const decision = yield* approvalService.present(
            {
              text,
              metadata: { type: "prompt", mode: "review", path: resolvedPath, title: params.title },
            },
            { sessionId: params.sessionId, branchId: params.branchId },
          )

          if (decision.notes === "edit") {
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
            decision: decision.approved ? ("yes" as const) : ("no" as const),
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
