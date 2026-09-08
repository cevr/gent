import { DateTime, Effect, Layer, FileSystem, Option, Path } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { EventPublisher } from "../domain/event-publisher.js"
import { EventStoreError, MessageReceived } from "../domain/event.js"
import { MessageId } from "../domain/ids.js"
import { Message } from "../domain/message.js"
import { MessageStorage } from "../storage/message-storage.js"
import { makeStorageTransaction } from "../storage/sqlite-storage.js"
import { GentPlatform } from "./gent-platform.js"
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
  | ApprovalService
  | FileSystem.FileSystem
  | Path.Path
  | RuntimeEnvironment
  | MessageStorage
  | EventPublisher
  | SqlClient.SqlClient
  | GentPlatform
> = Layer.effect(
  PromptPresenter,
  Effect.gen(function* () {
    const approvalService = yield* ApprovalService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* RuntimeEnvironment
    const gentPlatform = yield* GentPlatform
    const messages = yield* MessageStorage
    const publisher = yield* EventPublisher
    const transaction = yield* makeStorageTransaction

    return PromptPresenter.of({
      present: Effect.fn("PromptPresenter.present")(function* (params) {
        const text = Option.match(Option.fromUndefinedOr(params.title), {
          onNone: () => params.content,
          onSome: (title) => `# ${title}\n\n${params.content}`,
        })
        const message = Message.cases.regular.make({
          id: MessageId.make(yield* gentPlatform.randomId),
          sessionId: params.sessionId,
          branchId: params.branchId,
          role: "assistant",
          parts: [Prompt.textPart({ text })],
          createdAt: yield* DateTime.nowAsDate,
          metadata: { customType: "prompt-present", hidden: true },
        })
        const envelope = yield* transaction(
          Effect.gen(function* () {
            yield* messages.createMessage(message)
            return yield* publisher.append(MessageReceived.make({ message }))
          }),
        ).pipe(
          Effect.mapError(
            (cause) => new EventStoreError({ message: "Failed to present information", cause }),
          ),
        )
        yield* publisher.deliver(envelope)
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

        if (decision.approved && decision.notes === "edit") {
          const submittedContent = Option.fromUndefinedOr(decision.editedContent)
          if (Option.isSome(submittedContent)) {
            yield* fs.writeFileString(resolvedPath, submittedContent.value)
            return {
              decision: "edit",
              path: resolvedPath,
              content: submittedContent.value,
            }
          }
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
