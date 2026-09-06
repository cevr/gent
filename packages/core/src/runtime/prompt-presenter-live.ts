import { Effect, Layer, FileSystem, Option, Path } from "effect"
import { PromptPresenter } from "../domain/prompt-presenter.js"
import { ApprovalService } from "./approval-service.js"
import { RuntimeEnvironment } from "./runtime-environment.js"

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)

const defaultPromptPath = (cwd: string, title: Option.Option<string>, fileNameSeed: string) => {
  const slug = Option.match(title, {
    onNone: () => "prompt",
    onSome: slugify,
  })
  return `${cwd}/.gent/prompts/${slug}-${fileNameSeed}.md`
}

export const PromptPresenterLive: Layer.Layer<
  PromptPresenter,
  never,
  ApprovalService | FileSystem.FileSystem | Path.Path | RuntimeEnvironment
> = Layer.effect(
  PromptPresenter,
  Effect.gen(function* () {
    const approvalService = yield* ApprovalService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* RuntimeEnvironment

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
        if (decision.approved) return "yes"
        return "no"
      }),

      review: Effect.fn("PromptPresenter.review")(function* (params) {
        const resolvedPath = path.resolve(
          defaultPromptPath(
            platform.cwd,
            Option.fromUndefinedOr(params.title),
            params.fileNameSeed,
          ),
        )
        const text = Option.match(Option.fromUndefinedOr(params.title), {
          onNone: () => params.content,
          onSome: (title) => `# ${title}\n\n${params.content}`,
        })

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
            decision: "edit",
            path: resolvedPath,
            content: editedContent,
          }
        }

        if (decision.approved) {
          return { decision: "yes", path: resolvedPath }
        }
        return { decision: "no", path: resolvedPath }
      }),
    })
  }),
)
