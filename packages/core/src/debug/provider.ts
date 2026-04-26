/**
 * Test step builders for `Provider.Sequence`.
 *
 * The provider implementations (`Provider.Sequence`, `Provider.Signal`,
 * `Provider.Debug`, `Provider.Failing`) and the low-level stream-part
 * helpers (`textDeltaPart`, `toolCallPart`, `reasoningDeltaPart`,
 * `finishPart`) live on / next to the `Provider` class itself in
 * `providers/provider.ts`. This module only defines the higher-level
 * scripting helpers that compose those parts into a single `SequenceStep`.
 *
 * @module
 */

import { ToolCallId } from "../domain/ids.js"
import {
  finishPart,
  type SequenceStep,
  textDeltaPart,
  toolCallPart,
} from "../providers/provider.js"

let _stepCallIdCounter = 0
const makeStepToolCallId = () => ToolCallId.make(`step-tc-${++_stepCallIdCounter}`)

export const textStep = (text: string): SequenceStep => ({
  parts: [
    textDeltaPart(text),
    finishPart({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
    }),
  ],
})

export const toolCallStep = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  parts: [
    toolCallPart(toolName, input, { toolCallId: options?.toolCallId ?? makeStepToolCallId() }),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  ],
})

export const textThenToolCallStep = (
  text: string,
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  parts: [
    textDeltaPart(text),
    toolCallPart(toolName, input, { toolCallId: options?.toolCallId ?? makeStepToolCallId() }),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) + 20 },
    }),
  ],
})

export const multiToolCallStep = (
  ...calls: ReadonlyArray<{ toolName: string; input: unknown; toolCallId?: ToolCallId }>
): SequenceStep => ({
  parts: [
    ...calls.map((call) =>
      toolCallPart(call.toolName, call.input, {
        toolCallId: call.toolCallId ?? makeStepToolCallId(),
      }),
    ),
    finishPart({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 20 * calls.length },
    }),
  ],
})
