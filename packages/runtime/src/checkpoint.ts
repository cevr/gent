import { Context, Effect, Layer, Schema, Stream } from "effect"
import {
  CompactionCheckpoint,
  PlanCheckpoint,
  Message,
  MessagePart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  type Checkpoint,
} from "@gent/core"
import { Storage, StorageError } from "@gent/storage"
import { Provider, ProviderError } from "@gent/providers"

// Compaction Config

export const COMPACTION_THRESHOLD = 100_000 // tokens
export const PRUNE_PROTECT = 40_000 // Keep last N tokens of tool outputs
export const PRUNE_MINIMUM = 20_000 // Only prune if this much to remove

// Compaction Config Schema

export const CompactionConfig = Schema.Struct({
  threshold: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Token threshold to trigger compaction",
  }),
  pruneProtect: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Tokens of tool outputs to preserve",
  }),
  pruneMinimum: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Minimum tokens to remove during pruning",
  }),
})
export type CompactionConfig = typeof CompactionConfig.Type

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  threshold: COMPACTION_THRESHOLD,
  pruneProtect: PRUNE_PROTECT,
  pruneMinimum: PRUNE_MINIMUM,
}

// Token estimation: ~4 chars per token

export const estimateTokens = (messages: ReadonlyArray<Message>): number => {
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

// Estimate tokens for a single part

const estimatePartTokens = (part: MessagePart): number => {
  if (part.type === "text") {
    return Math.ceil((part as TextPart).text.length / 4)
  } else if (part.type === "tool-call") {
    return Math.ceil(JSON.stringify((part as ToolCallPart).input).length / 4)
  } else if (part.type === "tool-result") {
    return Math.ceil(JSON.stringify((part as ToolResultPart).output).length / 4)
  }
  return 0
}

// Prune old tool outputs while preserving recent ones

export const pruneToolOutputs = (
  messages: ReadonlyArray<Message>,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
): Message[] => {
  // Calculate current tool output tokens
  let toolOutputTokens = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool-result") {
        toolOutputTokens += estimatePartTokens(part)
      }
    }
  }

  // Only prune if we have enough to remove
  if (toolOutputTokens - config.pruneProtect < config.pruneMinimum) {
    return [...messages]
  }

  // Backward scan: mark old tool outputs for pruning
  const result: Message[] = []
  let protectedTokens = 0
  const reversedMessages = [...messages].reverse()

  for (const msg of reversedMessages) {
    const newParts: MessagePart[] = []
    let modified = false

    for (const part of msg.parts) {
      if (part.type === "tool-result") {
        const partTokens = estimatePartTokens(part)
        if (protectedTokens + partTokens <= config.pruneProtect) {
          protectedTokens += partTokens
          newParts.push(part)
        } else {
          // Replace with pruned marker
          newParts.push(
            new ToolResultPart({
              type: "tool-result",
              toolCallId: (part as ToolResultPart).toolCallId,
              toolName: (part as ToolResultPart).toolName,
              output: {
                type: "json",
                value: { _pruned: true, message: "Output pruned for context management" },
              },
            })
          )
          modified = true
        }
      } else {
        newParts.push(part)
      }
    }

    if (modified) {
      result.unshift(
        new Message({
          ...msg,
          parts: newParts,
        })
      )
    } else {
      result.unshift(msg)
    }
  }

  return result
}

// Checkpoint Service

export interface CheckpointServiceApi {
  readonly shouldCompact: (
    branchId: string
  ) => Effect.Effect<boolean, StorageError>
  readonly createCompactionCheckpoint: (
    branchId: string
  ) => Effect.Effect<CompactionCheckpoint, StorageError | ProviderError>
  readonly createPlanCheckpoint: (
    branchId: string,
    planPath: string
  ) => Effect.Effect<PlanCheckpoint, StorageError>
  readonly getLatestCheckpoint: (
    branchId: string
  ) => Effect.Effect<Checkpoint | undefined, StorageError>
  readonly prune: (
    messages: ReadonlyArray<Message>
  ) => Effect.Effect<Message[]>
  readonly estimateTokens: (
    messages: ReadonlyArray<Message>
  ) => Effect.Effect<number>
}

export class CheckpointService extends Context.Tag("CheckpointService")<
  CheckpointService,
  CheckpointServiceApi
>() {
  static Live = (
    model: string,
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  ): Layer.Layer<CheckpointService, never, Storage | Provider> =>
    Layer.effect(
      CheckpointService,
      Effect.gen(function* () {
        const storage = yield* Storage
        const provider = yield* Provider

        const service: CheckpointServiceApi = {
          shouldCompact: Effect.fn("CheckpointService.shouldCompact")(
            function* (branchId: string) {
              const messages = yield* storage.listMessages(branchId)
              const tokens = estimateTokens(messages)
              return tokens >= config.threshold
            }
          ),

          createCompactionCheckpoint: Effect.fn("CheckpointService.createCompactionCheckpoint")(function* (
            branchId: string
          ) {
            const messages = yield* storage.listMessages(branchId)
            const tokens = estimateTokens(messages)

            // Find the first message to keep (last 20% of messages or last 10 messages, whichever is more)
            const keepCount = Math.max(Math.ceil(messages.length * 0.2), 10)
            const firstKeptIndex = Math.max(0, messages.length - keepCount)
            const firstKeptMessage = messages[firstKeptIndex]
            if (!firstKeptMessage) {
              // No messages to compact
              return new CompactionCheckpoint({
                id: Bun.randomUUIDv7(),
                branchId,
                summary: "",
                firstKeptMessageId: "",
                messageCount: 0,
                tokenCount: 0,
                createdAt: new Date(),
              })
            }

            // Summarize messages before the kept ones
            const messagesToSummarize = messages.slice(0, firstKeptIndex)
            if (messagesToSummarize.length === 0) {
              return new CompactionCheckpoint({
                id: Bun.randomUUIDv7(),
                branchId,
                summary: "",
                firstKeptMessageId: firstKeptMessage.id,
                messageCount: messages.length,
                tokenCount: tokens,
                createdAt: new Date(),
              })
            }

            // Build conversation summary request
            const summaryPrompt = `Summarize this conversation concisely, preserving key context, decisions, and outcomes. Focus on information needed to continue the conversation effectively.

Conversation:
${messagesToSummarize
  .map((m) => {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as TextPart).text)
      .join("\n")
    return `${m.role}: ${text}`
  })
  .join("\n\n")}`

            const summaryMessage = new Message({
              id: Bun.randomUUIDv7(),
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

            const checkpoint = new CompactionCheckpoint({
              id: Bun.randomUUIDv7(),
              branchId,
              summary,
              firstKeptMessageId: firstKeptMessage.id,
              messageCount: messages.length,
              tokenCount: tokens,
              createdAt: new Date(),
            })

            yield* storage.createCheckpoint(checkpoint)

            return checkpoint
          }),

          createPlanCheckpoint: Effect.fn("CheckpointService.createPlanCheckpoint")(function* (
            branchId: string,
            planPath: string
          ) {
            const messages = yield* storage.listMessages(branchId)
            const tokens = estimateTokens(messages)

            const checkpoint = new PlanCheckpoint({
              id: Bun.randomUUIDv7(),
              branchId,
              planPath,
              messageCount: messages.length,
              tokenCount: tokens,
              createdAt: new Date(),
            })

            yield* storage.createCheckpoint(checkpoint)

            return checkpoint
          }),

          getLatestCheckpoint: (branchId) => storage.getLatestCheckpoint(branchId),

          prune: (messages) => Effect.succeed(pruneToolOutputs(messages, config)),

          estimateTokens: (messages) => Effect.succeed(estimateTokens(messages)),
        }

        return service
      })
    )

  static Test = (): Layer.Layer<CheckpointService> =>
    Layer.succeed(CheckpointService, {
      shouldCompact: () => Effect.succeed(false),
      createCompactionCheckpoint: (branchId) =>
        Effect.succeed(
          new CompactionCheckpoint({
            id: "test",
            branchId,
            summary: "Test summary",
            firstKeptMessageId: "test-msg",
            messageCount: 0,
            tokenCount: 0,
            createdAt: new Date(),
          })
        ),
      createPlanCheckpoint: (branchId, planPath) =>
        Effect.succeed(
          new PlanCheckpoint({
            id: "test",
            branchId,
            planPath,
            messageCount: 0,
            tokenCount: 0,
            createdAt: new Date(),
          })
        ),
      getLatestCheckpoint: () => Effect.succeed(undefined),
      prune: (messages) => Effect.succeed([...messages]),
      estimateTokens: (messages) => Effect.succeed(estimateTokens(messages)),
    })
}

