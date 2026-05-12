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
  ExecutorCompleted,
  ExecutorFailed,
  ExecutorInteractionForm,
  ExecutorInteractionUrl,
  ExecutorMcpError,
  ExecutorWaitingForInteraction,
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

/**
 * Try each discriminator (`_tag`, then `kind`) independently. Falling
 * through on a malformed tagged branch preserves the prior behavior
 * where `{ _tag: "form", kind: "url", url, message: <missing> }`
 * still normalized via the wire-kind path.
 */
const tryInteraction = (
  kind: unknown,
  structured: Record<string, unknown>,
): ExecutorInteraction | undefined => {
  const message = structured["message"]
  if (kind === "form" && typeof message === "string") {
    return ExecutorInteractionForm.make({
      message,
      ...(isRecord(structured["requestedSchema"])
        ? { requestedSchema: structured["requestedSchema"] }
        : {}),
    })
  }
  const url = structured["url"]
  if (kind === "url" && typeof message === "string" && typeof url === "string") {
    return ExecutorInteractionUrl.make({ message, url })
  }
  return undefined
}

const normalizeInteraction = (structured: unknown): ExecutorInteraction | undefined => {
  if (!isRecord(structured)) return undefined
  return (
    tryInteraction(structured["_tag"], structured) ?? tryInteraction(structured["kind"], structured)
  )
}

const normalizeStructuredContent = (structured: unknown): unknown => {
  if (!isRecord(structured)) return structured

  if (structured["_tag"] === "completed") {
    return ExecutorCompleted.make({
      result: structured["result"],
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (structured["_tag"] === "error" && typeof structured["error"] === "string") {
    return ExecutorFailed.make({
      error: structured["error"],
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (
    structured["_tag"] === "waiting_for_interaction" &&
    typeof structured["executionId"] === "string"
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (interaction !== undefined) {
      return ExecutorWaitingForInteraction.make({
        executionId: structured["executionId"],
        interaction,
      }) satisfies ExecutorStructuredContent
    }
  }

  if (structured["status"] === "completed") {
    return ExecutorCompleted.make({
      result: structured["result"],
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (structured["status"] === "error") {
    let error = "Executor failed"
    if (typeof structured["error"] === "string") {
      error = structured["error"]
    } else if (typeof structured["errorMessage"] === "string") {
      error = structured["errorMessage"]
    }
    return ExecutorFailed.make({
      error,
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (
    structured["status"] === "waiting_for_interaction" &&
    typeof structured["executionId"] === "string"
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (interaction !== undefined) {
      return ExecutorWaitingForInteraction.make({
        executionId: structured["executionId"],
        interaction,
      }) satisfies ExecutorStructuredContent
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
    try: () => {
      const client = new Client({ name: "gent-executor", version: "0.0.1" }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl))
      return client.connect(transport).then(() => ({ client, transport }) satisfies McpConnection)
    },
    catch: (e) =>
      new ExecutorMcpError({
        phase: "connect",
        message: `MCP connect failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  })

const releaseConnection = (conn: McpConnection) =>
  Effect.tryPromise(() =>
    conn.transport
      .terminateSession()
      .catch(() => undefined)
      .then(() => conn.client.close().catch(() => undefined)),
  ).pipe(Effect.orElseSucceed(() => {}))

const connection = (baseUrl: string) =>
  Effect.acquireRelease(acquireConnection(baseUrl), releaseConnection)

// ── Service ──

export class ExecutorMcpBridge extends Context.Service<
  ExecutorMcpBridge,
  ExecutorMcpBridgeService
>()("@gent/extensions/src/executor/mcp-bridge/ExecutorMcpBridge") {
  static Live = Layer.succeed(
    ExecutorMcpBridge,
    ExecutorMcpBridge.of({
      inspect: (baseUrl) =>
        connection(baseUrl).pipe(
          Effect.flatMap((conn) =>
            Effect.gen(function* () {
              const listPage = (cursor: string | undefined) =>
                Effect.tryPromise({
                  try: () => conn.client.listTools(cursor ? { cursor } : undefined),
                  catch: (e) =>
                    new ExecutorMcpError({
                      phase: "inspect",
                      message: `MCP inspect failed: ${e instanceof Error ? e.message : String(e)}`,
                    }),
                })
              type Tool = { name: string; description?: string }
              const readPage: (
                cursor: string | undefined,
                acc: ReadonlyArray<Tool>,
              ) => Effect.Effect<ReadonlyArray<Tool>, ExecutorMcpError> = (cursor, acc) =>
                listPage(cursor).pipe(
                  Effect.flatMap((response) => {
                    const next: ReadonlyArray<Tool> = [
                      ...acc,
                      ...response.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                      })),
                    ]
                    return response.nextCursor === undefined
                      ? Effect.succeed(next)
                      : Effect.suspend(() => readPage(response.nextCursor, next))
                  }),
                )
              const tools = yield* readPage(undefined, [])
              return {
                instructions: conn.client.getInstructions(),
                tools,
              } satisfies ExecutorMcpInspection
            }),
          ),
          Effect.scoped,
        ),

      execute: (baseUrl, code) =>
        connection(baseUrl).pipe(
          Effect.flatMap((conn) =>
            Effect.tryPromise({
              try: () =>
                conn.client
                  .callTool({
                    name: "execute",
                    arguments: { code },
                  })
                  .then(normalizeToolResult),
              catch: (e) =>
                new ExecutorMcpError({
                  phase: "execute",
                  message: `MCP execute failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            }),
          ),
          Effect.scoped,
        ),

      resume: (baseUrl, executionId, action, content) =>
        connection(baseUrl).pipe(
          Effect.flatMap((conn) =>
            Effect.tryPromise({
              try: () =>
                conn.client
                  .callTool({
                    name: "resume",
                    arguments: {
                      executionId,
                      action,
                      // @effect-diagnostics-next-line preferSchemaOverJson:off
                      content: content ? JSON.stringify(content) : "{}",
                    },
                  })
                  .then(normalizeToolResult),
              catch: (e) =>
                new ExecutorMcpError({
                  phase: "resume",
                  message: `MCP resume failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            }),
          ),
          Effect.scoped,
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
