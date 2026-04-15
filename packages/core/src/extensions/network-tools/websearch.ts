import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { defineTool } from "../api.js"

// WebSearch Error

export class WebSearchError extends Schema.TaggedErrorClass<WebSearchError>()("WebSearchError", {
  message: Schema.String,
  query: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// WebSearch Params

export const WebSearchParams = Schema.Struct({
  query: Schema.String.annotate({
    description: "Web search query",
  }),
  numResults: Schema.optional(
    Schema.Number.annotate({
      description: "Number of search results to return (default: 8)",
    }),
  ),
  type: Schema.optional(
    Schema.Literals(["auto", "fast"]).annotate({
      description: "Search type — auto: balanced (default), fast: quick results",
    }),
  ),
})

// WebSearch Result

export const WebSearchResult = Schema.Struct({
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
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
type McpResponse = typeof McpResponseSchema.Type

const decodeMcpResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResponseSchema))

/** Extract search result text from an MCP response object */
function extractResult(data: McpResponse): string | undefined {
  if (data.error !== undefined) return undefined
  if (data.result?.isError === true) return undefined
  return data.result?.content?.[0]?.text
}

// WebSearch Tool

export const WebSearchTool = defineTool({
  name: "websearch",
  concurrency: "parallel",
  idempotent: true,
  get description() {
    const year = new Date().getFullYear()
    return `Search the web using Exa AI. Returns content from the most relevant websites. The current year is ${year} — use this year when searching for recent information.`
  },
  promptSnippet: "Search the web for information",
  promptGuidelines: ["Prefer webfetch when you already have a specific URL"],
  params: WebSearchParams,
  execute: Effect.fn("WebSearchTool.execute")(function* (params) {
    const searchRequest: McpRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: params.query,
          numResults: params.numResults ?? DEFAULT_NUM_RESULTS,
          livecrawl: "fallback",
          type: params.type ?? "auto",
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

            const contentType = response.headers["content-type"] ?? ""
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

            // Handle JSON response
            if (contentType.includes("application/json")) {
              const data = yield* parseMcpJson(responseText)
              const text = extractResult(data)
              if (text !== undefined) return text
              const errMsg = data.error?.message ?? "Unknown error"
              return yield* new WebSearchError({
                message: `Exa MCP error: ${errMsg}`,
                query: params.query,
              })
            }

            // Handle SSE response
            for (const line of responseText.split("\n")) {
              if (line.startsWith("data: ")) {
                const data = yield* parseMcpJson(line.substring(6))
                const text = extractResult(data)
                if (text !== undefined) return text
              }
            }

            return "No search results found. Try a different query."
          }),
        ),
        Effect.timeout(TIMEOUT_MS),
        Effect.catchEager((e) => {
          if ("_tag" in e && e._tag === "TimeoutError") {
            return Effect.fail(
              new WebSearchError({ message: "Search request timed out", query: params.query }),
            )
          }
          if ("_tag" in e && e._tag === "WebSearchError") return Effect.fail(e as WebSearchError)
          return Effect.fail(
            new WebSearchError({
              message: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
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
