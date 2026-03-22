/**
 * Token estimation and context window utilities.
 *
 * Pure functions — no service dependencies.
 */

import type { Message } from "../domain/message.js"

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
