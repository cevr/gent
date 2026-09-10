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
