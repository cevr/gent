import { Context, Effect, Layer, Stream } from "effect"
import { Compaction, Message, TextPart, ToolCallPart, ToolResultPart } from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import { Provider, ProviderError } from "@gent/providers"

// Compaction Config

export const COMPACTION_THRESHOLD = 100_000 // tokens

// Compaction Service

export interface CompactionServiceApi {
  readonly shouldCompact: (
    branchId: string
  ) => Effect.Effect<boolean, StorageError>
  readonly compact: (
    branchId: string
  ) => Effect.Effect<Compaction, StorageError | ProviderError>
}

export class CompactionService extends Context.Tag("CompactionService")<
  CompactionService,
  CompactionServiceApi
>() {
  static Live = (
    model: string
  ): Layer.Layer<CompactionService, never, Storage | Provider> =>
    Layer.effect(
      CompactionService,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider

        // Rough token estimation: ~4 chars per token
        const estimateTokens = (messages: ReadonlyArray<Message>): number => {
          let chars = 0
          for (const msg of messages) {
            for (const part of msg.parts) {
              if (part.type === "text") {
                chars += (part as TextPart).text.length
              } else if (part.type === "tool-call") {
                chars += JSON.stringify((part as ToolCallPart).input).length
              } else if (part.type === "tool-result") {
                chars += JSON.stringify((part as ToolResultPart).output).length
              }
            }
          }
          return Math.ceil(chars / 4)
        }

        const service: CompactionServiceApi = {
          shouldCompact: Effect.fn("CompactionService.shouldCompact")(
            function* (branchId: string) {
              const messages = yield* storage.listMessages(branchId)
              const tokens = estimateTokens(messages)
              return tokens >= COMPACTION_THRESHOLD
            }
          ),

          compact: Effect.fn("CompactionService.compact")(function* (
            branchId: string
          ) {
            const messages = yield* storage.listMessages(branchId)
            const tokens = estimateTokens(messages)

            // Build conversation summary request
            const summaryPrompt = `Summarize this conversation concisely, preserving key context, decisions, and outcomes. Focus on information needed to continue the conversation effectively.

Conversation:
${messages
  .map((m) => {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
    return `${m.role}: ${text}`
  })
  .join("\n\n")}`

            const summaryMessage = new Message({
              id: crypto.randomUUID(),
              sessionId: messages[0]?.sessionId ?? "",
              branchId,
              role: "user",
              parts: [new TextPart({ type: "text", text: summaryPrompt })],
              createdAt: new Date(),
            })

            const streamEffect = yield* provider.stream({
              model,
              messages: [summaryMessage],
              maxTokens: 2000,
            })

            const summaryParts: string[] = []
            yield* Stream.runForEach(streamEffect, (chunk) =>
              Effect.sync(() => {
                if (chunk._tag === "TextChunk") {
                  summaryParts.push(chunk.text)
                }
              })
            )

            const summary = summaryParts.join("")

            const compaction = new Compaction({
              id: crypto.randomUUID(),
              branchId,
              summary,
              messageCount: messages.length,
              tokenCount: tokens,
              createdAt: new Date(),
            })

            yield* storage.createCompaction(compaction)

            return compaction
          }),
        }

        return service
      })
    )

  static Test = (): Layer.Layer<CompactionService> =>
    Layer.succeed(CompactionService, {
      shouldCompact: () => Effect.succeed(false),
      compact: (branchId) =>
        Effect.succeed(
          new Compaction({
            id: "test",
            branchId,
            summary: "Test summary",
            messageCount: 0,
            tokenCount: 0,
            createdAt: new Date(),
          })
        ),
    })
}
