import { ServiceMap, Effect, Layer, Schema } from "effect"
import { PlanCheckpoint, type Message, type Checkpoint } from "../domain/message.js"
import type { BranchId } from "../domain/ids.js"
import { Storage, type StorageError } from "../storage/sqlite-storage.js"

// Checkpoint Error

export class CheckpointError extends Schema.TaggedErrorClass<CheckpointError>()("CheckpointError", {
  message: Schema.String,
}) {}

// Token estimation: ~4 chars per token

export const estimateTokens = (messages: ReadonlyArray<Message>): number => {
  let chars = 0
  for (const msg of messages) {
    for (const part of msg.parts) {
      switch (part.type) {
        case "text":
          chars += part.text.length
          break
        case "tool-call":
          chars += JSON.stringify(part.input).length
          break
        case "tool-result":
          chars += JSON.stringify(part.output).length
          break
        case "image":
          chars += 1000 // ~250 tokens estimate for image references
          break
        case "reasoning":
          chars += part.text.length
          break
      }
    }
  }
  return Math.ceil(chars / 4)
}

// Context window sizes by model prefix

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "anthropic/claude-opus-4-6": 1_000_000,
  "openai/gpt-5.4": 1_000_000,
  "openai/gpt-5.4-mini": 1_000_000,
}

const DEFAULT_CONTEXT_WINDOW = 200_000

export const getContextWindow = (modelId: string): number =>
  MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT_WINDOW

// Estimate context usage percentage including system prompt overhead
// System prompt + tool definitions: ~4000 tokens fixed overhead

const SYSTEM_OVERHEAD_TOKENS = 4_000

export const estimateContextPercent = (
  messages: ReadonlyArray<Message>,
  modelId: string,
): number => {
  const messageTokens = estimateTokens(messages)
  const totalTokens = messageTokens + SYSTEM_OVERHEAD_TOKENS
  const contextWindow = getContextWindow(modelId)
  return Math.round((totalTokens / contextWindow) * 100)
}

// Checkpoint Service

export interface CheckpointServiceApi {
  readonly createPlanCheckpoint: (
    branchId: BranchId,
    planPath: string,
  ) => Effect.Effect<PlanCheckpoint, StorageError>
  readonly getLatestCheckpoint: (
    branchId: BranchId,
  ) => Effect.Effect<Checkpoint | undefined, StorageError>
  readonly estimateTokens: (messages: ReadonlyArray<Message>) => Effect.Effect<number>
  readonly estimateContextPercent: (
    messages: ReadonlyArray<Message>,
    modelId: string,
  ) => Effect.Effect<number>
}

export class CheckpointService extends ServiceMap.Service<
  CheckpointService,
  CheckpointServiceApi
>()("@gent/runtime/src/checkpoint/CheckpointService") {
  static Live = (): Layer.Layer<CheckpointService, never, Storage> =>
    Layer.effect(
      CheckpointService,
      Effect.gen(function* () {
        const storage = yield* Storage

        const service: CheckpointServiceApi = {
          createPlanCheckpoint: Effect.fn("CheckpointService.createPlanCheckpoint")(function* (
            branchId: BranchId,
            planPath: string,
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

          estimateTokens: (messages) => Effect.succeed(estimateTokens(messages)),

          estimateContextPercent: (messages, modelId) =>
            Effect.succeed(estimateContextPercent(messages, modelId)),
        }

        return service
      }),
    )

  static Test = (): Layer.Layer<CheckpointService> =>
    Layer.succeed(CheckpointService, {
      createPlanCheckpoint: (branchId, planPath) =>
        Effect.succeed(
          new PlanCheckpoint({
            id: "test",
            branchId,
            planPath,
            messageCount: 0,
            tokenCount: 0,
            createdAt: new Date(),
          }),
        ),
      getLatestCheckpoint: () => Effect.succeed(undefined),
      estimateTokens: (messages) => Effect.succeed(estimateTokens(messages)),
      estimateContextPercent: (messages, modelId) =>
        Effect.succeed(estimateContextPercent(messages, modelId)),
    })
}
