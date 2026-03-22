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

interface McpResponse {
  jsonrpc: string
  result?: {
    content: Array<{
      type: string
      text: string
    }>
    isError?: boolean
  }
  error?: {
    code: number
    message: string
  }
}

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

          const contentType = response.headers.get("content-type") ?? ""
          const responseText = await response.text()

          // Handle JSON response
          if (contentType.includes("application/json")) {
            const data = JSON.parse(responseText) as McpResponse
            const text = extractResult(data)
            if (text !== undefined) return text
            const errMsg = data.error?.message ?? "Unknown error"
            throw new Error(`Exa MCP error: ${errMsg}`)
          }

          // Handle SSE response
          for (const line of responseText.split("\n")) {
            if (line.startsWith("data: ")) {
              const data = JSON.parse(line.substring(6)) as McpResponse
              const text = extractResult(data)
              if (text !== undefined) return text
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
