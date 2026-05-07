import { Deferred, Duration, Effect, Layer, Queue, Ref, Stream, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import * as AiError from "effect/unstable/ai/AiError"
import type * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "../domain/ids.js"
import { ProviderError } from "../domain/provider-error.js"
import { CurrentResolveModelAssertion } from "../providers/model-resolver.js"

export type LanguageModelToolMap = Record<string, AiTool.Any>
export type LanguageModelStreamPart<Tools extends LanguageModelToolMap = LanguageModelToolMap> =
  Response.StreamPart<Tools>

export interface SignalLanguageModelControls {
  readonly emitNext: () => Effect.Effect<void>
  readonly emitAll: () => Effect.Effect<void>
  readonly waitForStreamStart: Effect.Effect<void>
}

export interface SequenceStep {
  readonly parts: ReadonlyArray<LanguageModelStreamPart>
  readonly assertRequest?: (request: {
    readonly model: string
    readonly reasoning?: string
  }) => void
  readonly assertOptions?: (options: ProviderOptions) => void
  readonly gated?: boolean
}

export interface SequenceLanguageModelControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: () => Effect.Effect<void>
}

export const DebugSlowLanguageModelDelayMs = 250

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (
  text: string,
  id = makeStreamPartId("text"),
): LanguageModelStreamPart => Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  input: unknown,
  options?: { toolCallId?: ToolCallId },
): LanguageModelStreamPart =>
  Response.makePart("tool-call", {
    id: options?.toolCallId ?? ToolCallId.make(makeStreamPartId("tool")),
    name: toolName,
    params: input,
    providerExecuted: false,
  })

export const reasoningDeltaPart = (
  text: string,
  id = makeStreamPartId("reasoning"),
): LanguageModelStreamPart => Response.makePart("reasoning-delta", { id, delta: text })

export const finishPart = (params: {
  finishReason: Response.FinishReason
  usage?: { inputTokens: number; outputTokens: number }
}): LanguageModelStreamPart =>
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

const makeEncodingToolkit = <Tools extends Record<string, AiTool.Any>>(
  tools: Tools,
): AiToolkit.WithHandler<Tools> => ({
  tools,
  handle: (name) =>
    Effect.fail(
      AiError.make({
        module: "LanguageModelLayers",
        method: "makeEncodingToolkit.handle",
        reason: new AiError.ToolConfigurationError({
          toolName: String(name),
          description: "language model response encoding does not execute tool handlers",
        }),
      }),
    ),
})

const toolkitFromProviderOptions = (
  options: ProviderOptions,
): AiToolkit.WithHandler<LanguageModelToolMap> => {
  const toolsRecord: LanguageModelToolMap = {}
  for (const tool of options.tools) {
    toolsRecord[tool.name] = tool
  }
  return makeEncodingToolkit(toolsRecord)
}

const encodePart = (
  options: ProviderOptions,
  part: Response.Part<LanguageModelToolMap>,
): Response.PartEncoded =>
  Schema.encodeUnknownSync(Response.Part(toolkitFromProviderOptions(options)))(part)

const encodeStreamPart = (
  options: ProviderOptions,
  part: LanguageModelStreamPart,
): Response.StreamPartEncoded =>
  Schema.encodeUnknownSync(Response.StreamPart(toolkitFromProviderOptions(options)))(part)

const aiError = (method: string, message: string) =>
  AiError.make({
    module: "LanguageModelLayers",
    method,
    reason: new AiError.UnknownError({ description: message }),
  })

const extractLatestUserText = (promptInput: Prompt.RawInput): string => {
  const latest = [...Prompt.make(promptInput).content]
    .reverse()
    .find((message) => message.role === "user")
  if (latest === undefined) return ""
  return latest.content
    .filter((part): part is Prompt.TextPart => part.type === "text")
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

const buildReply = (latestUserText: string): string => {
  const lineCount = latestUserText.split("\n").filter((line) => line.trim().length > 0).length
  if (lineCount > 1) {
    return [
      "cowork processed a merged queued turn.",
      `Received ${lineCount} lines in one message block.`,
      `Tail: ${latestUserText.split("\n").at(-1) ?? latestUserText}`,
    ].join(" ")
  }

  return [
    "cowork debug response.",
    `Latest user message: ${latestUserText || "(empty)"}.`,
    "This turn is flowing through the real agent loop with a scripted language model.",
  ].join(" ")
}

const makeReplyStream = (latestUserText: string, reply: string, delayMs = 0) => {
  const parts = reply.split(/(?<=[.!?])\s+/).filter((chunk) => chunk.length > 0)
  const stream = Stream.fromIterable([
    ...parts.map((text) => textDeltaPart(`${text} `)),
    finishPart({
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

export const makeLanguageModelLayer = (params: {
  readonly streamText: (
    options: ProviderOptions,
  ) => Stream.Stream<LanguageModelStreamPart, AiError.AiError>
  readonly generateText: (options: ProviderOptions) => Effect.Effect<string, AiError.AiError>
}): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        params
          .generateText(options)
          .pipe(Effect.map((text) => [encodePart(options, Response.makePart("text", { text }))])),
      streamText: (options) =>
        params.streamText(options).pipe(Stream.map((part) => encodeStreamPart(options, part))),
    }),
  )

const testStream = (
  stream: (
    options: ProviderOptions,
  ) => Effect.Effect<Stream.Stream<LanguageModelStreamPart, AiError.AiError>, AiError.AiError>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  makeLanguageModelLayer({
    streamText: (options) => stream(options).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("test response"),
  })

const debug = (options?: { delayMs?: number; retries?: boolean }) => {
  const delayMs = options?.delayMs ?? 0
  const retries = options?.retries ?? delayMs === 0
  const attempts = new Map<string, number>()

  return makeLanguageModelLayer({
    streamText: (modelOptions) =>
      Effect.suspend(() => {
        const latestUserText = extractLatestUserText(modelOptions.prompt)
        const seen = attempts.get(latestUserText) ?? 0
        const retryBudget = retries ? retryBudgetFor(latestUserText) : 0

        if (seen < retryBudget) {
          attempts.set(latestUserText, seen + 1)
          return Effect.fail(aiError("Debug.streamText", "Rate limit exceeded (429)"))
        }

        attempts.delete(latestUserText)
        return Effect.succeed(makeReplyStream(latestUserText, buildReply(latestUserText), delayMs))
      }).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("debug scenario"),
  })
}

let failingCache: Layer.Layer<LanguageModel.LanguageModel> | undefined
const failing = () => {
  if (failingCache === undefined) {
    failingCache = makeLanguageModelLayer({
      streamText: () => Stream.fail(aiError("Failing.streamText", "provider exploded")),
      generateText: () => Effect.fail(aiError("Failing.generateText", "provider exploded")),
    })
  }
  return failingCache
}

const signal = (reply: string, options?: { inputTokens?: number; outputTokens?: number }) =>
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

    const layer = makeLanguageModelLayer({
      streamText: () =>
        Stream.fromEffect(Deferred.succeed(streamStarted, void 0)).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable(allParts).pipe(
              Stream.mapEffect((part) => Queue.take(gate).pipe(Effect.as(part))),
            ),
          ),
        ),
      generateText: () => Effect.succeed(reply),
    })

    const controls: SignalLanguageModelControls = {
      emitNext: () => Queue.offer(gate, null).pipe(Effect.asVoid),
      emitAll: () => Effect.forEach(allParts, () => Queue.offer(gate, null).pipe(Effect.asVoid)),
      waitForStreamStart: Deferred.await(streamStarted),
    }

    return { layer, controls }
  })

const sequence = (steps: ReadonlyArray<SequenceStep>) =>
  Effect.gen(function* () {
    const indexRef = yield* Ref.make(0)
    const requestIndexRef = yield* Ref.make(0)
    const callStarted = yield* Effect.forEach(steps, () => Deferred.make<void>())
    const emitGates = yield* Effect.forEach(steps, () => Deferred.make<void>())

    yield* Effect.forEach(steps, (step, i) => {
      const gate = emitGates[i]
      if (step.gated || gate === undefined) return Effect.void
      return Deferred.succeed(gate, void 0)
    })

    const languageModelLayer = makeLanguageModelLayer({
      streamText: (options) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(indexRef, (n) => n + 1)

          if (idx >= steps.length) {
            return yield* aiError(
              "Sequence.streamText",
              `Sequence language model: streamText() called ${idx + 1} times but only ${steps.length} steps scripted`,
            )
          }

          const step = steps[idx] ?? steps[0]
          const started = callStarted[idx] ?? callStarted[0]
          const gate = emitGates[idx] ?? emitGates[0]

          if (started !== undefined) yield* Deferred.succeed(started, void 0)

          if (step?.assertOptions) {
            yield* Effect.try({
              try: () => step.assertOptions?.(options),
              catch: (e) =>
                aiError(
                  "Sequence.streamText",
                  `Sequence language model: assertOptions failed at step ${idx}: ${e}`,
                ),
            })
          }

          if (gate !== undefined) {
            return Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() => Stream.fromIterable(step?.parts ?? [])),
            )
          }
          return Stream.fromIterable(step?.parts ?? [])
        }).pipe(Stream.unwrap),
      generateText: () => Effect.succeed("sequence language model"),
    })
    const requestAssertionLayer = Layer.succeed(CurrentResolveModelAssertion, (request) =>
      Effect.gen(function* () {
        const idx = yield* Ref.getAndUpdate(requestIndexRef, (n) => n + 1)
        const step = steps[idx] ?? steps[0]
        if (step?.assertRequest === undefined) return
        yield* Effect.try({
          try: () =>
            step.assertRequest?.({
              model: String(request.modelId),
              ...(request.hints?.reasoning !== undefined
                ? { reasoning: request.hints.reasoning }
                : {}),
            }),
          catch: (e) =>
            new ProviderError({
              message: `Sequence language model: assertRequest failed at step ${idx}: ${e}`,
              model: request.modelId,
              cause: e,
            }),
        })
      }),
    )
    const layer = Layer.merge(languageModelLayer, requestAssertionLayer)

    const controls: SequenceLanguageModelControls = {
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
              `Sequence language model: ${steps.length - consumed} unconsumed steps (consumed ${consumed}/${steps.length})`,
            ),
          )
        }),
    }

    return { layer, controls }
  })

export const LanguageModelLayers = {
  testStream,
  debug,
  get failing() {
    return failing()
  },
  sequence,
  signal,
}
