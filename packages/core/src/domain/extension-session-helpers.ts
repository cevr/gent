/**
 * Pure helpers for session-derived data. Compose over already-exposed
 * `Session` data primitives (`listMessages`) and pure utilities
 * (`runtime/context-estimation`) instead of being plumbed as service
 * methods.
 *
 * Continues the W34-C12 / W35-C2 pattern of demoting derived methods to
 * pure helpers when they can be expressed as a composition of data
 * primitives.
 */

import { Effect } from "effect"
import { estimateContextPercent as pureEstimate } from "../runtime/context-estimation.js"
import { DEFAULT_MODEL_ID } from "./agent.js"
import { ExtensionContext, type ExtensionServiceError } from "./extension-services.js"

export const estimateContextPercent = (options?: {
  readonly modelId?: string
}): Effect.Effect<number, ExtensionServiceError, ExtensionContext> =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const messages = yield* ctx.Session.listMessages()
    const modelId = options?.modelId ?? DEFAULT_MODEL_ID
    return pureEstimate(messages, modelId)
  })
