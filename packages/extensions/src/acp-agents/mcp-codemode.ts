/**
 * MCP Codemode Server — exposes gent's tools to ACP agents via a single
 * `execute` MCP tool that runs TypeScript-like code with a `gent.*` proxy.
 *
 * The ACP agent in bare mode has zero built-in tools. This server gives it
 * one: `execute` — which dispatches to gent's full tool surface through
 * the proxy. `ToolRunner` is the real safety boundary.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  type AnyToolDefinition,
  type ToolContext,
  type ExtensionHostContext,
  ToolCallId,
  buildToolJsonSchema,
} from "@gent/core/extensions/api"

// ── Types ──

export interface CodemodeServer {
  readonly url: string
  readonly port: number
  readonly stop: () => void
}

export interface CodemodeConfig {
  readonly tools: ReadonlyArray<AnyToolDefinition>
  readonly hostCtx: ExtensionHostContext
  /** Bridge from Effect-land to Promise-land, carrying the parent runtime context.
   *  Created via `Effect.runPromiseWith(services)` in the executor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly runEffect: (effect: Effect.Effect<any, any, any>) => Promise<any>
}

// ── Tool description generator ──

const generateToolDescription = (tools: ReadonlyArray<AnyToolDefinition>): string => {
  const lines = [
    "Execute TypeScript with access to gent tools.",
    "",
    "## Workflow",
    '1. `await gent.grep({ pattern: "TODO", path: "src/" })`',
    '2. Compose: `const files = await gent.glob({ pattern: "**/*.ts" }); ...`',
    "3. Return results as last expression",
    "",
    "## Available tools",
  ]

  for (const tool of tools) {
    const schema = buildToolJsonSchema(tool)
    const rawProps = schema["properties"]
    let props: Record<string, unknown> = {}
    if (typeof rawProps === "object" && rawProps !== null && !Array.isArray(rawProps)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      props = rawProps as Record<string, unknown>
    }
    const rawRequired = schema["required"]
    const required = new Set(
      Array.isArray(rawRequired)
        ? rawRequired.filter((r): r is string => typeof r === "string")
        : [],
    )

    const params = Object.entries(props)
      .map(([name, prop]) => {
        const propType =
          typeof prop === "object" &&
          prop !== null &&
          "type" in prop &&
          typeof prop.type === "string"
            ? prop.type
            : "unknown"
        return required.has(name) ? `${name}: ${propType}` : `${name}?: ${propType}`
      })
      .join(", ")

    lines.push(`- \`gent.${tool.name}({ ${params} })\` — ${tool.description}`)
  }

  return lines.join("\n")
}

// ── Proxy factory ──

const makeGentProxy = (
  tools: ReadonlyArray<AnyToolDefinition>,
  hostCtx: ExtensionHostContext,
  runEffect: CodemodeConfig["runEffect"],
) => {
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  return new Proxy(
    {},
    {
      get: (_target, toolName: string) => {
        const tool = toolMap.get(toolName)
        if (tool === undefined) {
          return () => {
            throw new Error(`Unknown tool: ${toolName}`)
          }
        }

        return async (args: unknown) => {
          const toolCallId = ToolCallId.of(crypto.randomUUID())
          const ctx: ToolContext = { ...hostCtx, toolCallId }

          // Decode input through the tool's schema
          const decoded = Schema.decodeUnknownSync(tool.params)(args)

          // Execute the tool directly (same as ToolRunner but without interceptors —
          // those are handled by the agent loop for the parent agent)
          const result = await runEffect(tool.execute(decoded, ctx))
          return result
        }
      },
    },
  )
}

// ── Server startup ──

export const startCodemodeServer = (config: CodemodeConfig): Effect.Effect<CodemodeServer> =>
  Effect.sync(() => {
    const { tools, hostCtx, runEffect } = config
    const proxy = makeGentProxy(tools, hostCtx, runEffect)
    const toolDescription = generateToolDescription(tools)

    // Low-level MCP server (no zod dependency)
    const mcpServer = new Server(
      { name: "gent", version: "0.0.0" },
      { capabilities: { tools: {} } },
    )

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "execute",
          description: toolDescription,
          inputSchema: {
            type: "object" as const,
            properties: {
              code: { type: "string", description: "TypeScript code to execute" },
            },
            required: ["code"],
          },
        },
      ],
    }))

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      if (name !== "execute" || typeof args?.["code"] !== "string") {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        }
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: trusted ACP agent code execution
        const fn = new Function("gent", `"use strict"; return (async () => { ${args["code"]} })()`)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- new Function returns Function, narrowing to callable shape
        const result: unknown = await (fn as (gent: unknown) => Promise<unknown>)(proxy)
        let text: string
        if (result === undefined) {
          text = "(no result)"
        } else if (typeof result === "string") {
          text = result
        } else {
          text = JSON.stringify(result, null, 2)
        }
        return { content: [{ type: "text" as const, text }] }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            },
          ],
          isError: true,
        }
      }
    })

    // Start Bun HTTP server on ephemeral port
    const bunServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/mcp" && req.method === "POST") {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          })
          await mcpServer.connect(transport)
          const response = await transport.handleRequest(req)
          return response
        }
        return new Response("Not found", { status: 404 })
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- port is always defined when Bun.serve succeeds
    const port = bunServer.port as number
    const url = `http://127.0.0.1:${port}`

    return {
      url,
      port,
      stop: () => {
        bunServer.stop()
      },
    } satisfies CodemodeServer
  })
