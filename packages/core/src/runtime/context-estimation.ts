/**
 * Token estimation and context window utilities.
 *
 * Pure functions — no service dependencies.
 */

import type { Message } from "../domain/message.js"
import { Schema } from "effect"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
          chars += encodeJson(part.params).length
          break
        case "tool-result":
          chars += encodeJson(part.result).length
          break
        case "file":
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

export interface ModelContextWindows {
  [modelId: string]: number
}

export const MODEL_CONTEXT_WINDOWS: ModelContextWindows = {
  "anthropic/claude-opus-4-6": 1_000_000,
  "openai/gpt-5.4": 1_000_000,
  "openai/gpt-5.4-mini": 1_000_000,
  "openai/gpt-5.5": 1_050_000,
  "openai/gpt-5.6": 1_050_000,
  "openai/gpt-5.6-luna": 1_050_000,
  "openai/gpt-5.6-sol": 1_050_000,
  "openai/gpt-5.6-terra": 1_050_000,
}
