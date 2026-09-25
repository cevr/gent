// @effect-diagnostics nodeBuiltinImport:off — test fixture lifecycle comes from bun:test
import {
  Cause,
  Clock,
  Context,
  Deferred,
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
import { BunServices } from "@effect/platform-bun"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter creates worker files before the child runtime starts.
import * as fs from "node:fs"
import * as os from "node:os"
// oxlint-disable-next-line effect/noNodeBuiltinImport -- This synchronous fixture adapter builds worker paths before the child runtime starts.
import * as path from "node:path"
import type { ProviderOptions } from "effect/unstable/ai/LanguageModel"
import type * as AiError from "effect/unstable/ai/AiError"
import type * as Prompt from "effect/unstable/ai/Prompt"
import { ProviderStopReason, reportProviderStopReason } from "../domain/driver.js"
import { omitUndefined } from "../domain/guards.js"
import { ToolCallId } from "../domain/ids.js"
import { ProviderError } from "../domain/errors.js"
import {
  aiError,
  Auth,
  AuthApi,
  ModelResolver,
  type ResolveModelRequest,
  finishPart,
  type LanguageModelStreamPart,
  makeLanguageModelLayer,
  ScriptedLanguageModel,
  textDeltaPart,
  toolCallPart,
} from "../runtime/provider.js"

// ── fake-fetch ──────────────────────────────────────────────────────────────

/**
 * Shared fake-`FetchHttpClient.Fetch` capture pattern for provider-extension
 * tests: drive one real request through the resolved layer and assert on the
 * captured outbound shape, not on the layer's structure.
 *
 * Use this helper to:
 *   1. Build a `Layer` that overrides `FetchHttpClient.Fetch` with a fake
 *      that captures every outbound request into a shared array.
 *   2. Run one `LanguageModel.generateText({prompt})` through any provider
 *      layer that requires `LanguageModel.LanguageModel`.
 *   3. Inspect captured request URL / method / headers / body to assert
 *      on the production wiring (auth headers, system blocks, betas, etc).
 *
 * The driver tests in `packages/extensions/tests/` (`anthropic.test.ts`,
 * `openai.test.ts`, `providers.test.ts`) are its consumers.
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
 * on first call, 200 on retry. A responder that returns an Effect runs it
 * before the response resolves, so a test can change the world while a
 * request is in flight.
 */
type FakeFetchFn = (
  input: globalThis.RequestInfo | globalThis.URL,
  init?: globalThis.RequestInit,
) => Promise<Response>

interface FakeResponse {
  status: number
  headers?: Record<string, string>
  body: string
}

type FakeResponder = (req: CapturedRequest) => FakeResponse | Effect.Effect<FakeResponse>

const asEffect = (
  answer: FakeResponse | Effect.Effect<FakeResponse>,
): Effect.Effect<FakeResponse> => {
  if (Effect.isEffect(answer)) return answer
  return Effect.succeed(answer)
}

const makeFakeFetch =
  (state: FakeFetchState, responder: FakeResponder): FakeFetchFn =>
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

    // oxlint-disable-next-line gent/no-runpromise-outside-boundary -- This adapter implements the Promise-based Fetch interface.
    return Effect.runPromise(
      Effect.map(
        asEffect(responder(captured)),
        (reply) =>
          new globalThis.Response(reply.body, {
            status: reply.status,
            headers: reply.headers ?? { "content-type": "application/json" },
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
  responder: FakeResponder,
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
  prompt: Prompt.RawInput = "hi",
): Effect.Effect<void> =>
  LanguageModel.generateText({ prompt }).pipe(
    Effect.asVoid,
    // @effect-diagnostics-next-line strictEffectProvide:off test entry point
    Effect.provide(Layer.provideMerge(layer, fakeFetchLayer(state, responder))),
    Effect.scoped,
    Effect.catchCause((cause) => Effect.die(cause)),
  )

/**
 * Run `effect` as a loop step does, listening for the raw stop reason a
 * driver reports (`ProviderStopReason`); returns the last one reported.
 */
export const captureProviderStopReason = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<string>, E, Exclude<R, ProviderStopReason>> =>
  Effect.gen(function* () {
    const reported = yield* Ref.make(Option.none<string>())
    yield* effect.pipe(
      Effect.provideService(
        ProviderStopReason,
        ProviderStopReason.of({ report: (reason) => Ref.set(reported, Option.some(reason)) }),
      ),
    )
    return yield* Ref.get(reported)
  })

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

/**
 * Store a test API key for anthropic and openai in `directory`, the auth
 * store a spawned gent reads through `GENT_AUTH_DIRECTORY` (see
 * `createWorkerEnv`), so the child starts without asking for a key.
 */
export const seedAuthKeys = (directory: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(Auth.Live(directory).pipe(Layer.provide(BunServices.layer)))
    const auth = Context.get(services, Auth)
    yield* auth.set("anthropic", AuthApi.make({ type: "api", key: "test-key" }))
    yield* auth.set("openai", AuthApi.make({ type: "api", key: "test-key" }))
  }).pipe(Effect.scoped)

class WaitForError extends Schema.TaggedError<WaitForError>()(
  "@gent/core/src/test-utils/language-model/WaitForError",
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
      // gent/no-sleep: allow the poll interval of waitFor, the helper the rule points tests to
      yield* Effect.sleep("5 millis")
      return yield* loop
    })
    return yield* loop
  })

// ── request shape ───────────────────────────────────────────────────────────

/**
 * A step's request as the runtime builds it: the system prompt it opens
 * with (its cache blocks, and the blocks joined as the one prompt text), and
 * the turn notices it places after the conversation (empty when the step
 * carries none).
 */
export const turnRequestText = (prompt: Prompt.Prompt) => {
  const systemAt = (index: number) =>
    Option.fromUndefinedOr(prompt.content[index]).pipe(
      Option.flatMap((message) => {
        if (message.role !== "system") return Option.none()
        return Option.some(message.content)
      }),
    )
  let leading = prompt.content.findIndex((message) => message.role !== "system")
  if (leading < 0) leading = prompt.content.length
  const systemBlocks = prompt.content.slice(0, leading).flatMap((message) => {
    if (message.role !== "system") return []
    return [message.content]
  })
  const lastIndex = prompt.content.length - 1
  const notices = Option.filter(systemAt(lastIndex), () => lastIndex >= systemBlocks.length)
  return {
    systemBlocks,
    systemPrompt: systemBlocks.join("\n\n"),
    notices: Option.getOrElse(notices, () => ""),
  }
}

// ── language-model ──────────────────────────────────────────────────────────

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
    /** The output cap the request asks the driver for. */
    readonly maxTokens?: number
  }) => void
  readonly assertOptions?: (options: ProviderOptions) => void
  readonly gated?: boolean
  /**
   * The provider's raw stop reason, which the step reports through
   * `ProviderStopReason` as a driver that reads the wire does. The finish
   * part still carries Effect AI's mapped reason (`"unknown"` for a reason
   * its map lacks).
   */
  readonly stopReason?: string
}

interface SequenceLanguageModelControls {
  readonly waitForCall: (index: number) => Effect.Effect<void>
  readonly emitAll: (index: number) => Effect.Effect<void>
  readonly callCount: Effect.Effect<number>
  readonly assertDone: Effect.Effect<void>
}

const testStream = (
  stream: (
    options: ProviderOptions,
  ) => Effect.Effect<Stream.Stream<LanguageModelStreamPart, AiError.AiError>, AiError.AiError>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  makeLanguageModelLayer({
    streamText: (options) => stream(options).pipe(Stream.unwrap),
    generateText: () => Effect.succeed("test response"),
  })

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

/**
 * The resolve-request check a sequence's `assertRequest` steps install. Only
 * `LanguageModelLayers.resolver` reads it; a model layer without one resolves
 * unchecked.
 */
const SequenceRequestAssertion = Context.Reference<
  Option.Option<(request: ResolveModelRequest) => Effect.Effect<void, ProviderError>>
>("@gent/core/src/test-utils/language-model/SequenceRequestAssertion", {
  defaultValue: () => Option.none(),
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

          if (Predicate.isNotUndefined(step?.stopReason)) {
            yield* reportProviderStopReason(step.stopReason)
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
    const requestAssertionLayer = Layer.succeed(
      SequenceRequestAssertion,
      Option.some((request: ResolveModelRequest) =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(requestIndexRef, (n) => n + 1)
          const step = steps[idx] ?? steps[0]
          if (Predicate.isUndefined(step?.assertRequest)) return
          yield* Effect.try({
            try: () =>
              step.assertRequest?.({
                model: String(request.modelId),
                ...omitUndefined({
                  reasoning: request.hints?.reasoning,
                  maxTokens: request.hints?.maxTokens,
                }),
              }),
            catch: (e) =>
              new ProviderError({
                message: `Sequence language model: assertRequest failed at step ${idx}: ${e}`,
                model: request.modelId,
                cause: e,
              }),
          })
        }),
      ),
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

/**
 * A model resolver over a test model layer: it serves the one model for every
 * request, after the sequence's `assertRequest` check when the layer has one.
 */
const resolver = (layer: Layer.Layer<LanguageModel.LanguageModel>): Layer.Layer<ModelResolver> =>
  Layer.effect(
    ModelResolver,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const assertRequest = yield* SequenceRequestAssertion
      return ModelResolver.of({
        resolve: (request) =>
          Option.match(assertRequest, {
            onNone: () => Effect.succeed(model),
            onSome: (check) => check(request).pipe(Effect.as(model)),
          }),
      })
    }),
  ).pipe(Layer.provide(layer))

export const LanguageModelLayers = {
  resolver,
  testStream,
  debug: ScriptedLanguageModel.debug,
  get empty() {
    return ScriptedLanguageModel.empty
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
