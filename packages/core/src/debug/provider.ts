import { Deferred, Duration, Effect, Layer, Queue, Ref, Stream } from "effect"
import {
  FinishChunk,
  Provider,
  ProviderError,
  TextChunk,
  ToolCallChunk,
  type StreamChunk,
  type GenerateRequest,
  type ProviderRequest,
} from "../providers/provider.js"
import type { ToolCallId } from "../domain/ids.js"
import type { Message, TextPart } from "../domain/message.js"

const extractLatestUserText = (messages: ReadonlyArray<Message>): string => {
  const latest = [...messages].reverse().find((message) => message.role === "user")
  if (latest === undefined) return ""
  return latest.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

const retryBudgetFor = (text: string): number => {
  if (text.trim().length === 0) return 0
  const hash = [...text].reduce((total, ch) => total + ch.charCodeAt(0), 0)
  if (hash % 3 === 0) return 2
  if (hash % 2 === 0) return 1
  return 0
}

const buildReply = (request: ProviderRequest, latestUserText: string): string => {
  const lineCount = latestUserText.split("\n").filter((line) => line.trim().length > 0).length
  const modelLabel = request.model.startsWith("openai/") ? "reviewer" : "cowork"

  if (lineCount > 1) {
    return [
      `${modelLabel} processed a merged queued turn.`,
      `Received ${lineCount} lines in one message block.`,
      `Tail: ${latestUserText.split("\n").at(-1) ?? latestUserText}`,
    ].join(" ")
  }

  return [
    `${modelLabel} debug response.`,
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted provider.",
  ].join(" ")
}

const makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const chunks = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const stream = Stream.fromIterable([
    ...chunks.map((text) => new TextChunk({ text: `${text} ` })),
    new FinishChunk({
      finishReason: "stop",
      usage: {
        inputTokens: Math.max(1, Math.ceil(latestUserText.length / 4)),
        outputTokens: Math.max(1, Math.ceil(reply.length / 4)),
      },
    }),
  ])

  if (delayMs <= 0) return stream

  return stream.pipe(
    Stream.flatMap((chunk) =>
      Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(chunk))),
    ),
  )
}

export const DebugProvider = (options?: { delayMs?: number; retries?: boolean }) =>
  Layer.effect(
    Provider,
    Effect.sync(() => {
      const delayMs = options?.delayMs ?? 0
      const retries = options?.retries ?? delayMs === 0
      const attempts = new Map<string, number>()

      const stream = (request: ProviderRequest) =>
        Effect.suspend(() => {
          const latestUserText = extractLatestUserText(request.messages)
          const key = `${request.model}:${latestUserText}`
          const seen = attempts.get(key) ?? 0
          const retryBudget = retries ? retryBudgetFor(latestUserText) : 0

          if (seen < retryBudget) {
            attempts.set(key, seen + 1)
            return Effect.fail(
              new ProviderError({
                message: "Rate limit exceeded (429)",
                model: request.model,
              }),
            )
          }

          attempts.delete(key)
          const reply = buildReply(request, latestUserText)
          return Effect.succeed(makeReplyStream(latestUserText, reply, delayMs))
        })

      const generate = (_request: GenerateRequest) => Effect.succeed("debug scenario")

      return {
        stream,
        generate,
      }
    }),
  )

export const DebugFailingProvider = Layer.succeed(Provider, {
  stream: (request) =>
    Effect.fail(
      new ProviderError({
        message: "provider exploded",
        model: request.model,
      }),
    ),
  generate: () => Effect.succeed("debug failure"),
})

// =============================================================================
// Signal-based provider — test controls when chunks emit
// =============================================================================

export interface SignalProviderControls {
  /** Emit the next queued chunk. Resolves when the chunk is consumed. */
  readonly emitNext: () => Effect.Effect<void>
  /** Emit all remaining chunks + finish. */
  readonly emitAll: () => Effect.Effect<void>
  /** Signal that the stream setup has started (provider.stream was called). */
  readonly waitForStreamStart: Effect.Effect<void>
}

/**
 * Creates a Provider layer where chunk emission is controlled by explicit signals.
 *
 * Usage:
 * ```ts
 * const { layer, controls } = createSignalProvider("hello world")
 * // ... provide layer to test ...
 * yield* controls.waitForStreamStart // stream is open, "thinking" state is visible
 * yield* controls.emitNext()         // emit first text chunk
 * yield* controls.emitAll()          // emit rest + finish
 * ```
 */
export const createSignalProvider = (
  reply: string,
  options?: { inputTokens?: number; outputTokens?: number },
) =>
  Effect.gen(function* () {
    const gate = yield* Queue.unbounded<null>()
    const streamStarted = yield* Deferred.make<void>()

    const chunks = reply
      .split(/(?<=[.!?])\s+/)
      .filter((chunk) => chunk.length > 0)
      .map((text) => new TextChunk({ text: `${text} ` }))

    const finishChunk = new FinishChunk({
      finishReason: "stop",
      usage: {
        inputTokens: options?.inputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
        outputTokens: options?.outputTokens ?? Math.max(1, Math.ceil(reply.length / 4)),
      },
    })

    const allChunks = [...chunks, finishChunk]

    const layer = Layer.succeed(Provider, {
      stream: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, void 0)
          return Stream.fromIterable(allChunks).pipe(
            Stream.mapEffect((chunk) => Queue.take(gate).pipe(Effect.as(chunk))),
          )
        }),
      generate: () => Effect.succeed(reply),
    })

    const controls: SignalProviderControls = {
      emitNext: () => Queue.offer(gate, null).pipe(Effect.asVoid),
      emitAll: () => Effect.forEach(allChunks, () => Queue.offer(gate, null).pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

// =============================================================================
// Sequence provider — scripted multi-turn provider with per-call gates
// =============================================================================

/** A single scripted turn: the chunks the provider should emit when stream() is called. */
export interface SequenceStep {
  /** Chunks to emit for this turn. Use step builders to construct. */
  readonly chunks: ReadonlyArray<StreamChunk>
  /** Optional assertion on the incoming request. Throwing fails the stream. */
  readonly assertRequest?: (request: ProviderRequest) => void
  /**
   * When true, chunks are held behind a gate until `controls.emitAll(index)` is called.
   * Default: false (chunks emit immediately).
   */
  readonly gated?: boolean
}

export interface SequenceProviderControls {
  /** Resolves when stream() call #index has started (0-based). */
  readonly waitForCall: (index: number) => Effect.Effect<void>
  /** Release gated chunks for call #index. No-op if step is not gated. */
  readonly emitAll: (index: number) => Effect.Effect<void>
  /** Current number of stream() calls that have started. */
  readonly callCount: Effect.Effect<number>
  /** Fails if there are unconsumed steps remaining. */
  readonly assertDone: () => Effect.Effect<void>
}

/**
 * Creates a Provider layer that replays a scripted sequence of turns.
 *
 * Each call to `provider.stream()` consumes the next step in order.
 * Extra calls beyond the scripted steps fail immediately.
 *
 * Usage:
 * ```ts
 * const { layer, controls } = yield* createSequenceProvider([
 *   toolCallStep("auto_checkpoint", { status: "continue" }),
 *   textStep("counsel response"),
 *   toolCallStep("auto_checkpoint", { status: "complete" }),
 * ])
 * ```
 */
export const createSequenceProvider = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)

    // Per-step deferreds: call-started signals + emission gates
    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    // Pre-resolve gates for non-gated steps
    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (!step.gated && gate) return Deferred.succeed(gate, void 0)
      return Effect.void
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

          // Signal that this call has started
          if (started) yield* Deferred.succeed(started, void 0)

          // Run optional request assertion
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

          // Wait for gate (already resolved for non-gated steps)
          if (gate) {
            return Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.fromIterable(step?.chunks ?? [])),
            )
          }
          return Stream.fromIterable(step?.chunks ?? [])
        }),
      generate: () => Effect.succeed("sequence provider"),
    })

    const controls: SequenceProviderControls = {
      waitForCall: (index) => {
        const deferred = callStarted[index]
        if (index < 0 || index >= steps.length || !deferred) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },

      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || !deferred) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },

      callCount: Ref.get(indexRef),

      assertDone: () =>
        Effect.gen(function* () {
          const consumed = yield* Ref.get(indexRef)
          if (consumed < steps.length) {
            return yield* Effect.die(
              new Error(
                `Sequence provider: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
              ),
            )
          }
        }),
    }

    return { layer, controls }
  })

// =============================================================================
// Step builders — construct SequenceStep chunks from high-level descriptions
// =============================================================================

let stepCallIdCounter = 0

const makeStepToolCallId = () => `step-tc-${++stepCallIdCounter}` as ToolCallId

/** A turn that emits a single text response and finishes with "stop". */
export const textStep = (text: string): SequenceStep => ({
  chunks: [
    new TextChunk({ text }),
    new FinishChunk({
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
    }),
  ],
})

/** A turn that emits a single tool call and finishes with "tool_calls". */
export const toolCallStep = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  chunks: [
    new ToolCallChunk({
      toolCallId: options?.toolCallId ?? makeStepToolCallId(),
      toolName,
      input,
    }),
    new FinishChunk({
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 20 },
    }),
  ],
})

/** A turn that emits text before a tool call. */
export const textThenToolCallStep = (
  text: string,
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): SequenceStep => ({
  chunks: [
    new TextChunk({ text }),
    new ToolCallChunk({
      toolCallId: options?.toolCallId ?? makeStepToolCallId(),
      toolName,
      input,
    }),
    new FinishChunk({
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: Math.max(1, Math.ceil(text.length / 4)) + 20 },
    }),
  ],
})

/** A turn that emits multiple tool calls and finishes with "tool_calls". */
export const multiToolCallStep = (
  ...calls: ReadonlyArray<{ toolName: string; input: unknown; toolCallId?: ToolCallId }>
): SequenceStep => ({
  chunks: [
    ...calls.map(
      (c) =>
        new ToolCallChunk({
          toolCallId: c.toolCallId ?? makeStepToolCallId(),
          toolName: c.toolName,
          input: c.input,
        }),
    ),
    new FinishChunk({
      finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 20 * calls.length },
    }),
  ],
})
