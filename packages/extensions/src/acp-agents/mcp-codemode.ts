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
import { Context, Effect, Layer, Option, Ref, Schema, type Scope } from "effect"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as AiTool from "effect/unstable/ai/Tool"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  getToolId,
  type ExternalToolRunner,
  type InteractionPendingError,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  executeCodemodeFunction,
  inspectMcpResult,
  invokeCodemodeTool,
  makeStatelessMcpTransport,
  rejectUnknownCodemodeTool,
} from "./mcp-codemode-boundary.js"

export { inspectMcpResult as inspectForMcp } from "./mcp-codemode-boundary.js"

export class McpCodemodeUnknownToolError extends Schema.TaggedError<McpCodemodeUnknownToolError>()(
  "McpCodemodeUnknownToolError",
  {
    toolName: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown tool: ${this.toolName}`
  }
}

export class McpCodemodeServerError extends Schema.TaggedError<McpCodemodeServerError>()(
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
  readonly runTool: (
    toolName: string,
    args: Parameters<(typeof ExternalToolRunner.Service)["runTool"]>[1],
  ) =>
    | Effect.Success<ReturnType<(typeof ExternalToolRunner.Service)["runTool"]>>
    | Promise<Effect.Success<ReturnType<(typeof ExternalToolRunner.Service)["runTool"]>>>
  readonly onInteractionPending?: (pending: InteractionPendingError) => void | Promise<void>
}

const ToolDescriptionSchema = Schema.Struct({
  properties: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ type: Schema.optionalKey(Schema.String) })),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
})

const ExecuteArguments = Schema.Struct({ code: Schema.String })

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
    const decoded = Schema.decodeOption(ToolDescriptionSchema)(schema)
    const description = Option.getOrElse(decoded, () => ({ properties: {}, required: [] }))
    const props = Option.getOrElse(Option.fromNullishOr(description.properties), () => ({}))
    const required = new Set(Option.getOrElse(Option.fromNullishOr(description.required), () => []))

    const params = Object.entries(props)
      .map(([name, prop]) => {
        const propType = Option.getOrElse(Option.fromNullishOr(prop.type), () => "unknown")
        if (required.has(name)) return `${name}: ${propType}`
        return `${name}?: ${propType}`
      })
      .join(", ")

    const toolDescription = Option.getOrElse(Option.fromNullishOr(tool.description), () => "")
    lines.push(`- \`gent.${id}({ ${params} })\` — ${toolDescription}`)
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
          return () => rejectUnknownCodemodeTool(new McpCodemodeUnknownToolError({ toolName }))
        }

        return (args: Parameters<CodemodeConfig["runTool"]>[1]) =>
          invokeCodemodeTool(toolName, args, runTool, onInteractionPending)
      },
    },
  )
}

export type GentToolProxy = ReturnType<typeof makeGentProxy>

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
          type: "object",
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
    const executeArguments = Schema.decodeUnknownOption(ExecuteArguments)(args)

    if (name !== "execute" || Option.isNone(executeArguments)) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: trusted ACP agent code execution
    const fn = new Function(
      "gent",
      `"use strict"; return (async function() { ${executeArguments.value.code} })()`,
    )
    return executeCodemodeFunction(fn, proxy)
      .then((value) => {
        let text: string
        const presentValue = Option.fromNullishOr(value)
        if (Option.isNone(presentValue)) text = "(no result)"
        else {
          const stringValue = Schema.decodeUnknownOption(Schema.String)(presentValue.value)
          if (Option.isSome(stringValue)) text = stringValue.value
          else text = inspectMcpResult(presentValue.value)
        }
        return { content: [{ type: "text", text }] }
      })
      .catch((err) => {
        const decodedError = Schema.decodeUnknownOption(Schema.instanceOf(Error))(err)
        const text = Option.match(decodedError, {
          onNone: () => String(err),
          onSome: (error) => `${error.name}: ${error.message}`,
        })
        return { content: [{ type: "text", text }], isError: true }
      })
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
        const rawRequest = yield* Schema.decodeUnknownEffect(Schema.instanceOf(Request))(
          request.source,
        ).pipe(Effect.orDie)
        const mcpServer = createMcpServerForRequest(
          makeGentProxy(
            currentConfig.tools,
            currentConfig.runTool,
            currentConfig.onInteractionPending,
          ),
          generateToolDescription(currentConfig.tools),
        )
        const transport = makeStatelessMcpTransport()
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
