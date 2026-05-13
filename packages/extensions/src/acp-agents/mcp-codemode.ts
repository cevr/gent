/**
 * MCP Codemode Server — exposes gent's tools to ACP agents via a single
 * `execute` MCP tool that runs JavaScript code with a `gent.*` proxy.
 *
 * The ACP agent in bare mode has zero built-in tools. This server gives it
 * one: `execute` — which dispatches to gent's full tool surface through
 * the proxy. Tool execution routes through `ToolRunner.run()` via the
 * `runTool` callback provided by the executor.
 *
 * @module
 */
import { Context, Effect, Layer, Ref, Schema, type Scope } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import * as AiTool from "effect/unstable/ai/Tool"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { getToolId, InteractionPendingError, type ToolCapability } from "@gent/core/extensions/api"

export class McpCodemodeUnknownToolError extends Schema.TaggedErrorClass<McpCodemodeUnknownToolError>()(
  "McpCodemodeUnknownToolError",
  {
    toolName: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown tool: ${this.toolName}`
  }
}

export class McpCodemodeServerError extends Schema.TaggedErrorClass<McpCodemodeServerError>()(
  "McpCodemodeServerError",
  {
    message: Schema.String,
  },
) {}

// ── Types ──

export interface CodemodeServer {
  readonly url: string
  readonly port: number
  readonly updateConfig: (config: CodemodeConfig) => Effect.Effect<void>
}

export interface CodemodeConfig {
  readonly tools: ReadonlyArray<ToolCapability>
  /** Run a tool by name with args. Routes through ToolRunner.run() in the
   *  parent Effect runtime — full permission checks, interceptors, and
   *  result enrichment apply. Returns the tool result value. */
  readonly runTool: (toolName: string, args: unknown) => unknown
  readonly onInteractionPending?: (pending: InteractionPendingError) => unknown
}

// ── Tool description generator ──

/**
 * Build a markdown description of the codemode `execute` surface listing
 * every available tool as `gent.<name>({ ...params })`. Used as the MCP
 * tool's description AND as the ACP system prompt's tools section
 * (replaces the default per-tool listing for external-routed agents).
 */
export const generateToolDescription = (tools: ReadonlyArray<ToolCapability>): string => {
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
    const schema = AiTool.getJsonSchema(tool)
    const id = getToolId(tool)
    const rawProps = schema["properties"]
    let props: Record<string, unknown> = {}
    if (typeof rawProps === "object" && rawProps !== null && !Array.isArray(rawProps)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
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

    lines.push(`- \`gent.${id}({ ${params} })\` — ${tool.description ?? ""}`)
  }

  return lines.join("\n")
}

// ── Proxy factory ──

const makeGentProxy = (
  tools: ReadonlyArray<ToolCapability>,
  runTool: CodemodeConfig["runTool"],
  onInteractionPending: CodemodeConfig["onInteractionPending"],
) => {
  const toolNames = new Set(tools.map((tool) => String(getToolId(tool))))

  return new Proxy(
    {},
    {
      get: (_target, toolName: string) => {
        if (!toolNames.has(toolName)) {
          return () => {
            throw new McpCodemodeUnknownToolError({ toolName })
          }
        }

        return (args: unknown) =>
          Promise.resolve()
            .then(() => runTool(toolName, args))
            .catch((error: unknown) => {
              if (Schema.is(InteractionPendingError)(error)) {
                onInteractionPending?.(error)
              }
              throw error
            })
      },
    },
  )
}

// ── inspect helper (vendored — replaces GentPlatform.inspect) ──

/**
 * Stringify an arbitrary `execute`-tool result. Handles circular
 * references by substituting `[Circular]` for repeat sights of the
 * same object and BigInt values by suffixing `n` (so `1n` round-trips
 * as the string `"1n"`, matching dev-tools convention). Falls back to
 * `String(value)` only if `JSON.stringify` still throws.
 */
export const inspectForMcp = (value: unknown): string => {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, v: unknown) => {
        if (typeof v === "bigint") return `${v.toString()}n`
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]"
          seen.add(v)
        }
        return v
      },
      2,
    )
  } catch {
    return String(value)
  }
}

// ── MCP server factory (one per request for stateless mode) ──

const createMcpServerForRequest = (
  proxy: ReturnType<typeof makeGentProxy>,
  toolDescription: string,
) => {
  const server = new Server({ name: "gent", version: "0.0.0" }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
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

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params

    if (name !== "execute" || typeof args?.["code"] !== "string") {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      }
    }

    return Promise.resolve()
      .then(() => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: trusted ACP agent code execution
        const fn = new Function(
          "gent",
          `"use strict"; return (async function() { ${args["code"]} })()`,
        )
        return Promise.resolve(Reflect.apply(fn, undefined, [proxy]) as unknown)
      })
      .then((value) => {
        let text: string
        if (value === undefined) text = "(no result)"
        else if (typeof value === "string") text = value
        else text = inspectForMcp(value)
        return { content: [{ type: "text" as const, text }] }
      })
      .catch((err: unknown) => ({
        content: [
          {
            type: "text" as const,
            text: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          },
        ],
        isError: true,
      }))
  })

  return server
}

// ── Server startup ──

export const startCodemodeServer = (
  config: CodemodeConfig,
): Effect.Effect<CodemodeServer, McpCodemodeServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const configRef = yield* Ref.make(config)

    // Stateless: fresh Server+Transport per request. MCP SDK's Server.connect()
    // can only be called once per instance, so we create a new server for each
    // incoming request. We treat the WebStandard transport's `handleRequest`
    // as the boundary and pass through its `Response` via `HttpServerResponse.raw`.
    const route = HttpRouter.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const currentConfig = yield* Ref.get(configRef)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- BunServerRequest.source is the underlying Request
        const rawRequest = request.source as Request
        const mcpServer = createMcpServerForRequest(
          makeGentProxy(
            currentConfig.tools,
            currentConfig.runTool,
            currentConfig.onInteractionPending,
          ),
          generateToolDescription(currentConfig.tools),
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        })
        const response = yield* Effect.promise(() =>
          mcpServer.connect(transport).then(() => transport.handleRequest(rawRequest)),
        )
        return HttpServerResponse.raw(response)
      }),
    )

    // `provideMerge` (vs `provide`) keeps `HttpServer.HttpServer` in the
    // output context so we can read its bound port after build.
    const HttpLive = HttpRouter.serve(route).pipe(
      Layer.provideMerge(BunHttpServer.layerServer({ port: 0 })),
    )

    const scope = yield* Effect.scope
    const ctx = yield* Layer.buildWithScope(HttpLive, scope)
    const server = Context.get(ctx, HttpServer.HttpServer)
    if (server.address._tag !== "TcpAddress") {
      return yield* new McpCodemodeServerError({
        message: "startCodemodeServer: expected TcpAddress from BunHttpServer",
      })
    }
    const port = server.address.port
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      updateConfig: (nextConfig) => Ref.set(configRef, nextConfig),
    } satisfies CodemodeServer
  })
