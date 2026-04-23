/**
 * Debug / test provider helpers.
 *
 * Production provider runtime lives in `providers/provider.ts`.
 * Test scripting and fake stream builders live here.
 *
 * @module
 */

import { Deferred, Effect, Layer, Queue, Ref, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import type * as AiTool from "effect/unstable/ai/Tool"
import { ToolCallId } from "../domain/ids.js"
import { Provider, ProviderError, type ProviderRequest } from "../providers/provider.js"

export type ProviderStreamPart = Response.StreamPart<Record<string, AiTool.Any>>
export interface SignalProviderControls {
  readonly emitNext: () => Effect.Effect<void>
  readonly emitAll: () => Effect.Effect<void>
  readonly waitForStreamStart: Effect.Effect<void>
}
export interface SequenceStep {
  readonly parts: ReadonlyArray<ProviderStreamPart>
  readonly assertRequest?: (request: ProviderRequest) => void
  readonly gated?: boolean
}
export interface SequenceProviderControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: () => Effect.Effect<void>
}

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
    id: options?.toolCallId ?? ToolCallId.make(makeStreamPartId("tool")),
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

export const createSignalProvider = (
  reply: string,
  options?: { inputTokens?: number; outputTokens?: number },
) =>
  Effect.gen(function* () {
    const gate = yield* Queue.unbounded<null>()
    const streamStarted = yield* Deferred.make<void>()

    const parts = reply
      .split(/(?<=[.!?])\s+/)
      .filter((chunk) => chunk.length > 0)
      .map((text) => textDeltaPart(`${text} `))

    const allParts = [
      ...parts,
      finishPart({
        finishReason: "stop",
        usage: {
          inputTokens: options?.inputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
          outputTokens: options?.outputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
        },
      }),
    ]

    const layer = Layer.succeed(Provider, {
      stream: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
          return Stream.fromIterable(allParts).pipe(
            Stream.mapEffect((part) => Queue.take(gate).pipe(Effect.as(part))),
          )
        }),
      generate: () => Effect.succeed(reply),
    })

    const controls: SignalProviderControls = {
      emitNext: () => Queue.offer(gate, null).pipe(Effect.asVoid),
      emitAll: () => Effect.forEach(allParts, () => Queue.offer(gate, null).pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

export const createSequenceProvider = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)

    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (step.gated || gate === undefined) return Effect.void
      return Deferred.succeed(gate, void 0)
    })

    const layer = Layer.succeed(Provider, {
      stream: (request: ProviderRequest) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(indexRef, (n) => n + 1)

          if (idx >= steps.length) {
            return yield* new ProviderError({
              message: `Sequence provider: stream() called ${idx + 1} times but only ${steps.length} steps scripted`,
              model: request.model,
            })
          }

          const step = steps[idx] ?? steps[0]
          const started = callStarted[idx] ?? callStarted[0]
          const gate = emitGates[idx] ?? emitGates[0]

          if (started !== undefined) yield* Deferred.succeed(started, void 0)

          if (step?.assertRequest) {
            yield* Effect.try({
              try: () => step.assertRequest?.(request),
              catch: (e) =>
                new ProviderError({
                  message: `Sequence provider: assertRequest failed at step ${idx}: ${e}`,
                  model: request.model,
                }),
            })
          }

          if (gate !== undefined) {
            return Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.fromIterable(step?.parts ?? [])),
            )
          }
          return Stream.fromIterable(step?.parts ?? [])
        }),
      generate: () => Effect.succeed("sequence provider"),
    })

    const controls: SequenceProviderControls = {
      waitForCall: (index) => {
        const deferred = callStarted[index]
        if (index < 0 || index >= steps.length || deferred === undefined) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },

      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || deferred === undefined) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },

      callCount: Ref.get(indexRef),

      assertDone: () =>
        Effect.gen(function* () {
          const consumed = yield* Ref.get(indexRef)
          if (consumed >= steps.length) return
          return yield* Effect.die(
            new Error(
              `Sequence provider: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
            ),
          )
        }),
    }

    return { layer, controls }
  })

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

// Re-export under legacy names for backwards compat with existing imports
/** @deprecated Use `Provider.Debug()` */
export const DebugProvider = Provider.Debug

/** @deprecated Use `Provider.Failing` */
export const DebugFailingProvider = Provider.Failing

/** @deprecated Use `createSignalProvider(...)` */
export const SignalProvider = createSignalProvider

/** @deprecated Use `createSequenceProvider(...)` */
export const SequenceProvider = createSequenceProvider
