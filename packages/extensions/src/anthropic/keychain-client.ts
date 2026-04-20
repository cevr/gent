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
import { SYSTEM_IDENTITY_PREFIX, getBillingHeaderInputs } from "./oauth.js"
import { buildBillingHeaderValue } from "./signing.js"

// ── Constants ──

const MCP_PREFIX = "mcp_"
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header"

// Counsel C7 — opencode parity. Models that don't accept the
// `output_config.effort` knob: Anthropic rejects haiku requests with the
// effort param set. Match by prefix so future haiku versions roll
// forward automatically. (opencode reference uses a richer per-model
// override map, ported in C8.)
const HAIKU_PREFIX = "claude-haiku"

// ── Payload Transforms (outgoing) ──

/**
 * Prefix tool names with `mcp_` AND uppercase the first letter — Claude
 * Code uses PascalCase tool names (`mcp_Bash`, `mcp_Read`); lowercase
 * names trip the Anthropic OAuth-billing validation when multiple tools
 * are present (verified in opencode-claude-auth issue notes).
 */
const prefixName = (name: string): string =>
  `${MCP_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** Reverse `prefixName`: drop `mcp_` and lowercase the first char. */
const unprefixName = (name: string): string => {
  const stripped = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
  return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`
}

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

/**
 * Counsel C7 (opencode parity B) — drop orphan `tool_use` blocks (no
 * matching downstream `tool_result`) and orphan `tool_result` blocks
 * (no matching upstream `tool_use`) from message history. Anthropic
 * rejects requests with mismatched pairs (HTTP 400), and a partial turn
 * failure or mid-stream cancel can easily strand one half of a pair.
 *
 * After filtering, messages whose `content` array empties out are
 * dropped entirely so the API doesn't see `{ role, content: [] }`.
 */
export const repairToolPairs = (
  messages: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> => {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const message of messages) {
    if (!isRecordArray(message["content"])) continue
    for (const block of message["content"]) {
      const id = block["id"]
      if (block["type"] === "tool_use" && typeof id === "string") {
        toolUseIds.add(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block["type"] === "tool_result" && typeof toolUseId === "string") {
        toolResultIds.add(toolUseId)
      }
    }
  }

  const orphanedUses = new Set<string>()
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id)
  }
  const orphanedResults = new Set<string>()
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id)
  }

  if (orphanedUses.size === 0 && orphanedResults.size === 0) return messages

  const filtered: Record<string, unknown>[] = []
  for (const message of messages) {
    if (!isRecordArray(message["content"])) {
      filtered.push(message)
      continue
    }
    const next = message["content"].filter((block) => {
      const id = block["id"]
      if (block["type"] === "tool_use" && typeof id === "string") {
        return !orphanedUses.has(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block["type"] === "tool_result" && typeof toolUseId === "string") {
        return !orphanedResults.has(toolUseId)
      }
      return true
    })
    if (next.length === 0) continue
    filtered.push({ ...message, content: next })
  }
  return filtered
}

/**
 * Coerce `system` (string | array | undefined) into the canonical block
 * array shape used by the rest of the pipeline. The downstream billing
 * + identity injection expects an array — string input is wrapped.
 */
const normalizeSystemBlocks = (system: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (system === undefined || system === null) return []
  if (typeof system === "string") return [{ type: "text", text: system }]
  if (Array.isArray(system) && isRecordArray(system)) return system
  return []
}

/**
 * Drop any `system[]` entry that already carries a billing-header text
 * block — we re-compute the header per request from the live messages
 * so a stale entry from an earlier turn would otherwise sit alongside
 * the fresh one and confuse the validator.
 */
const stripExistingBillingBlocks = (
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> =>
  blocks.filter((block) => {
    const text = block["text"]
    return !(typeof text === "string" && text.startsWith(BILLING_HEADER_PREFIX))
  })

/**
 * Build the final `system[]` array with the strict shape Anthropic's
 * OAuth billing validator expects:
 *
 *   [0] billing-header text block (no cache_control)
 *   [1] identity prefix text block (no cache_control)
 *   [2..] caller's other system blocks, each gets cache_control
 *
 * Identity must be its own entry — concatenating it into another text
 * block trips the validator (opencode issue #98). The billing block
 * MUST NOT carry cache_control: Anthropic rejects requests that exceed
 * 4 cache_control blocks per request, and the billing entry counts
 * toward that limit if marked.
 */
const buildSystemArray = (
  callerSystem: unknown,
  messages: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> => {
  const callerBlocks = stripExistingBillingBlocks(normalizeSystemBlocks(callerSystem))
  const { version, entrypoint } = getBillingHeaderInputs()
  // Cast through unknown — the Message type in signing.ts is a tighter
  // shape than the wire-level Record we receive from the SDK. The
  // signature only reads `role` + `content` defensively.
  const billing = buildBillingHeaderValue(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    messages as ReadonlyArray<{ role?: string; content?: string }>,
    version,
    entrypoint,
  )

  // Pull any caller-provided identity entry out so we can re-emit it
  // separately (without cache_control) right after billing.
  const withoutIdentity = callerBlocks.filter((block) => {
    const text = block["text"]
    return !(typeof text === "string" && text.startsWith(SYSTEM_IDENTITY_PREFIX))
  })

  const otherBlocks = withoutIdentity.map((block) => ({
    ...block,
    cache_control: { type: "ephemeral" as const },
  }))

  return [
    { type: "text", text: billing },
    { type: "text", text: SYSTEM_IDENTITY_PREFIX },
    ...otherBlocks,
  ]
}

/** @deprecated kept for the existing test surface — use `buildSystemArray`
 *  via `transformPayload`. The legacy single-arg shape can't compute the
 *  billing hash because it has no access to the messages. */
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

    return withIdentity.map((block) => ({
      ...block,
      cache_control: { type: "ephemeral" as const },
    }))
  }

  return system
}

/**
 * Counsel C7 (opencode parity A) — Anthropic's OAuth-billing path
 * validates the `system[]` array against the Claude Code identity
 * prefix. Third-party system content sitting alongside the prefix
 * trips a 400 "out of extra usage" rejection. This relocator pulls
 * any non-billing, non-identity system blocks out of `system[]` and
 * prepends them to the first user message as a single text block
 * (functionally equivalent because Anthropic's LLM concatenates
 * system + first-user anyway, but the validator now sees a clean
 * Claude-Code-shaped system array).
 *
 * Returns the new messages array; mutates nothing.
 */
const relocateSystemContent = (
  systemBlocks: ReadonlyArray<Record<string, unknown>>,
  messages: ReadonlyArray<Record<string, unknown>>,
): {
  readonly system: ReadonlyArray<Record<string, unknown>>
  readonly messages: ReadonlyArray<Record<string, unknown>>
} => {
  const kept: Record<string, unknown>[] = []
  const movedTexts: string[] = []
  for (const block of systemBlocks) {
    const text = block["text"]
    const txt = typeof text === "string" ? text : ""
    if (txt.startsWith(BILLING_HEADER_PREFIX) || txt.startsWith(SYSTEM_IDENTITY_PREFIX)) {
      kept.push(block)
    } else if (txt.length > 0) {
      movedTexts.push(txt)
    } else {
      // Non-text blocks (cache_control sentinels, etc.) ride along
      // with `kept` — we only relocate text content.
      kept.push(block)
    }
  }
  if (movedTexts.length === 0) return { system: systemBlocks, messages }

  const firstUserIdx = messages.findIndex((m) => m["role"] === "user")
  if (firstUserIdx === -1) return { system: systemBlocks, messages }

  const prefix = movedTexts.join("\n\n")
  const firstUser = messages[firstUserIdx]
  if (firstUser === undefined) return { system: systemBlocks, messages }
  const content = firstUser["content"]
  let newContent: unknown
  if (typeof content === "string") {
    newContent = `${prefix}\n\n${content}`
  } else if (isRecordArray(content)) {
    newContent = [{ type: "text", text: prefix }, ...content]
  } else {
    // Unknown content shape — bail out rather than mangling it.
    return { system: systemBlocks, messages }
  }

  const nextMessages = messages.slice()
  nextMessages[firstUserIdx] = { ...firstUser, content: newContent }
  return { system: kept, messages: nextMessages }
}

/**
 * Counsel C7 (opencode parity C) — strip `output_config.effort` for
 * models that don't support it (haiku family). Anthropic returns 400
 * if effort is sent with a haiku model. The caller (`anthropic/index.ts`
 * `buildAnthropicConfig`) sets `output_config.effort` from the gent
 * reasoning level; we surgically remove it for haiku rather than
 * making the caller model-aware.
 */
const stripHaikuEffort = (payload: Record<string, unknown>): Record<string, unknown> => {
  const model = payload["model"]
  if (typeof model !== "string" || !model.startsWith(HAIKU_PREFIX)) return payload
  const outputConfig = payload["output_config"]
  if (!isRecord(outputConfig) || !("effort" in outputConfig)) return payload
  const { effort: _effort, ...rest } = outputConfig
  const next = { ...payload }
  if (Object.keys(rest).length === 0) {
    delete next["output_config"]
  } else {
    next["output_config"] = rest
  }
  return next
}

/**
 * Apply every outgoing OAuth-billing transform. Order is load-bearing:
 *   1. Tools first — billing sees the `tools` array indirectly via the
 *      messages, but PascalCase prefix must be applied so the wire
 *      format matches what Claude Code itself sends.
 *   2. repairToolPairs (counsel C7 / opencode parity B) — drop orphan
 *      tool_use / tool_result blocks BEFORE PascalCase prefixing so we
 *      don't compute billing from a message that the API would reject.
 *   3. Messages next — same reason as tools; tool_use blocks in
 *      history need PascalCase prefixing before billing inspects the
 *      user text.
 *   4. tool_choice — independent.
 *   5. system — depends on the (already-prefixed) messages array to
 *      compute the billing hash.
 *   6. relocateSystemContent (counsel C7 / opencode parity A) — pull
 *      third-party system blocks into the first user message AFTER
 *      buildSystemArray attaches the billing + identity entries, so
 *      the relocator only sees post-attach state and never moves the
 *      billing/identity blocks out by mistake.
 *   7. stripHaikuEffort (counsel C7 / opencode parity C) — final
 *      payload-shape correction independent of the others.
 */
export const transformPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  let result: Record<string, unknown> = { ...payload }

  if (isRecordArray(result["tools"])) {
    result["tools"] = transformTools(result["tools"])
  }

  if (isRecordArray(result["messages"])) {
    result["messages"] = repairToolPairs(result["messages"])
  }

  if (isRecordArray(result["messages"])) {
    result["messages"] = transformMessages(result["messages"])
  }

  if ("tool_choice" in result) {
    result["tool_choice"] = transformToolChoice(result["tool_choice"])
  }

  const messages = isRecordArray(result["messages"]) ? result["messages"] : []
  const systemAfterBuild = buildSystemArray(result["system"], messages)
  const relocated = relocateSystemContent(systemAfterBuild, messages)
  result["system"] = relocated.system
  result["messages"] = relocated.messages

  result = stripHaikuEffort(result)

  return result
}

// ── Response Transforms (incoming) ──

/** Strip `mcp_` and lowercase the first char so gent sees its
 *  registered tool name (`Bash` from the wire → `bash` internally). */
const stripPrefix = (name: string): string => unprefixName(name)

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
