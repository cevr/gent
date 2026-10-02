import { Effect, Layer, Option, Predicate } from "effect"
import { LanguageModel } from "effect/ai"
import type * as Prompt from "effect/ai/Prompt"
import { FetchHttpClient, HttpClient } from "effect/http"

// One fake HTTP for the driver tests: a fake `FetchHttpClient.Fetch` that
// records each outbound request and answers it from a responder. A driver
// builds its own client over `FetchHttpClient`, so `fakeFetchLayer` reaches it
// with no global fetch swap; a client transform under test takes
// `makeFakeClient`, the real `FetchHttpClient` over the same fake.

/** One request the fake saw: the URL, method, lower-cased headers and text body. */
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

/** An answer: the status, headers (JSON by default) and body, text or a byte stream. */
interface FakeResponse {
  status: number
  headers?: Record<string, string>
  body: string | ReadableStream<Uint8Array>
}

/**
 * A responder returns this to make the fetch reject, as a broken connection
 * does: `FetchHttpClient` fails the request with `HttpClientError(TransportError)`.
 */
interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}

export const transportFailure = (message: string): TransportFailure => ({
  _tag: "TransportFailure",
  message,
})

type FakeAnswer = FakeResponse | TransportFailure

const isTransportFailure = (answer: FakeAnswer): answer is TransportFailure =>
  Predicate.isTagged(answer, "TransportFailure")

/**
 * Answers the request; `call` is its index among the requests the state saw.
 * A responder that returns an Effect runs it before the response resolves,
 * so a test can change the world while a request is in flight.
 */
export type FakeResponder = (
  request: CapturedRequest,
  call: number,
) => FakeAnswer | Effect.Effect<FakeAnswer>

/** Answer the first call with `first` and every later call with `later`. */
export const respondFirstWith =
  (first: FakeAnswer, later: FakeAnswer): FakeResponder =>
  (_request, call) => {
    if (call === 0) return first
    return later
  }

const asEffect = (answer: FakeAnswer | Effect.Effect<FakeAnswer>): Effect.Effect<FakeAnswer> => {
  if (Effect.isEffect(answer)) return answer
  return Effect.succeed(answer)
}

/** The request's headers; `Headers` lower-cases each name. */
const headerRecord = (init: globalThis.RequestInit["headers"]) =>
  Object.fromEntries(new Headers(init).entries())

const bodyText = (body: globalThis.RequestInit["body"]): Option.Option<string> => {
  if (Predicate.isString(body)) return Option.some(body)
  if (body instanceof Uint8Array) return Option.some(new TextDecoder().decode(body))
  return Option.none()
}

const urlOf = (input: globalThis.RequestInfo | globalThis.URL): string => {
  if (Predicate.isString(input)) return input
  if (input instanceof URL) return input.href
  return input.url
}

/** A `fetch` that records each call into `state.captured` and answers it with `responder`. */
const makeFakeFetch =
  (state: FakeFetchState, responder: FakeResponder) =>
  (
    input: globalThis.RequestInfo | globalThis.URL,
    init?: globalThis.RequestInit,
  ): Promise<Response> => {
    const captured: CapturedRequest = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: headerRecord(init?.headers),
      body: Option.getOrUndefined(bodyText(init?.body)),
    }
    const call = state.captured.length
    state.captured.push(captured)
    // oxlint-disable-next-line effect/noEffectRunInTests -- This adapter implements the Promise-based Fetch interface.
    return Effect.runPromise(
      Effect.flatMap(asEffect(responder(captured, call)), (answer) => {
        // The fetch promise rejects with this error, as a refused socket's does.
        if (isTransportFailure(answer)) return Effect.die(new TypeError(answer.message))
        return Effect.succeed(
          new globalThis.Response(answer.body, {
            status: answer.status,
            headers: answer.headers ?? { "content-type": "application/json" },
          }),
        )
      }),
    )
  }

/** A `Layer` that overrides `FetchHttpClient.Fetch` with a fake that captures into `state`. */
export const fakeFetchLayer = (
  state: FakeFetchState,
  responder: FakeResponder,
): Layer.Layer<never, never, never> =>
  Layer.succeed(
    FetchHttpClient.Fetch,
    Object.assign(makeFakeFetch(state, responder), { preconnect: () => {} }),
  )

/** The requests a fake client saw, and how it answers each. */
export interface FakeClientState extends FakeFetchState {
  readonly responder: FakeResponder
}

/**
 * A real `HttpClient` (`FetchHttpClient`) over the fake fetch: a client
 * transform under test takes it as the client production would pass.
 */
export const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request)).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(Layer.provide(fakeFetchLayer(state, state.responder))),
      ),
    ),
  )

/**
 * Drives one `LanguageModel.generateText({prompt})` through `layer` with
 * `FetchHttpClient.Fetch` overridden to capture into `state` and reply via
 * `responder`. A test yields it inside its own Effect, so it composes with
 * `Effect.exit`, `TestClock` and the rest; a failure is a defect.
 */
export const oneGenerate = (
  layer: Layer.Layer<LanguageModel.LanguageModel>,
  state: FakeFetchState,
  responder: FakeResponder,
  prompt: Prompt.RawInput = "hi",
): Effect.Effect<void> =>
  LanguageModel.generateText({ prompt }).pipe(
    Effect.asVoid,
    Effect.provide(Layer.provideMerge(layer, fakeFetchLayer(state, responder))),
    Effect.scoped,
    Effect.catchCause((cause) => Effect.die(cause)),
  )
