/**
 * Shared fake-`FetchHttpClient.Fetch` capture pattern for provider-extension
 * tests. Counsel called this out as the missing piece behind the C4.1
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
 * `packages/extensions/src/openai/index.ts:111` (`Layer.succeed(FetchHttpClient.Fetch, ...)`).
 */
import { Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

export interface FakeFetchState {
  captured: Array<CapturedRequest>
}

/** Build a fresh capture state. */
export const makeFakeFetchState = (): FakeFetchState => ({ captured: [] })

/** Last captured request. Throws if zero requests were captured. */
export const lastRequest = (state: FakeFetchState): CapturedRequest => {
  const last = state.captured[state.captured.length - 1]
  if (last === undefined) {
    throw new Error("fake-fetch: no requests captured")
  }
  return last
}

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

export const makeFakeFetch =
  (
    state: FakeFetchState,
    responder: (req: CapturedRequest) => {
      status: number
      headers?: Record<string, string>
      body: string
    },
  ): FakeFetchFn =>
  async (input: globalThis.RequestInfo | globalThis.URL, init?: globalThis.RequestInit) => {
    let url: string
    if (typeof input === "string") url = input
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
    } else if (headerInit !== undefined && headerInit !== null) {
      for (const [k, v] of Object.entries(headerInit)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v
      }
    }

    let bodyText: string | undefined
    if (typeof init?.body === "string") bodyText = init.body
    else if (init?.body instanceof Uint8Array) bodyText = new TextDecoder().decode(init.body)
    else bodyText = undefined

    const captured: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: bodyText,
    }
    state.captured.push(captured)

    const response = responder(captured)
    return new Response(response.body, {
      status: response.status,
      headers: response.headers ?? { "content-type": "application/json" },
    })
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Layer.succeed(FetchHttpClient.Fetch, makeFakeFetch(state, responder) as never)

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
): Effect.Effect<void, unknown> =>
  LanguageModel.generateText({ prompt }).pipe(
    Effect.asVoid,
    // @effect-diagnostics-next-line strictEffectProvide:off test entry point
    Effect.provide(Layer.provideMerge(layer, fakeFetchLayer(state, responder))),
    Effect.scoped,
  )
