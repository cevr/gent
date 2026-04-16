/**
 * AnthropicClient wrapper for Claude Code keychain mode.
 *
 * Intercepts createMessage/createMessageStream to apply:
 * - mcp_ tool name prefix on outgoing payloads
 * - mcp_ tool name strip on incoming responses
 * - System identity injection
 * - Cache control on system messages
 *
 * This keeps all Claude Code keychain conventions in the extension,
 * out of the generic provider boundary.
 */

import { Effect, Layer, Stream } from "effect"
import { isRecord, isRecordArray } from "@gent/core/extensions/api"
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"

export { SYSTEM_IDENTITY_PREFIX } from "./oauth.js"
import { SYSTEM_IDENTITY_PREFIX } from "./oauth.js"

// ── Constants ──

const MCP_PREFIX = "mcp_"

// ── Payload Transforms (outgoing) ──

const prefixName = (name: string): string => `${MCP_PREFIX}${name}`

/** Prefix all tool names with mcp_ in the outgoing payload */
const transformTools = (
  tools: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  tools.map((tool) => {
    if (typeof tool["name"] !== "string") return tool
    return { ...tool, name: prefixName(tool["name"]) }
  })

/** Prefix tool names in historical message content blocks (tool_use) */
const transformMessages = (
  messages: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  messages.map((msg) => {
    if (!isRecordArray(msg["content"])) return msg
    return {
      ...msg,
      content: msg["content"].map((block) => {
        if (block["type"] === "tool_use" && typeof block["name"] === "string") {
          return { ...block, name: prefixName(block["name"]) }
        }
        return block
      }),
    }
  })

/** Prefix tool name in tool_choice if it specifies a particular tool */
const transformToolChoice = (toolChoice: unknown): unknown => {
  if (!isRecord(toolChoice)) return toolChoice
  if (toolChoice["type"] === "tool" && typeof toolChoice["name"] === "string") {
    return { ...toolChoice, name: prefixName(toolChoice["name"]) }
  }
  return toolChoice
}

/** Inject system identity prefix and cache control into system field */
export const transformSystem = (system: unknown): unknown => {
  if (system === undefined || system === null) return SYSTEM_IDENTITY_PREFIX

  if (typeof system === "string") {
    if (system.includes(SYSTEM_IDENTITY_PREFIX)) return system
    return `${SYSTEM_IDENTITY_PREFIX}\n\n${system}`
  }

  if (Array.isArray(system)) {
    const blocks = isRecordArray(system) ? system : []
    const hasPrefix = blocks.some((entry) => {
      const text = entry["text"]
      return typeof text === "string" && text.includes(SYSTEM_IDENTITY_PREFIX)
    })

    const withIdentity: ReadonlyArray<Record<string, unknown>> = hasPrefix
      ? blocks
      : [{ type: "text", text: SYSTEM_IDENTITY_PREFIX }, ...blocks]

    // Add cache_control to all system blocks
    return withIdentity.map((block) => ({
      ...block,
      cache_control: { type: "ephemeral" as const },
    }))
  }

  return system
}

/** Apply all outgoing transforms to a payload */
export const transformPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...payload }

  if (isRecordArray(result["tools"])) {
    result["tools"] = transformTools(result["tools"])
  }

  if (isRecordArray(result["messages"])) {
    result["messages"] = transformMessages(result["messages"])
  }

  if ("tool_choice" in result) {
    result["tool_choice"] = transformToolChoice(result["tool_choice"])
  }

  result["system"] = transformSystem(result["system"])

  return result
}

// ── Response Transforms (incoming) ──

const stripPrefix = (name: string): string =>
  name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name

/** Strip mcp_ prefix from tool_use content blocks in a non-streaming response */
export const transformResponseContent = (
  content: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  content.map((block) => {
    if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      return { ...block, name: stripPrefix(block["name"]) }
    }
    return block
  })

/** Strip mcp_ prefix from streaming content_block_start events.
 *  MessageStreamEvent uses `type` for the event kind, and `content_block` for the block data. */
export const transformStreamEvent = (
  event: AnthropicClient.MessageStreamEvent,
): AnthropicClient.MessageStreamEvent => {
  // content_block_start has type: "content_block_start" and content_block with the block data
  const e = event as Record<string, unknown>
  if (e["type"] !== "content_block_start") return event
  const rawBlock = e["content_block"]
  const block = isRecord(rawBlock) ? rawBlock : undefined
  if (block?.["type"] === "tool_use" && typeof block["name"] === "string") {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return {
      ...event,
      content_block: { ...block, name: stripPrefix(block["name"]) },
    } as AnthropicClient.MessageStreamEvent
  }
  return event
}

// ── Layer ──

type CreateMessageOptions = Parameters<AnthropicClient.Service["createMessage"]>[0]
type CreateMessageStreamOptions = Parameters<AnthropicClient.Service["createMessageStream"]>[0]

/** Wraps an AnthropicClient to apply Claude Code keychain conventions. */
export const keychainClient: Layer.Layer<
  AnthropicClient.AnthropicClient,
  never,
  AnthropicClient.AnthropicClient
> = Layer.effect(
  AnthropicClient.AnthropicClient,
  Effect.gen(function* () {
    const inner = yield* AnthropicClient.AnthropicClient

    const service: AnthropicClient.Service = {
      client: inner.client,
      streamRequest: inner.streamRequest,

      createMessage: (options: CreateMessageOptions) =>
        inner
          .createMessage({
            ...options,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            payload: transformPayload(
              options.payload as Record<string, unknown>,
            ) as typeof options.payload,
          })
          .pipe(
            Effect.map(([body, response]) => {
              const b = body as Record<string, unknown>
              const content = b["content"]
              if (isRecordArray(content)) {
                const transformed = {
                  ...b,
                  content: transformResponseContent(content),
                }
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                return [transformed as typeof body, response] as [typeof body, typeof response]
              }
              return [body, response] as [typeof body, typeof response]
            }),
          ),

      createMessageStream: (options: CreateMessageStreamOptions) =>
        inner
          .createMessageStream({
            ...options,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            payload: transformPayload(
              options.payload as Record<string, unknown>,
            ) as typeof options.payload,
          })
          .pipe(
            Effect.map(
              ([response, stream]) =>
                [response, stream.pipe(Stream.map(transformStreamEvent))] as [
                  typeof response,
                  typeof stream,
                ],
            ),
          ),
    }

    return service
  }),
)
