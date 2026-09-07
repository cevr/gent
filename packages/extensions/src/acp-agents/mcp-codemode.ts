/**
 * MCP Codemode Server — exposes gent's cell to ACP agents via a single
 * `execute` MCP tool.
 *
 * The ACP agent in bare mode has zero built-in tools. This server gives it
 * one: `execute` — which forwards the code to the branch's persistent `cell`
 * tool through the `runTool` callback provided by the executor. The host cell
 * is the only interpreter: this server never evaluates code itself.
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
  inspectMcpResult,
  invokeCodemodeCell,
  makeStatelessMcpTransport,
} from "./mcp-codemode-boundary.js"

export { inspectMcpResult as inspectForMcp } from "./mcp-codemode-boundary.js"

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

/** The saved shape of a `cell` tool result as it crosses the external runner. */
const CellToolResult = Schema.Struct({
  isFailure: Schema.Boolean,
  result: Schema.Unknown,
})
const CellDisplay = Schema.Struct({ display: Schema.String })

// ── Tool description generator ──

/**
 * Build a markdown description of the codemode `execute` surface listing
 * every host tool as `tools.call('<name>', { ...params })`. Used as the MCP
 * tool's description AND as the ACP system prompt's tools section
 * (replaces the default per-tool listing for external-routed agents).
 */
export const generateToolDescription = (tools: ReadonlyArray<ToolCapability>): string => {
  const lines = [
    "Execute JavaScript in the session's persistent cell.",
    "",
    "## Workflow",
    '1. `await tools.call(\'grep\', { pattern: "TODO", path: "src/" })`',
    "2. Compose: `const files = await tools.call('glob', { pattern: \"**/*.ts\" }); files`",
    "3. The value of the last expression is the result; top-level variables persist across calls",
    "4. `tools.search(query)` and `tools.describe(name)` inspect the host tools locally",
    "",
    "## Available tools",
  ]

  for (const tool of tools) {
    const id = getToolId(tool)
    if (id === "cell") continue
    const schema = AiTool.getJsonSchema(tool)
    const decoded = Schema.decodeOption(ToolDescriptionSchema)(schema)
    const description = Option.getOrElse(decoded, () => ({
      properties: {},
      required: [],
    }))
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
    lines.push(`- \`tools.call('${id}', { ${params} })\` — ${toolDescription}`)
  }

  return lines.join("\n")
}

// ── Result projection ──

type CellRunResult = Awaited<ReturnType<CodemodeConfig["runTool"]>>

const cellResultText = (value: CellRunResult) => {
  const saved = Schema.decodeUnknownOption(CellToolResult)(value)
  if (Option.isNone(saved)) return { text: inspectMcpResult(value), isError: false }
  const display = Schema.decodeUnknownOption(CellDisplay)(saved.value.result)
  if (Option.isSome(display)) return { text: display.value.display, isError: saved.value.isFailure }
  return {
    text: inspectMcpResult(saved.value.result),
    isError: saved.value.isFailure,
  }
}

// ── MCP server factory (one per request for stateless mode) ──

const createMcpServerForRequest = (config: CodemodeConfig) => {
  const server = new Server({ name: "gent", version: "0.0.0" }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "execute",
        description: generateToolDescription(config.tools),
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

    return invokeCodemodeCell(
      executeArguments.value.code,
      config.runTool,
      config.onInteractionPending,
    )
      .then((value) => {
        const { text, isError } = cellResultText(value)
        return { content: [{ type: "text", text }], isError }
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
        const mcpServer = createMcpServerForRequest(currentConfig)
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
