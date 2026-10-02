import { Effect, Option, Predicate, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { HttpClientError, TransportError } from "effect/http/HttpClientError"

/** One request the fake client saw: the URL, method, string headers and text body. */
interface CapturedHttpRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * A responder returns this to make the fake client fail the request with
 * `HttpClientError(TransportError)`, as a broken connection does, instead of
 * answering it.
 */
export interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}

export const transportFailure = (message: string): TransportFailure => ({
  _tag: "TransportFailure",
  message,
})

const hasTransportFailureTag = Predicate.isTagged("TransportFailure")
const isTransportFailure = (v: Response | TransportFailure): v is TransportFailure =>
  hasTransportFailureTag(v)

/** The requests the fake client saw, and the answer it gives to the call at each index. */
export interface FakeClientState {
  captured: Array<CapturedHttpRequest>
  responder: (call: number) => Response | TransportFailure
}

/** Answer the first call with `first` and every later call with `later`. */
export const respondFirstWith =
  (first: Response | TransportFailure, later: Response | TransportFailure) =>
  (call: number): Response | TransportFailure => {
    if (call === 0) return first
    return later
  }

/**
 * A real `HttpClient.HttpClient` that records each request in `state.captured`
 * and answers it with `state.responder`. A driver under test takes it as the
 * client production would pass, with no global fetch swap.
 */
export const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const headersObj: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (Schema.is(Schema.String)(value)) headersObj[key] = value
    }
    let bodyText = Option.none<string>()
    if (request.body._tag === "Uint8Array") {
      bodyText = Option.some(new TextDecoder().decode(request.body.body))
    } else if (request.body._tag === "Raw" && Schema.is(Schema.String)(request.body.body)) {
      bodyText = Option.some(request.body.body)
    }
    state.captured.push({
      url: request.url,
      method: request.method,
      headers: headersObj,
      body: Option.getOrUndefined(bodyText),
    })
    const result = state.responder(state.captured.length - 1)
    if (isTransportFailure(result)) {
      return Effect.fail(
        new HttpClientError({
          reason: new TransportError({
            request,
            cause: result,
            description: result.message,
          }),
        }),
      )
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, result))
  })
