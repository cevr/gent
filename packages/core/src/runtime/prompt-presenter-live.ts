import { Effect, Layer, FileSystem, Path } from "effect"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ApprovalService } from "./approval-service.js"
import { RuntimePlatform } from "./runtime-platform.js"

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

export const PromptPresenterLive: Layer.Layer<
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
