/**
 * ExecutorMcpBridge — Effect service wrapping MCP SDK client.
 *
 * Each operation acquires a fresh MCP connection (StreamableHTTP),
 * calls the tool, normalizes the result, and releases the transport.
 * Empty capabilities — no inline elicitation. When Executor needs
 * human approval it returns waiting_for_interaction with an executionId.
 */

import { Context, Effect, Layer } from "effect"
import { isRecord, isRecordArray } from "@gent/core/extensions/api"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  type ExecutorInteraction,
  type ExecutorMcpInspection,
  type ExecutorStructuredContent,
  type ExecutorMcpToolResult,
  type ResumeAction,
  ExecutorMcpError,
} from "./domain.js"

// ── Result normalization ──

const DEFAULT_TEXT = "(no result)"
const EMPTY_LOGS: ReadonlyArray<string> = []

const collectText = (content: ReadonlyArray<Record<string, unknown>>): string => {
  const parts: string[] = []
  for (const item of content) {
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"])
    }
  }
  return parts.join("\n").trim()
}

const readLogs = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : EMPTY_LOGS

const normalizeInteraction = (structured: unknown): ExecutorInteraction | undefined => {
  if (!isRecord(structured)) return undefined
  const taggedKind = structured["_tag"]
  if (taggedKind === "form" && typeof structured["message"] === "string") {
    return {
      _tag: "form",
      message: structured["message"],
      ...(isRecord(structured["requestedSchema"])
        ? { requestedSchema: structured["requestedSchema"] }
        : {}),
    }
  }
  if (
    taggedKind === "url" &&
    typeof structured["message"] === "string" &&
    typeof structured["url"] === "string"
  ) {
    return {
      _tag: "url",
      message: structured["message"],
      url: structured["url"],
    }
  }

  const wireKind = structured["kind"]
  if (wireKind === "form" && typeof structured["message"] === "string") {
    return {
      _tag: "form",
      message: structured["message"],
      ...(isRecord(structured["requestedSchema"])
        ? { requestedSchema: structured["requestedSchema"] }
        : {}),
    }
  }
  if (
    wireKind === "url" &&
    typeof structured["message"] === "string" &&
    typeof structured["url"] === "string"
  ) {
    return {
      _tag: "url",
      message: structured["message"],
      url: structured["url"],
    }
  }
  return undefined
}

const normalizeStructuredContent = (structured: unknown): unknown => {
  if (!isRecord(structured)) return structured

  if (structured["_tag"] === "completed") {
    return {
      _tag: "completed",
      result: structured["result"],
      logs: [...readLogs(structured["logs"])],
    } satisfies ExecutorStructuredContent
  }

  if (structured["_tag"] === "error" && typeof structured["error"] === "string") {
    return {
      _tag: "error",
      error: structured["error"],
      logs: [...readLogs(structured["logs"])],
    } satisfies ExecutorStructuredContent
  }

  if (
    structured["_tag"] === "waiting_for_interaction" &&
    typeof structured["executionId"] === "string"
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (interaction !== undefined) {
      return {
        _tag: "waiting_for_interaction",
        executionId: structured["executionId"],
        interaction,
      } satisfies ExecutorStructuredContent
    }
  }

  if (structured["status"] === "completed") {
    return {
      _tag: "completed",
      result: structured["result"],
      logs: [...readLogs(structured["logs"])],
    } satisfies ExecutorStructuredContent
  }

  if (structured["status"] === "error") {
    let error = "Executor failed"
    if (typeof structured["error"] === "string") {
      error = structured["error"]
    } else if (typeof structured["errorMessage"] === "string") {
      error = structured["errorMessage"]
    }
    return {
      _tag: "error",
      error,
      logs: [...readLogs(structured["logs"])],
    } satisfies ExecutorStructuredContent
  }

  if (
    structured["status"] === "waiting_for_interaction" &&
    typeof structured["executionId"] === "string"
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (interaction !== undefined) {
      return {
        _tag: "waiting_for_interaction",
        executionId: structured["executionId"],
        interaction,
      } satisfies ExecutorStructuredContent
    }
  }

  return structured
}

export const readExecutionId = (structured: unknown): string | undefined => {
  if (!isRecord(structured)) return undefined
  return structured["_tag"] === "waiting_for_interaction" &&
    typeof structured["executionId"] === "string"
    ? structured["executionId"]
    : undefined
}

export const normalizeToolResult = (
  raw: Awaited<ReturnType<Client["callTool"]>>,
): ExecutorMcpToolResult => {
  // MCP SDK can return { toolResult } without content array
  if (!("content" in raw) || raw.content === undefined) {
    const fallback = "toolResult" in raw ? raw.toolResult : undefined
    return {
      text: fallback ? JSON.stringify(fallback, null, 2) : DEFAULT_TEXT,
      structuredContent: fallback ?? null,
      isError: false,
    }
  }

  const content = isRecordArray(raw.content) ? raw.content : []
  const structured: unknown = raw.structuredContent
    ? normalizeStructuredContent(JSON.parse(JSON.stringify(raw.structuredContent)))
    : undefined
  const text = collectText(content)

  let resultText = DEFAULT_TEXT
  if (text.length > 0) {
    resultText = text
  } else if (structured) {
    resultText = JSON.stringify(structured, null, 2)
  }

  return {
    text: resultText,
    structuredContent: structured ?? null,
    isError: raw.isError === true,
    executionId: readExecutionId(structured),
  }
}

// ── Service interface ──

export interface ExecutorMcpBridgeService {
  readonly inspect: (baseUrl: string) => Effect.Effect<ExecutorMcpInspection, ExecutorMcpError>
  readonly execute: (
    baseUrl: string,
    code: string,
  ) => Effect.Effect<ExecutorMcpToolResult, ExecutorMcpError>
  readonly resume: (
    baseUrl: string,
    executionId: string,
    action: ResumeAction,
    content?: Record<string, unknown>,
  ) => Effect.Effect<ExecutorMcpToolResult, ExecutorMcpError>
}

// ── Connection helper ──

interface McpConnection {
  readonly client: Client
  readonly transport: StreamableHTTPClientTransport
}

const acquireConnection = (baseUrl: string) =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({ name: "gent-executor", version: "0.0.1" }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl))
      await client.connect(transport)
      return { client, transport } satisfies McpConnection
    },
    catch: (e) =>
      new ExecutorMcpError({
        phase: "connect",
        message: `MCP connect failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })

const releaseConnection = (conn: McpConnection) =>
  Effect.tryPromise(async () => {
    await conn.transport.terminateSession().catch(() => {})
    await conn.client.close().catch(() => {})
  }).pipe(Effect.orElseSucceed(() => {}))

const withConnection = <A>(
  baseUrl: string,
  use: (conn: McpConnection) => Effect.Effect<A, ExecutorMcpError>,
) => Effect.acquireUseRelease(acquireConnection(baseUrl), use, releaseConnection)

// ── Service ──

export class ExecutorMcpBridge extends Context.Service<
  ExecutorMcpBridge,
  ExecutorMcpBridgeService
>()("@gent/core/src/extensions/executor/mcp-bridge/ExecutorMcpBridge") {
  static Live = Layer.succeed(
    ExecutorMcpBridge,
    ExecutorMcpBridge.of({
      inspect: (baseUrl) =>
        withConnection(baseUrl, (conn) =>
          Effect.tryPromise({
            try: async () => {
              const tools: Array<{ name: string; description?: string }> = []
              let cursor: string | undefined
              do {
                // eslint-disable-next-line no-await-in-loop -- cursor pagination is sequential
                const response = await conn.client.listTools(cursor ? { cursor } : undefined)
                for (const t of response.tools) {
                  tools.push({ name: t.name, description: t.description })
                }
                cursor = response.nextCursor
              } while (cursor)

              return {
                instructions: conn.client.getInstructions(),
                tools,
              } satisfies ExecutorMcpInspection
            },
            catch: (e) =>
              new ExecutorMcpError({
                phase: "inspect",
                message: `MCP inspect failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          }),
        ),

      execute: (baseUrl, code) =>
        withConnection(baseUrl, (conn) =>
          Effect.tryPromise({
            try: async () =>
              normalizeToolResult(
                await conn.client.callTool({
                  name: "execute",
                  arguments: { code },
                }),
              ),
            catch: (e) =>
              new ExecutorMcpError({
                phase: "execute",
                message: `MCP execute failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          }),
        ),

      resume: (baseUrl, executionId, action, content) =>
        withConnection(baseUrl, (conn) =>
          Effect.tryPromise({
            try: async () =>
              normalizeToolResult(
                await conn.client.callTool({
                  name: "resume",
                  arguments: {
                    executionId,
                    action,
                    // @effect-diagnostics-next-line preferSchemaOverJson:off
                    content: content ? JSON.stringify(content) : "{}",
                  },
                }),
              ),
            catch: (e) =>
              new ExecutorMcpError({
                phase: "resume",
                message: `MCP resume failed: ${e instanceof Error ? e.message : String(e)}`,
              }),
          }),
        ),
    }),
  )

  static Test = (mock: Partial<ExecutorMcpBridgeService> = {}): Layer.Layer<ExecutorMcpBridge> =>
    Layer.succeed(
      ExecutorMcpBridge,
      ExecutorMcpBridge.of({
        inspect: mock.inspect ?? (() => Effect.die("not mocked")),
        execute: mock.execute ?? (() => Effect.die("not mocked")),
        resume: mock.resume ?? (() => Effect.die("not mocked")),
      }),
    )
}
