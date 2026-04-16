/**
 * MCP Codemode Server — exposes gent's tools to ACP agents via a single
 * `execute` MCP tool that runs TypeScript-like code with a `gent.*` proxy.
 *
 * The ACP agent in bare mode has zero built-in tools. This server gives it
 * one: `execute` — which dispatches to gent's full tool surface through
 * the proxy. Tool execution routes through `ToolRunner.run()` via the
 * `runTool` callback provided by the executor.
 *
 * @module
 */
import { Effect } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { type AnyToolDefinition, buildToolJsonSchema } from "@gent/core/extensions/api"

// ── Types ──

export interface CodemodeServer {
  readonly url: string
  readonly port: number
  readonly stop: () => void
}

export interface CodemodeConfig {
  readonly tools: ReadonlyArray<AnyToolDefinition>
  /** Run a tool by name with args. Routes through ToolRunner.run() in the
   *  parent Effect runtime — full permission checks, interceptors, and
   *  result enrichment apply. Returns the tool result value. */
  readonly runTool: (toolName: string, args: unknown) => Promise<unknown>
}

// ── Tool description generator ──

const generateToolDescription = (tools: ReadonlyArray<AnyToolDefinition>): string => {
  const lines = [
    "Execute JavaScript with access to gent tools.",
    "",
    "## Workflow",
    '1. `return await gent.grep({ pattern: "TODO", path: "src/" })`',
    '2. Compose: `const files = await gent.glob({ pattern: "**/*.ts" }); return files`',
    "3. Use `return` to send results back",
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
  runTool: CodemodeConfig["runTool"],
) => {
  const toolNames = new Set(tools.map((t) => t.name))

  return new Proxy(
    {},
    {
      get: (_target, toolName: string) => {
        if (!toolNames.has(toolName)) {
          return () => {
            throw new Error(`Unknown tool: ${toolName}`)
          }
        }

        return async (args: unknown) => runTool(toolName, args)
      },
    },
  )
}

// ── Server startup ──

export const startCodemodeServer = (config: CodemodeConfig): Effect.Effect<CodemodeServer> =>
  Effect.sync(() => {
    const { tools, runTool } = config
    const proxy = makeGentProxy(tools, runTool)
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
              code: { type: "string", description: "JavaScript code to execute" },
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
        // Wrap in async function — the ACP agent must use `return` to send back results.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: trusted ACP agent code execution
        const fn = new Function(
          "gent",
          `"use strict"; return (async function() { ${args["code"]} })()`,
        )
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
