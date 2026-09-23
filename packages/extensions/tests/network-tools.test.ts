import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import { WebSearchTool } from "../src/network-tools.js"
import { runToolWithCtx, testToolContext } from "@gent/core/test-utils"

// ── web search ──────────────────────────────────────────────────────────────

/**
 * WebSearchTool — the only shipped tool that parses an untrusted external
 * wire format (Exa MCP over JSON or SSE).
 *
 * The seam is `HttpClient.HttpClient`: a fake client built with
 * `HttpClient.make` returns canned responses, exactly as
 * `tests/anthropic/anthropic-keychain-transform.test.ts` does. No global
 * fetch swap, no network.
 */

const ctx = testToolContext()

/** Build a fake `HttpClient` layer that answers every request with `respond()`. */
const clientLayer = (respond: () => Response): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond()))),
  )

/** A client whose wire attempt fails, so the error funnel sees a non-Gent error. */
const brokenClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError({
        reason: new TransportError({
          request,
          cause: "socket closed",
          description: "socket closed",
        }),
      }),
    ),
  ),
)

/** A client that never answers, so `Effect.timeout` is the only exit. */
const stalledClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.never),
)

/** The Exa MCP wire shape, mirrored so every fixture is encoded, not stringified. */
const McpWire = Schema.Struct({
  jsonrpc: Schema.String,
  id: Schema.Finite,
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
})
type McpWire = typeof McpWire.Type

const encodeWire = Schema.encodeSync(Schema.fromJsonString(McpWire))

const jsonResponse = (frame: McpWire): Response =>
  new Response(encodeWire(frame), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const sseResponse = (frames: ReadonlyArray<McpWire>): Response =>
  new Response(frames.map((frame) => `data: ${encodeWire(frame)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const mcpHit = (text: string): McpWire => ({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text }] },
})

const emptyFrame: McpWire = {
  jsonrpc: "2.0",
  id: 1,
  result: { content: [], isError: true },
}

const search = (layer: Layer.Layer<HttpClient.HttpClient>) =>
  runToolWithCtx(WebSearchTool, { query: "effect v4 release notes" }, ctx).pipe(
    Effect.provide(layer),
  )

const failureOf = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (result._tag === "Failure") return Option.some(result.failure)
      return Option.none<E>()
    }),
  )

describe("WebSearchTool", () => {
  it.live("JSON body returns the first content block as output", () =>
    Effect.gen(function* () {
      const result = yield* search(clientLayer(() => jsonResponse(mcpHit("exa says hello"))))
      expect(result.output).toBe("exa says hello")
      expect(result.query).toBe("effect v4 release notes")
    }),
  )

  it.live("SSE body returns the first data frame that carries content", () =>
    Effect.gen(function* () {
      const result = yield* search(
        clientLayer(() => sseResponse([emptyFrame, mcpHit("streamed result")])),
      )
      expect(result.output).toBe("streamed result")
    }),
  )

  it.live("JSON result flagged isError reports an unknown Exa error", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf(
        search(
          clientLayer(() =>
            jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "ignored" }], isError: true },
            }),
          ),
        ),
      )
      expect(Option.getOrThrow(failure).message).toBe("Exa MCP error: Unknown error")
    }),
  )

  it.live("JSON error object surfaces the Exa message", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf(
        search(
          clientLayer(() =>
            jsonResponse({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "rate limited" },
            }),
          ),
        ),
      )
      expect(Option.getOrThrow(failure).message).toBe("Exa MCP error: rate limited")
    }),
  )

  it.live("HTTP 4xx reports the status and the body", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf(
        search(
          clientLayer(
            () =>
              new Response("bad request", {
                status: 400,
                headers: { "content-type": "text/plain" },
              }),
          ),
        ),
      )
      expect(Option.getOrThrow(failure).message).toBe("Search error (400): bad request")
    }),
  )

  it.live("an SSE body with no usable frame falls back to a no-results message", () =>
    Effect.gen(function* () {
      const result = yield* search(clientLayer(() => sseResponse([emptyFrame])))
      expect(result.output).toBe("No search results found. Try a different query.")
    }),
  )

  it.live("transport failure is funnelled into a WebSearchError", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf(search(brokenClientLayer))
      const error = Option.getOrThrow(failure)
      expect(error._tag).toBe("WebSearchError")
      expect(error.message).toContain("Search failed")
    }),
  )

  it.live("a stalled request times out with a WebSearchError", () =>
    Effect.gen(function* () {
      const fiber = yield* failureOf(search(stalledClientLayer)).pipe(Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      const failure = yield* Fiber.join(fiber)
      expect(Option.getOrThrow(failure).message).toBe("Search request timed out")
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  )
})
