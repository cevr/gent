/**
 * Debug / test provider re-exports.
 *
 * The implementations live in `providers/provider.ts` (as static methods
 * on the `Provider` class). This barrel re-exports the standalone
 * functions for backwards compatibility with existing `import { ... }
 * from "@gent/core/debug/provider"` call sites.
 *
 * Prefer `Provider.Sequence`, `Provider.Debug`, `Provider.Signal`,
 * `Provider.Failing` for new code.
 *
 * @module
 */

import * as Response from "effect/unstable/ai/Response"
import type * as AiTool from "effect/unstable/ai/Tool"
import { ToolCallId } from "../domain/ids.js"

export type ProviderStreamPart = Response.StreamPart<Record<string, AiTool.Any>>

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (text: string, id = makeStreamPartId("text")): ProviderStreamPart =>
  Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): ProviderStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.of(makeStreamPartId("tool")),
    name: toolName,
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = makeStreamPartId("reasoning"),
): ProviderStreamPart => Response.makePart("reasoning-delta", { id, delta: text })

export const finishPart = (params: {
  finishReason: Response.FinishReason
  usage?: { inputTokens: number; outputTokens: number }
}): ProviderStreamPart =>
  Response.makePart("finish", {
    reason: params.finishReason,
    usage: new Response.Usage({
      inputTokens: {
        uncached: undefined,
        total: params.usage?.inputTokens,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: params.usage?.outputTokens,
        text: undefined,
        reasoning: undefined,
      },
    }),
    response: undefined,
  })

export {
  textStep,
  toolCallStep,
  textThenToolCallStep,
  multiToolCallStep,
  type SequenceStep,
  type SequenceProviderControls,
  type SignalProviderControls,
} from "../providers/provider.js"

// Re-export under legacy names for backwards compat with existing imports
import { Provider } from "../providers/provider.js"

/** @deprecated Use `Provider.Debug()` */
export const DebugProvider = Provider.Debug

/** @deprecated Use `Provider.Failing` */
export const DebugFailingProvider = Provider.Failing

/** @deprecated Use `Provider.Signal(...)` */
export const createSignalProvider = Provider.Signal

/** @deprecated Use `Provider.Sequence(...)` */
export const createSequenceProvider = Provider.Sequence
