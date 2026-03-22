import { Effect, Schema } from "effect"
import { defineTool } from "../domain/tool.js"

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
    Schema.Literals(["auto", "fast", "deep"]).annotate({
      description:
        "Search type — auto: balanced (default), fast: quick results, deep: comprehensive",
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

interface McpSearchRequest {
  jsonrpc: string
  id: number
  method: string
  params: {
    name: string
    arguments: {
      query: string
      numResults: number
      livecrawl: "fallback"
      type: "auto" | "fast" | "deep"
    }
  }
}

interface McpSearchResponse {
  jsonrpc: string
  result: {
    content: Array<{
      type: string
      text: string
    }>
  }
}

// WebSearch Tool

export const WebSearchTool = defineTool({
  name: "websearch",
  concurrency: "parallel",
  idempotent: true,
  get description() {
    const year = new Date().getFullYear()
    return `Search the web using Exa AI. Returns content from the most relevant websites. The current year is ${year} — use this year when searching for recent information. Supports configurable result counts and search depth.`
  },
  params: WebSearchParams,
  execute: Effect.fn("WebSearchTool.execute")(function* (params) {
    const searchRequest: McpSearchRequest = {
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

    const result = yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

        try {
          const response = await fetch(EXA_MCP_URL, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify(searchRequest),
            signal: controller.signal,
          })

          clearTimeout(timeout)

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Search error (${response.status}): ${errorText}`)
          }

          const responseText = await response.text()

          // Parse SSE response
          const lines = responseText.split("\n")
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data: McpSearchResponse = JSON.parse(line.substring(6))
              if (data.result?.content?.[0]?.text !== undefined) {
                return data.result.content[0].text
              }
            }
          }

          return "No search results found. Try a different query."
        } finally {
          clearTimeout(timeout)
        }
      },
      catch: (e) => {
        if (e instanceof Error && e.name === "AbortError") {
          return new WebSearchError({
            message: "Search request timed out",
            query: params.query,
          })
        }
        return new WebSearchError({
          message: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
          query: params.query,
          cause: e,
        })
      },
    })

    return {
      output: result,
      query: params.query,
    }
  }),
})
