// @effect-diagnostics nodeBuiltinImport:off — test fixture lifecycle comes from bun:test
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Record,
  Ref,
  Schema,
  Stream,
} from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter creates worker files before the child runtime starts.
import * as fs from "node:fs"
import * as os from "node:os"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter builds worker paths before the child runtime starts.
import * as path from "node:path"
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import * as AiError from "effect/unstable/ai/AiError"
import type * as AiTool from "effect/unstable/ai/Tool"
import type * as AiToolkit from "effect/unstable/ai/Toolkit"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { ToolCallId } from "../domain/ids.js"
import { ProviderError } from "../domain/errors.js"
import { CurrentResolveModelAssertion } from "../runtime/provider.js"

// ── fake-fetch ──────────────────────────────────────────────────────────────

/**
 * Shared fake-`FetchHttpClient.Fetch` capture pattern for provider-extension
 * tests. Counsel called this out as the missing piece behind the
 * "coverage theater" bug: provider-extension tests stopped at the seam
 * (sibling `layerFromRef` probes / structural layer inspection) instead
 * of driving one real request through the resolved layer and asserting
 * on the captured outbound shape.
 *
 * Use this helper to:
 *   1. Build a `Layer` that overrides `FetchHttpClient.Fetch` with a fake
 *      that captures every outbound request into a shared array.
 *   2. Run one `LanguageModel.generateText({prompt})` through any provider
 *      layer that requires `LanguageModel.LanguageModel`.
 *   3. Inspect captured request URL / method / headers / body to assert
 *      on the production wiring (auth headers, system blocks, betas, etc).
 *
 * See `tests/extensions/anthropic-extension-driver.test.ts` for the
 * reference consumer. The pattern matches the precedent at
 * `packages/extensions/src/openai.ts` (`makeOauthOpenAILayer`).
 */

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface FakeFetchState {
  captured: Array<CapturedRequest>
}

/** Build a fresh capture state. */
export const makeFakeFetchState = (): FakeFetchState => ({ captured: [] })

/**
 * Builds a fake `typeof globalThis.fetch` that captures each call into
 * `state.captured` and responds with the provided `responder` body.
 *
 * `responder` receives the captured request (same shape stored in
 * `state.captured`) so per-call response shaping is possible — e.g. 401
 * on first call, 200 on retry.
 */
type FakeFetchFn = (
  input: globalThis.RequestInfo | globalThis.URL,
  init?: globalThis.RequestInit,
) => Promise<Response>

const makeFakeFetch =
  (
    state: FakeFetchState,
    responder: (req: CapturedRequest) => {
      status: number
      headers?: Record<string, string>
      body: string
    },
  ): FakeFetchFn =>
  (input: globalThis.RequestInfo | globalThis.URL, init?: globalThis.RequestInit) => {
    let url: string
    if (Predicate.isString(input)) url = input
    else if (input instanceof URL) url = input.href
    else url = input.url

    const headers: Record<string, string> = {}
    const headerInit = init?.headers
    if (headerInit instanceof Headers) {
      headerInit.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
    } else if (Array.isArray(headerInit)) {
      for (const [k, v] of headerInit) {
        headers[k.toLowerCase()] = v
      }
    } else if (!Predicate.isUndefined(headerInit) && !Predicate.isNull(headerInit)) {
      for (const [k, v] of Object.entries(headerInit)) {
        if (Predicate.isString(v)) headers[k.toLowerCase()] = v
      }
    }

    let bodyText = Option.none<string>()
    if (Predicate.isString(init?.body)) bodyText = Option.some(init.body)
    else if (init?.body instanceof Uint8Array)
      bodyText = Option.some(new TextDecoder().decode(init.body))

    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: Option.getOrUndefined(bodyText),
    }
    state.captured.push(captured)

    const response = responder(captured)
    // oxlint-disable-next-line gent/no-runpromise-outside-boundary -- This adapter implements the Promise-based Fetch interface.
    return Effect.runPromise(
      Effect.succeed(
        new globalThis.Response(response.body, {
          status: response.status,
          headers: response.headers ?? { "content-type": "application/json" },
        }),
      ),
    )
  }

/**
 * Build a `Layer` that overrides `FetchHttpClient.Fetch` with a fake
 * that captures into `state` and replies via `responder`.
 */
export const fakeFetchLayer = (
  state: FakeFetchState,
  responder: (req: CapturedRequest) => {
    status: number
    headers?: Record<string, string>
    body: string
  },
): Layer.Layer<never, never, never> =>
  Layer.succeed(
    FetchHttpClient.Fetch,
    Object.assign(makeFakeFetch(state, responder), { preconnect: () => {} }),
  )

/**
 * Build the Effect that drives one `LanguageModel.generateText({prompt})`
 * through `layer` with `FetchHttpClient.Fetch` overridden to capture into
 * `state` and reply via `responder`. The returned Effect is scoped — run
 * it via `Effect.runPromise(program)` (or your test runner's equivalent).
 *
 * Kept as an Effect (not Promise) so callers can compose with
 * `Effect.either`, `TestClock`, or any other Effect-native test plumbing.
 */
export const oneGenerate = (
  layer: Layer.Layer<LanguageModel.LanguageModel>,
  state: FakeFetchState,
  responder: (req: CapturedRequest) => {
    status: number
    headers?: Record<string, string>
    body: string
  },
  prompt: string = "hi",
): Effect.Effect<void> =>
  LanguageModel.generateText({ prompt }).pipe(
    Effect.asVoid,
    // @effect-diagnostics-next-line strictEffectProvide:off test entry point
    Effect.provide(Layer.provideMerge(layer, fakeFetchLayer(state, responder))),
    Effect.scoped,
    Effect.catchCause((cause) => Effect.die(cause)),
  )

// ── fixtures ────────────────────────────────────────────────────────────────

/** Shared test fixtures for integration tests across packages. */

/** Create a temp directory that is removed when the test scope closes. */
export const makeTempDirectoryScoped = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), prefix))),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  )

/** Create a worker environment with data dir, auth files, and provider mode */
export const createWorkerEnv = (root: string, providerMode?: string): Record<string, string> => {
  const dataDir = path.join(root, "data")
  fs.mkdirSync(dataDir, { recursive: true })

  const env = Record.empty<string, string>()
  env["GENT_DATA_DIR"] = dataDir
  if (!Predicate.isUndefined(providerMode)) env["GENT_PROVIDER_MODE"] = providerMode
  env["GENT_AUTH_DIRECTORY"] = path.join(root, "auth")
  return env
}

class WaitForError extends Schema.TaggedError<WaitForError>()(
  "@gent/core-internal/test-utils/fixtures/WaitForError",
  { message: Schema.String },
) {}

// oxlint-disable-next-line effect/noUnknownParameters -- Cause.squash exposes an unknown defect at this test failure boundary.
const toWaitForError = (error: unknown) => {
  if (error instanceof Error) return new WaitForError({ message: error.message })
  return new WaitForError({ message: String(error) })
}

/** Poll an effect until predicate passes or timeout */
export const waitFor = <A, R = never>(
  effect: Effect.Effect<A, unknown, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 5_000,
  label = "condition",
): Effect.Effect<A, WaitForError, R> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
    const loop: Effect.Effect<A, WaitForError, R> = Effect.gen(function* () {
      const attempt = yield* effect.pipe(Effect.exit)
      if (attempt._tag === "Success" && predicate(attempt.value)) {
        return attempt.value
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        let errorMessage = `timed out waiting for ${label}`
        if (attempt._tag === "Failure") {
          errorMessage += `: ${toWaitForError(Cause.squash(attempt.cause)).message}`
        }
        return yield* new WaitForError({ message: errorMessage })
      }
      yield* Effect.sleep("5 millis")
      return yield* loop
    })
    return yield* loop
  })

// ── language-model ──────────────────────────────────────────────────────────

type LanguageModelToolMap = Record<string, AiTool.Any>
export type LanguageModelStreamPart<Tools extends LanguageModelToolMap = LanguageModelToolMap> =
  Response.StreamPart<Tools>

interface SignalLanguageModelControls {
  readonly emitNext: Effect.Effect<void>
  readonly emitAll: Effect.Effect<void>
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

interface SequenceLanguageModelControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: Effect.Effect<void>
}

let _streamPartIdCounter = 0
const makeStreamPartId = (prefix: string) => `${prefix}-${++_streamPartIdCounter}`

export const textDeltaPart = (
  text: string,
  id = makeStreamPartId("text"),
): LanguageModelStreamPart => Response.makePart("text-delta", { id, delta: text })

export const toolCallPart = (
  toolName: string,
  // oxlint-disable-next-line effect/noUnknownParameters -- Tool arguments enter the Effect AI codec as unknown JSON data.
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
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        uncached: undefined,
        total: params.usage?.inputTokens,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        cacheRead: undefined,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        cacheWrite: undefined,
      },
      outputTokens: {
        total: params.usage?.outputTokens,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        text: undefined,
        // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent token count in this wire fixture.
        reasoning: undefined,
      },
    }),
    // oxlint-disable-next-line effect/noNullish -- Effect AI requires the absent response in this wire fixture.
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
  if (Predicate.isUndefined(latest)) return ""
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

const makeLanguageModelLayer = (params: {
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
        let retryBudget = 0
        if (retries) retryBudget = retryBudgetFor(latestUserText)

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

/**
 * A model that finishes every step having produced nothing — no text, no
 * tool calls. Real providers are trained not to do this on request, so a
 * live prompt cannot reproduce the unanswered turn; this layer can, in a
 * real process, through `Gent.provider.mock({ empty: true })`.
 */
let emptyCache = Option.none<Layer.Layer<LanguageModel.LanguageModel>>()
const empty = () => {
  if (Option.isNone(emptyCache)) {
    const layer = makeLanguageModelLayer({
      streamText: () =>
        Stream.make(
          finishPart({ finishReason: "stop", usage: { inputTokens: 1, outputTokens: 0 } }),
        ),
      generateText: () => Effect.succeed(""),
    })
    emptyCache = Option.some(layer)
    return layer
  }
  return emptyCache.value
}

let failingCache = Option.none<Layer.Layer<LanguageModel.LanguageModel>>()
const failing = () => {
  if (Option.isNone(failingCache)) {
    const layer = makeLanguageModelLayer({
      streamText: () => Stream.fail(aiError("Failing.streamText", "provider exploded")),
      generateText: () => Effect.fail(aiError("Failing.generateText", "provider exploded")),
    })
    failingCache = Option.some(layer)
    return layer
  }
  return failingCache.value
}

const signal = (reply: string, options?: { inputTokens?: number; outputTokens?: number }) =>
  Effect.gen(function* () {
    const gate = yield* Queue.unbounded<"continue">()
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
      emitNext: Queue.offer(gate, "continue").pipe(Effect.asVoid),
      emitAll: Effect.forEach(allParts, () => Queue.offer(gate, "continue").pipe(Effect.asVoid)),
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
      if (step.gated || Predicate.isUndefined(gate)) return Effect.void
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

          if (!Predicate.isUndefined(started)) yield* Deferred.succeed(started, void 0)

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

          if (!Predicate.isUndefined(gate)) {
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
        if (Predicate.isUndefined(step?.assertRequest)) return
        yield* Effect.try({
          try: () => {
            const model = String(request.modelId)
            if (!Predicate.isUndefined(request.hints?.reasoning)) {
              return step.assertRequest?.({ model, reasoning: request.hints.reasoning })
            }
            return step.assertRequest?.({ model })
          },
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
        if (index < 0 || index >= steps.length || Predicate.isUndefined(deferred)) {
          return Effect.die(
            new Error(`waitForCall: index ${index} out of range [0, ${steps.length})`),
          )
        }
        return Deferred.await(deferred)
      },
      emitAll: (index) => {
        const deferred = emitGates[index]
        if (index < 0 || index >= steps.length || Predicate.isUndefined(deferred)) {
          return Effect.die(new Error(`emitAll: index ${index} out of range [0, ${steps.length})`))
        }
        return Deferred.succeed(deferred, void 0)
      },
      callCount: Ref.get(indexRef),
      assertDone: Effect.gen(function* () {
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
  get empty() {
    return empty()
  },
  get failing() {
    return failing()
  },
  sequence,
  signal,
}

// ── sequence-steps ──────────────────────────────────────────────────────────

/**
 * Test step builders for scripted language-model sequences.
 *
 * `language-model` owns the low-level Effect AI stream-part helpers and
 * language-model layers. This module composes those parts into single
 * `SequenceStep`s.
 *
 * @module
 */

let _stepCallIdCounter = 0
const makeStepToolCallId = () => ToolCallId.make(`step-tc-${++_stepCallIdCounter}`)
type DebugValue = Schema.Schema.Type<typeof Schema.Unknown>

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
  input: DebugValue,
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
  input: DebugValue,
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
  ...calls: ReadonlyArray<{ toolName: string; input: DebugValue; toolCallId?: ToolCallId }>
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
