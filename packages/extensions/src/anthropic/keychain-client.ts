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
import { getModelOverride } from "./model-config.js"

// ── Constants ──

const MCP_PREFIX = "mcp_"
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header"

// Counsel C8 — model-specific quirks (effort-disabled, etc.) live in
// `model-config.ts`'s `MODEL_OVERRIDES` table; we read them via
// `getModelOverride(modelId).disableEffort` rather than a prefix check
// hard-coded here.

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
 * Split caller-provided system blocks into the identity entry, billing
 * entries (always discarded — re-computed per-request), and everything
 * else (the movable third-party content). Used by the relocator to
 * decide what to pull into the first user message before billing is
 * computed.
 *
 * Counsel C8 deep — a single block carrying `IDENTITY + "\n\n<rest>"`
 * (the shape OpenCode's `system.transform` hook produces) used to
 * classify as identity-only and silently drop `<rest>`. Now we split
 * the block at the identity boundary: identity goes to identityBlocks,
 * the trailing remainder rides along as third-party so the relocator
 * pulls it into the first user message.
 */
const partitionSystemBlocks = (
  callerSystem: unknown,
): {
  readonly identityBlocks: ReadonlyArray<Record<string, unknown>>
  readonly thirdPartyBlocks: ReadonlyArray<Record<string, unknown>>
} => {
  const blocks = stripExistingBillingBlocks(normalizeSystemBlocks(callerSystem))
  const identityBlocks: Record<string, unknown>[] = []
  const thirdPartyBlocks: Record<string, unknown>[] = []
  for (const block of blocks) {
    const text = block["text"]
    if (typeof text === "string" && text.startsWith(SYSTEM_IDENTITY_PREFIX)) {
      const rest = text.slice(SYSTEM_IDENTITY_PREFIX.length).replace(/^\n+/, "")
      const { text: _t, cache_control: _cc, ...rest_props } = block
      // Identity itself rides without cache_control (validator rejects
      // a marked identity block — counts toward the 4-block limit).
      identityBlocks.push({ ...rest_props, text: SYSTEM_IDENTITY_PREFIX })
      if (rest.length > 0) {
        // Remainder picks back up the original block's `cache_control`
        // and other props so users can still mark long instructions
        // for prompt caching.
        thirdPartyBlocks.push({ ...block, text: rest })
      }
    } else {
      thirdPartyBlocks.push(block)
    }
  }
  return { identityBlocks, thirdPartyBlocks }
}

/**
 * Build the final `system[]` array with the strict shape Anthropic's
 * OAuth billing validator expects:
 *
 *   [0] billing-header text block (no cache_control)
 *   [1] identity prefix text block (no cache_control)
 *
 * After C7 relocation there are no third-party blocks left to attach;
 * any third-party content was pulled into the first user message
 * before this builder ran. Identity must be its own entry —
 * concatenating it into another text block trips the validator
 * (opencode issue #98). The billing block MUST NOT carry cache_control:
 * Anthropic rejects requests exceeding 4 cache_control blocks per
 * request, and the billing entry would count toward that limit.
 *
 * Counsel C7 — caller MUST pass the FINAL post-relocation messages so
 * the billing hash matches the first-user text actually sent on the
 * wire. Computing the hash from pre-relocation messages produces a
 * stale digest and 400s.
 */
const buildSystemArray = (
  finalMessages: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> => {
  const { version, entrypoint } = getBillingHeaderInputs()
  // Cast through unknown — the Message type in signing.ts is a tighter
  // shape than the wire-level Record we receive from the SDK. The
  // signature only reads `role` + `content` defensively.
  const billing = buildBillingHeaderValue(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
    finalMessages as ReadonlyArray<{ role?: string; content?: string }>,
    version,
    entrypoint,
  )

  return [
    { type: "text", text: billing },
    { type: "text", text: SYSTEM_IDENTITY_PREFIX },
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
 * validates `system[]` against the Claude Code identity prefix.
 * Third-party system content alongside the prefix trips a 400 "out of
 * extra usage" rejection. The relocator takes the third-party blocks
 * (already partitioned by `partitionSystemBlocks`) and folds them into
 * the first user message as a single text block.
 *
 * Counsel C7 follow-up:
 *   - tool_result ordering: Anthropic requires tool_result blocks to be
 *     the FIRST blocks of a user message that carries any. Inserting
 *     text at index 0 in such a message produces 400. We splice the
 *     relocated text in AFTER the leading run of tool_result blocks.
 *   - billing freshness: this runs BEFORE buildSystemArray so the
 *     billing hash is computed from the FINAL first-user text. The
 *     pre-fix shape computed billing first, then mutated the message,
 *     so the wire hash didn't match the wire text.
 *
 * Returns the new messages array; mutates nothing.
 */
const relocateThirdPartyIntoFirstUser = (
  thirdPartyBlocks: ReadonlyArray<Record<string, unknown>>,
  messages: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> => {
  const movedTexts: string[] = []
  for (const block of thirdPartyBlocks) {
    const text = block["text"]
    if (typeof text === "string" && text.length > 0) movedTexts.push(text)
  }
  if (movedTexts.length === 0) return messages

  const firstUserIdx = messages.findIndex((m) => m["role"] === "user")
  if (firstUserIdx === -1) return messages

  const firstUser = messages[firstUserIdx]
  if (firstUser === undefined) return messages
  const content = firstUser["content"]
  const prefix = movedTexts.join("\n\n")

  let newContent: unknown
  if (typeof content === "string") {
    newContent = `${prefix}\n\n${content}`
  } else if (isRecordArray(content)) {
    // Find the index where leading tool_result blocks end. Inserting
    // text before that boundary trips Anthropic's "tool_result must
    // come first" check.
    let firstNonToolResult = 0
    while (
      firstNonToolResult < content.length &&
      content[firstNonToolResult]?.["type"] === "tool_result"
    ) {
      firstNonToolResult += 1
    }
    newContent = [
      ...content.slice(0, firstNonToolResult),
      { type: "text", text: prefix },
      ...content.slice(firstNonToolResult),
    ]
  } else {
    // Unknown content shape — bail out rather than mangling it.
    return messages
  }

  const nextMessages = messages.slice()
  nextMessages[firstUserIdx] = { ...firstUser, content: newContent }
  return nextMessages
}

/**
 * Counsel C7 (opencode parity C) — strip the effort knob for models
 * that don't support it (haiku family). Anthropic returns 400 if
 * effort is sent with a haiku model. We strip from BOTH
 * `output_config.effort` (the shape gent emits today via
 * `anthropic/index.ts` `buildAnthropicConfig`) AND `thinking.effort`
 * (the shape the upstream Anthropic SDK may emit in future versions —
 * matches the opencode reference). Each branch deletes the parent
 * object if it empties out.
 *
 * C8 will replace the `claude-haiku` prefix match with the per-model
 * override table from opencode-claude-auth's `model-config.ts`.
 */
const stripObjectKey = (
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  if (!(key in parent)) return parent
  const { [key]: _removed, ...rest } = parent
  return Object.keys(rest).length === 0 ? undefined : rest
}

const stripHaikuEffort = (payload: Record<string, unknown>): Record<string, unknown> => {
  const model = payload["model"]
  if (typeof model !== "string") return payload
  // Counsel C8 — defer to the per-model override table instead of
  // string-prefix matching here. `disableEffort` is currently set for
  // the `haiku` family in `MODEL_CONFIG`.
  const override = getModelOverride(model)
  if (override?.disableEffort !== true) return payload

  const next = { ...payload }
  const outputConfig = next["output_config"]
  if (isRecord(outputConfig)) {
    const stripped = stripObjectKey(outputConfig, "effort")
    if (stripped === undefined) delete next["output_config"]
    else next["output_config"] = stripped
  }
  const thinking = next["thinking"]
  if (isRecord(thinking)) {
    const stripped = stripObjectKey(thinking, "effort")
    if (stripped === undefined) delete next["thinking"]
    else next["thinking"] = stripped
  }
  return next
}

/**
 * Apply every outgoing OAuth-billing transform. Order is load-bearing —
 * relocation MUST run BEFORE billing computation because the relocator
 * changes the first-user message text and the billing hash MUST match
 * what's on the wire:
 *
 *   1. transformTools — PascalCase mcp_ prefix on tool names.
 *   2. repairToolPairs — drop orphan tool_use / tool_result blocks
 *      before they can poison the billing hash or trip the API.
 *   3. transformMessages — PascalCase mcp_ prefix on tool_use blocks
 *      in history.
 *   4. transformToolChoice — independent.
 *   5. relocateThirdPartyIntoFirstUser — pull non-billing/non-identity
 *      system blocks into the first user message FIRST, so the
 *      billing hash in step 6 sees the final wire text.
 *   6. buildSystemArray — compute billing from FINAL (post-relocation)
 *      messages; emit the strict `[billing, identity]` system shape.
 *   7. stripHaikuEffort — final payload correction; independent.
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

  const { thirdPartyBlocks } = partitionSystemBlocks(result["system"])
  const messagesAfterRelocate = isRecordArray(result["messages"])
    ? relocateThirdPartyIntoFirstUser(thirdPartyBlocks, result["messages"])
    : []
  result["messages"] = messagesAfterRelocate
  result["system"] = buildSystemArray(messagesAfterRelocate)

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
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
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
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
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
                return [transformed as typeof body, response] as [typeof body, typeof response]
              }
              return [body, response] as [typeof body, typeof response]
            }),
          ),

      createMessageStream: (options: CreateMessageStreamOptions) =>
        inner
          .createMessageStream({
            ...options,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
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
