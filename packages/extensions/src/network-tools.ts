import { Effect, Option, Predicate, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"

// ── websearch ───────────────────────────────────────────────────────────────

// WebSearch Error

class WebSearchError extends Schema.TaggedError<WebSearchError>()("WebSearchError", {
  message: Schema.String,
  query: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// WebSearch Params

const WebSearchParams = Schema.Struct({
  query: Schema.String.annotate({
    description: "Web search query",
  }),
  numResults: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: "Number of search results to return (default: 8)",
    }),
  ),
  type: Schema.optionalKey(
    Schema.Literals(["auto", "fast"]).annotate({
      description: "Search type — auto: balanced (default), fast: quick results",
    }),
  ),
})

// WebSearch Result

const WebSearchResult = Schema.Struct({
  output: Schema.String,
  query: Schema.String,
})

// Exa AI MCP endpoint

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const DEFAULT_NUM_RESULTS = 8
const TIMEOUT_MS = 25000

interface McpRequest {
  jsonrpc: string
  id: number
  method: string
  params: {
    name: string
    arguments: {
      query: string
      numResults: number
      livecrawl: "fallback"
      type: "auto" | "fast"
    }
  }
}

const McpResponseSchema = Schema.Struct({
  jsonrpc: Schema.String,
  result: Schema.optional(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
      isError: Schema.optional(Schema.Boolean),
    }),
  ),
  error: Schema.optional(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
})
type McpResponse = typeof McpResponseSchema.Type

const decodeMcpResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResponseSchema))

/** Extract search result text from an MCP response object */
function extractResult(data: McpResponse): Option.Option<string> {
  if (Option.isSome(mcpError(data))) return Option.none()
  return Option.fromNullishOr(data.result?.content[0]).pipe(Option.map((item) => item.text))
}

/** A JSON-RPC error, or a tool result the server flagged `isError`, whose text is the reason. */
function mcpError(data: McpResponse): Option.Option<{ readonly message: string }> {
  if (Predicate.isNotUndefined(data.error)) return Option.some(data.error)
  if (data.result?.isError !== true) return Option.none()
  return Option.some({
    message: Option.getOrElse(
      Option.fromNullishOr(data.result.content[0]?.text),
      () => "Unknown error",
    ),
  })
}

// WebSearch Tool

export const WebSearchTool = tool({
  id: "websearch",
  description:
    "Search the web using Exa AI. Returns content from the most relevant websites. Use the current year when searching for recent information.",
  promptSnippet: "Search the web for information",
  readonly: true,
  promptGuidelines: ["When you already have a specific URL, fetch it in the cell instead"],
  params: WebSearchParams,
  output: WebSearchResult,
  execute: Effect.fn("WebSearchTool.execute")(function* (params) {
    const searchRequest: McpRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: params.query,
          numResults: Option.getOrElse(
            Option.fromNullishOr(params.numResults),
            () => DEFAULT_NUM_RESULTS,
          ),
          livecrawl: "fallback",
          type: Option.getOrElse(Option.fromNullishOr(params.type), () => "auto"),
        },
      },
    }

    const http = yield* HttpClient.HttpClient
    const result = yield* http
      .execute(
        HttpClientRequest.post(EXA_MCP_URL).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe(searchRequest),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            if (response.status >= 400) {
              const errorText = yield* response.text
              return yield* new WebSearchError({
                message: `Search error (${response.status}): ${errorText}`,
                query: params.query,
              })
            }

            const responseText = yield* response.text

            const parseMcpJson = (raw: string) =>
              decodeMcpResponse(raw).pipe(
                Effect.catchEager((e) =>
                  Effect.fail(
                    new WebSearchError({
                      message: `Invalid JSON: ${String(e)}`,
                      query: params.query,
                    }),
                  ),
                ),
              )

            // The endpoint answers either as one JSON object or as an SSE
            // stream of `data:` frames. Scan for frames first; a body with
            // none is the whole-object form.
            const frames = responseText
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.substring(6))

            const mcpFailure = (error: Option.Option<{ readonly message: string }>) =>
              new WebSearchError({
                message: `Exa MCP error: ${Option.match(error, {
                  onNone: () => "Unknown error",
                  onSome: (found) => found.message,
                })}`,
                query: params.query,
              })

            if (frames.length === 0) {
              const data = yield* parseMcpJson(responseText)
              const text = extractResult(data)
              if (Option.isSome(text)) return text.value
              return yield* mcpFailure(mcpError(data))
            }

            // A frame that carries an error ends the search with it; a frame with neither is skipped.
            for (const frame of frames) {
              const data = yield* parseMcpJson(frame)
              const text = extractResult(data)
              if (Option.isSome(text)) return text.value
              const error = mcpError(data)
              if (Option.isSome(error)) return yield* mcpFailure(error)
            }

            return "No search results found. Try a different query."
          }),
        ),
        Effect.timeout(TIMEOUT_MS),
        Effect.catchEager((e) => {
          if (Predicate.isTagged("TimeoutError")(e)) {
            return Effect.fail(
              new WebSearchError({ message: "Search request timed out", query: params.query }),
            )
          }
          if (Predicate.isTagged("WebSearchError")(e)) return Effect.fail(e)
          let message = String(e)
          if (e instanceof Error) message = e.message
          return Effect.fail(
            new WebSearchError({
              message: `Search failed: ${message}`,
              query: params.query,
              cause: e,
            }),
          )
        }),
      )

    return {
      output: result,
      query: params.query,
    }
  }),
})

// ── extension ───────────────────────────────────────────────────────────────

export const NetworkToolsExtension = defineExtension({
  id: "@gent/network-tools",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", WebSearchTool)
  }),
})
