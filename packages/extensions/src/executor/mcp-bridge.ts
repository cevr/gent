/**
 * ExecutorMcpBridge — Effect service wrapping MCP SDK client.
 *
 * Each operation acquires a fresh MCP connection (StreamableHTTP),
 * calls the tool, normalizes the result, and releases the transport.
 * Empty capabilities — no inline elicitation. When Executor needs
 * human approval it returns waiting_for_interaction with an executionId.
 */

import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
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
const JSON_NULL_REPLACER = Option.getOrNull(Option.none())
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>
const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>
const OptionalStringSchema = Schema.optional(Schema.String)
type OptionalString = typeof OptionalStringSchema.Type

const collectText = (content: ReadonlyArray<JsonRecord>): string => {
  const parts: string[] = []
  for (const item of content) {
    if (item["type"] === "text" && Predicate.isString(item["text"])) {
      parts.push(item["text"])
    }
  }
  return parts.join("\n").trim()
}

const readLogs = (value: JsonValue): ReadonlyArray<string> => {
  if (Array.isArray(value) && value.every((entry) => Predicate.isString(entry))) return value
  return EMPTY_LOGS
}

/**
 * Try each discriminator (`_tag`, then `kind`) independently. Falling
 * through on a malformed tagged branch preserves the prior behavior
 * where `{ _tag: "form", kind: "url", url, message: <missing> }`
 * still normalized via the wire-kind path.
 */
const tryInteraction = (
  kind: JsonValue,
  structured: JsonRecord,
): Option.Option<ExecutorInteraction> => {
  const message = structured["message"]
  if (kind === "form" && Predicate.isString(message)) {
    const requestedSchema = structured["requestedSchema"]
    if (isRecord(requestedSchema)) {
      return Option.some(ExecutorInteractionForm.make({ message, requestedSchema }))
    }
    return Option.some(ExecutorInteractionForm.make({ message }))
  }
  const url = structured["url"]
  if (kind === "url" && Predicate.isString(message) && Predicate.isString(url)) {
    return Option.some(ExecutorInteractionUrl.make({ message, url }))
  }
  return Option.none()
}

const normalizeInteraction = (structured: JsonValue): Option.Option<ExecutorInteraction> => {
  if (!isRecord(structured)) return Option.none()
  return tryInteraction(structured["_tag"], structured).pipe(
    Option.orElse(() => tryInteraction(structured["kind"], structured)),
  )
}

const normalizeStructuredContent = (structured: JsonValue): JsonValue => {
  if (!isRecord(structured)) return structured

  if (structured["_tag"] === "completed") {
    return ExecutorCompleted.make({
      result: structured["result"],
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (structured["_tag"] === "error" && Predicate.isString(structured["error"])) {
    return ExecutorFailed.make({
      error: structured["error"],
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (
    structured["_tag"] === "waiting_for_interaction" &&
    Predicate.isString(structured["executionId"])
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (Option.isSome(interaction)) {
      return ExecutorWaitingForInteraction.make({
        executionId: structured["executionId"],
        interaction: interaction.value,
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
    if (Predicate.isString(structured["error"])) {
      error = structured["error"]
    } else if (Predicate.isString(structured["errorMessage"])) {
      error = structured["errorMessage"]
    }
    return ExecutorFailed.make({
      error,
      logs: [...readLogs(structured["logs"])],
    }) satisfies ExecutorStructuredContent
  }

  if (
    structured["status"] === "waiting_for_interaction" &&
    Predicate.isString(structured["executionId"])
  ) {
    const interaction = normalizeInteraction(structured["interaction"])
    if (Option.isSome(interaction)) {
      return ExecutorWaitingForInteraction.make({
        executionId: structured["executionId"],
        interaction: interaction.value,
      }) satisfies ExecutorStructuredContent
    }
  }

  return structured
}

const readExecutionIdOption = (structured: JsonValue): Option.Option<string> => {
  if (!isRecord(structured)) return Option.none()
  if (
    structured["_tag"] === "waiting_for_interaction" &&
    Predicate.isString(structured["executionId"])
  ) {
    return Option.some(structured["executionId"])
  }
  return Option.none()
}

export const readExecutionId = (structured: JsonValue): OptionalString =>
  Option.getOrUndefined(readExecutionIdOption(structured))

export const normalizeToolResult = (
  raw: Awaited<ReturnType<Client["callTool"]>>,
): ExecutorMcpToolResult => {
  // MCP SDK can return { toolResult } without content array
  if (!("content" in raw) || Predicate.isUndefined(raw.content)) {
    let fallback = Option.none<JsonValue>()
    if ("toolResult" in raw) fallback = Option.fromNullishOr(raw.toolResult)
    let text = DEFAULT_TEXT
    if (Option.isSome(fallback)) {
      // oxlint-disable-next-line effect/noGlobals -- MCP result serialization is the host wire boundary.
      text = JSON.stringify(fallback.value, JSON_NULL_REPLACER, 2)
    }
    return {
      text,
      structuredContent: Option.getOrNull(fallback),
      isError: false,
    }
  }

  let content: ReadonlyArray<JsonRecord> = []
  if (isRecordArray(raw.content)) content = raw.content
  const structured = Option.fromNullishOr(raw.structuredContent).pipe(
    Option.map((value) => {
      // oxlint-disable-next-line effect/noGlobals -- MCP structured content crosses a JSON host boundary.
      const serialized = JSON.stringify(value)
      // oxlint-disable-next-line effect/noGlobals -- MCP structured content crosses a JSON host boundary.
      return normalizeStructuredContent(JSON.parse(serialized))
    }),
  )
  const text = collectText(content)

  let resultText = DEFAULT_TEXT
  if (text.length > 0) {
    resultText = text
  } else if (Option.isSome(structured)) {
    // oxlint-disable-next-line effect/noGlobals -- MCP result serialization is the host wire boundary.
    resultText = JSON.stringify(structured.value, JSON_NULL_REPLACER, 2)
  }

  return {
    text: resultText,
    structuredContent: Option.getOrNull(structured),
    isError: raw.isError === true,
    executionId: Option.getOrUndefined(
      Option.flatMap(structured, (value) => readExecutionIdOption(value)),
    ),
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
    content?: JsonRecord,
  ) => Effect.Effect<ExecutorMcpToolResult, ExecutorMcpError>
}

// ── Connection helper ──

interface McpConnection {
  readonly client: Client
  readonly transport: StreamableHTTPClientTransport
}

const errorMessage = (error: JsonValue): string => {
  if (error instanceof Error) return error.message
  return String(error)
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
        message: `MCP connect failed: ${errorMessage(e)}`,
      }),
  })

const releaseConnection = (conn: McpConnection) =>
  Effect.tryPromise(() =>
    conn.transport
      .terminateSession()
      .catch(() => {})
      .then(() => conn.client.close().catch(() => {})),
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
              const listPage = (cursor: OptionalString) =>
                Effect.tryPromise({
                  try: () => {
                    if (Predicate.isUndefined(cursor)) return conn.client.listTools()
                    return conn.client.listTools({ cursor })
                  },
                  catch: (e) =>
                    new ExecutorMcpError({
                      phase: "inspect",
                      message: `MCP inspect failed: ${errorMessage(e)}`,
                    }),
                })
              type Tool = { name: string; description?: string }
              const readPage: (
                cursor: OptionalString,
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
                    if (Predicate.isUndefined(response.nextCursor)) return Effect.succeed(next)
                    return Effect.suspend(() => readPage(response.nextCursor, next))
                  }),
                )
              const tools = yield* readPage(Option.getOrUndefined(Option.none()), [])
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
                  message: `MCP execute failed: ${errorMessage(e)}`,
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
                      content: Option.match(Option.fromNullishOr(content), {
                        onNone: () => "{}",
                        onSome: (value) =>
                          // oxlint-disable-next-line effect/noGlobals -- MCP resume content is a host wire payload.
                          JSON.stringify(value),
                      }),
                    },
                  })
                  .then(normalizeToolResult),
              catch: (e) =>
                new ExecutorMcpError({
                  phase: "resume",
                  message: `MCP resume failed: ${errorMessage(e)}`,
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
