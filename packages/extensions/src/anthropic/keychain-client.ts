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

import { Predicate, Effect, Layer, Option, Schema, Stream } from "effect"
import { isRecord, isRecordArray } from "@gent/core/extensions/api"
import type { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"
import { Generated } from "@effect/ai-anthropic"
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"

export { SYSTEM_IDENTITY_PREFIX } from "./oauth.js"
import { SYSTEM_IDENTITY_PREFIX, getBillingHeaderInputs } from "./oauth.js"
import { AnthropicPlatform } from "./platform-adapter.js"
import { buildBillingHeaderValue } from "./signing.js"
import { getModelOverride } from "./model-config.js"

export type KeychainTransformRequirements = GentPlatform | AnthropicPlatform

// ── Constants ──

const MCP_PREFIX = "mcp_"
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header"
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>
const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>
const MessageStreamEventSchema = Schema.Union([
  Generated.BetaMessageStartEvent,
  Generated.BetaMessageDeltaEvent,
  Generated.BetaMessageStopEvent,
  Generated.BetaContentBlockStartEvent,
  Generated.BetaContentBlockDeltaEvent,
  Generated.BetaContentBlockStopEvent,
  Generated.BetaErrorResponse,
])
const decodeMessageStreamEvent = Schema.decodeUnknownSync(MessageStreamEventSchema)
const decodeMessagePayload = Schema.decodeUnknownSync(Generated.BetaCreateMessageParams)
const encodeMessagePayload = Schema.encodeUnknownSync(Generated.BetaCreateMessageParams)

// Counsel  — model-specific quirks (effort-disabled, etc.) live in
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
  let stripped = name
  if (name.startsWith(MCP_PREFIX)) stripped = name.slice(MCP_PREFIX.length)
  return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`
}

/** Prefix all tool names with mcp_ in the outgoing payload */
const transformTools = (tools: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  tools.map((tool) => {
    if (!Predicate.isString(tool["name"])) return tool
    return { ...tool, name: prefixName(tool["name"]) }
  })

/** Prefix tool names in historical message content blocks (tool_use) */
const transformMessages = (messages: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  messages.map((msg) => {
    if (!isRecordArray(msg["content"])) return msg
    return {
      ...msg,
      content: msg["content"].map((block: JsonRecord) => {
        if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
          return { ...block, name: prefixName(block["name"]) }
        }
        return block
      }),
    }
  })

/** Prefix tool name in tool_choice if it specifies a particular tool */
const transformToolChoice = (toolChoice: JsonValue): JsonValue => {
  if (!isRecord(toolChoice)) return toolChoice
  if (toolChoice["type"] === "tool" && Predicate.isString(toolChoice["name"])) {
    return { ...toolChoice, name: prefixName(toolChoice["name"]) } satisfies JsonRecord
  }
  return toolChoice
}

/**
 * Counsel  (opencode parity B) — drop orphan `tool_use` blocks (no
 * matching downstream `tool_result`) and orphan `tool_result` blocks
 * (no matching upstream `tool_use`) from message history. Anthropic
 * rejects requests with mismatched pairs (HTTP 400), and a partial turn
 * failure or mid-stream cancel can easily strand one half of a pair.
 *
 * After filtering, messages whose `content` array empties out are
 * dropped entirely so the API doesn't see `{ role, content: [] }`.
 */
type ToolPairIds = {
  readonly toolUseIds: ReadonlySet<string>
  readonly toolResultIds: ReadonlySet<string>
}

const collectToolPairIds = (messages: ReadonlyArray<JsonRecord>): ToolPairIds => {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const message of messages) {
    if (!isRecordArray(message["content"])) continue
    for (const block of message["content"]) {
      const id = block["id"]
      if (block["type"] === "tool_use" && Predicate.isString(id)) {
        toolUseIds.add(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block["type"] === "tool_result" && Predicate.isString(toolUseId)) {
        toolResultIds.add(toolUseId)
      }
    }
  }

  return { toolUseIds, toolResultIds }
}

const findOrphanedIds = (
  ids: ReadonlySet<string>,
  matchingIds: ReadonlySet<string>,
): ReadonlySet<string> => {
  const orphaned = new Set<string>()
  for (const id of ids) {
    if (!matchingIds.has(id)) orphaned.add(id)
  }
  return orphaned
}

const filterToolPairMessage = (
  message: JsonRecord,
  orphanedUses: ReadonlySet<string>,
  orphanedResults: ReadonlySet<string>,
): Option.Option<JsonRecord> => {
  if (!isRecordArray(message["content"])) return Option.some(message)
  const next = message["content"].filter((block: JsonRecord) => {
    const id = block["id"]
    if (block["type"] === "tool_use" && Predicate.isString(id)) {
      return !orphanedUses.has(id)
    }
    const toolUseId = block["tool_use_id"]
    if (block["type"] === "tool_result" && Predicate.isString(toolUseId)) {
      return !orphanedResults.has(toolUseId)
    }
    return true
  })
  if (next.length === 0) return Option.none()
  return Option.some({ ...message, content: next })
}

/** Remove unpaired tool-use and tool-result blocks from message history. */
export const repairToolPairs = (messages: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> => {
  const { toolUseIds, toolResultIds } = collectToolPairIds(messages)
  const orphanedUses = findOrphanedIds(toolUseIds, toolResultIds)
  const orphanedResults = findOrphanedIds(toolResultIds, toolUseIds)

  if (orphanedUses.size === 0 && orphanedResults.size === 0) return messages

  const filtered: JsonRecord[] = []
  for (const message of messages) {
    const next = filterToolPairMessage(message, orphanedUses, orphanedResults)
    if (Option.isSome(next)) filtered.push(next.value)
  }
  return filtered
}

/**
 * Coerce `system` (string | array | undefined) into the canonical block
 * array shape used by the rest of the pipeline. The downstream billing
 * + identity injection expects an array — string input is wrapped.
 */
const normalizeSystemBlocks = (system: JsonValue): ReadonlyArray<JsonRecord> =>
  Option.match(Option.fromNullishOr(system), {
    onNone: () => [],
    onSome: (value) => {
      if (Predicate.isString(value)) return [{ type: "text", text: value }]
      if (Array.isArray(value) && isRecordArray(value)) return value
      return []
    },
  })

/**
 * Drop any `system[]` entry that already carries a billing-header text
 * block — we re-compute the header per request from the live messages
 * so a stale entry from an earlier turn would otherwise sit alongside
 * the fresh one and confuse the validator.
 */
const stripExistingBillingBlocks = (blocks: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  blocks.filter((block) => {
    const text = block["text"]
    return !(Predicate.isString(text) && text.startsWith(BILLING_HEADER_PREFIX))
  })

/**
 * Split caller-provided system blocks into the identity entry, billing
 * entries (always discarded — re-computed per-request), and everything
 * else (the movable third-party content). Used by the relocator to
 * decide what to pull into the first user message before billing is
 * computed.
 *
 * Counsel  deep — a single block carrying `IDENTITY + "\n\n<rest>"`
 * (the shape OpenCode's `system.transform` hook produces) used to
 * classify as identity-only and silently drop `<rest>`. Now we split
 * the block at the identity boundary: identity goes to identityBlocks,
 * the trailing remainder rides along as third-party so the relocator
 * pulls it into the first user message.
 */
type PartitionedSystemBlocks = {
  readonly identityBlocks: ReadonlyArray<JsonRecord>
  readonly thirdPartyBlocks: ReadonlyArray<JsonRecord>
}

const partitionSystemBlocks = (callerSystem: JsonValue): PartitionedSystemBlocks => {
  const blocks = stripExistingBillingBlocks(normalizeSystemBlocks(callerSystem))
  const identityBlocks: JsonRecord[] = []
  const thirdPartyBlocks: JsonRecord[] = []
  for (const block of blocks) {
    const text = block["text"]
    if (Predicate.isString(text) && text.startsWith(SYSTEM_IDENTITY_PREFIX)) {
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
 * After  relocation there are no third-party blocks left to attach;
 * any third-party content was pulled into the first user message
 * before this builder ran. Identity must be its own entry —
 * concatenating it into another text block trips the validator
 * (opencode issue #98). The billing block MUST NOT carry cache_control:
 * Anthropic rejects requests exceeding 4 cache_control blocks per
 * request, and the billing entry would count toward that limit.
 *
 * Counsel  — caller MUST pass the FINAL post-relocation messages so
 * the billing hash matches the first-user text actually sent on the
 * wire. Computing the hash from pre-relocation messages produces a
 * stale digest and 400s.
 */
const buildSystemArray = (
  finalMessages: ReadonlyArray<JsonRecord>,
): Effect.Effect<ReadonlyArray<JsonRecord>, never, KeychainTransformRequirements> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const { version, entrypoint } = getBillingHeaderInputs(platform.env)
    const billing = yield* buildBillingHeaderValue(finalMessages, version, entrypoint)

    return [
      { type: "text", text: billing },
      { type: "text", text: SYSTEM_IDENTITY_PREFIX },
    ]
  })

/**
 * Counsel  (opencode parity A) — Anthropic's OAuth-billing path
 * validates `system[]` against the Claude Code identity prefix.
 * Third-party system content alongside the prefix trips a 400 "out of
 * extra usage" rejection. The relocator takes the third-party blocks
 * (already partitioned by `partitionSystemBlocks`) and folds them into
 * the first user message as a single text block.
 *
 * Counsel  follow-up:
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
  thirdPartyBlocks: ReadonlyArray<JsonRecord>,
  messages: ReadonlyArray<JsonRecord>,
): ReadonlyArray<JsonRecord> => {
  const movedTexts: string[] = []
  for (const block of thirdPartyBlocks) {
    const text = block["text"]
    if (Predicate.isString(text) && text.length > 0) movedTexts.push(text)
  }
  if (movedTexts.length === 0) return messages

  const firstUserIdx = messages.findIndex((m) => m["role"] === "user")
  if (firstUserIdx === -1) return messages

  const firstUser = Option.fromUndefinedOr(messages[firstUserIdx])
  if (Option.isNone(firstUser)) return messages
  const firstUserValue = firstUser.value
  const content = firstUserValue["content"]
  const prefix = movedTexts.join("\n\n")
  const nextMessages = messages.slice()

  if (Predicate.isString(content)) {
    nextMessages[firstUserIdx] = { ...firstUserValue, content: `${prefix}\n\n${content}` }
    return nextMessages
  }
  if (isRecordArray(content)) {
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
    nextMessages[firstUserIdx] = {
      ...firstUserValue,
      content: [
        ...content.slice(0, firstNonToolResult),
        { type: "text", text: prefix },
        ...content.slice(firstNonToolResult),
      ],
    }
    return nextMessages
  }
  // Unknown content shape — bail out rather than mangling it.
  return messages
}

/**
 * Counsel  (opencode parity C) — strip the effort knob for models
 * that don't support it (haiku family). Anthropic returns 400 if
 * effort is sent with a haiku model. We strip from BOTH
 * `output_config.effort` (the shape gent emits today via
 * `anthropic/index.ts` `buildAnthropicConfig`) AND `thinking.effort`
 * (the shape the upstream Anthropic SDK may emit in future versions —
 * matches the opencode reference). Each branch deletes the parent
 * object if it empties out.
 *
 *  will replace the `claude-haiku` prefix match with the per-model
 * override table from opencode-claude-auth's `model-config.ts`.
 */
const stripObjectKey = (parent: JsonRecord, key: string): Option.Option<JsonRecord> => {
  if (!(key in parent)) return Option.some(parent)
  const { [key]: _removed, ...rest } = parent
  if (Object.keys(rest).length === 0) return Option.none()
  return Option.some(rest)
}

const stripHaikuEffort = (payload: JsonRecord): JsonRecord => {
  const model = payload["model"]
  if (!Predicate.isString(model)) return payload
  // Counsel  — defer to the per-model override table instead of
  // string-prefix matching here. `disableEffort` is currently set for
  // the `haiku` family in `MODEL_CONFIG`.
  const override = getModelOverride(model)
  if (Option.isNone(override) || override.value.disableEffort !== true) return payload

  const next = { ...payload }
  const outputConfig = next["output_config"]
  if (isRecord(outputConfig)) {
    const stripped = stripObjectKey(outputConfig, "effort")
    Option.match(stripped, {
      onNone: () => delete next["output_config"],
      onSome: (value) => {
        next["output_config"] = value
      },
    })
  }
  const thinking = next["thinking"]
  if (isRecord(thinking)) {
    const stripped = stripObjectKey(thinking, "effort")
    Option.match(stripped, {
      onNone: () => delete next["thinking"],
      onSome: (value) => {
        next["thinking"] = value
      },
    })
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
export const transformPayload = (
  payload: JsonRecord,
): Effect.Effect<JsonRecord, never, KeychainTransformRequirements> =>
  Effect.gen(function* () {
    let result = { ...payload }

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
    let messagesAfterRelocate: ReadonlyArray<JsonRecord> = []
    if (isRecordArray(result["messages"])) {
      messagesAfterRelocate = relocateThirdPartyIntoFirstUser(thirdPartyBlocks, result["messages"])
    }
    result["messages"] = messagesAfterRelocate
    result["system"] = yield* buildSystemArray(messagesAfterRelocate)

    result = stripHaikuEffort(result)

    return result
  })

// ── Response Transforms (incoming) ──

/** Strip `mcp_` and lowercase the first char so gent sees its
 *  registered tool name (`Bash` from the wire → `bash` internally). */
const stripPrefix = (name: string): string => unprefixName(name)

/** Strip mcp_ prefix from tool_use content blocks in a non-streaming response */
export const transformResponseContent = (
  content: ReadonlyArray<JsonRecord>,
): ReadonlyArray<JsonRecord> =>
  content.map((block) => {
    if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
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
  const e = Schema.decodeSync(JsonRecordSchema)(event)
  if (e["type"] !== "content_block_start") return event
  const rawBlock = e["content_block"]
  if (!isRecord(rawBlock)) return event
  const block = rawBlock
  if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
    return decodeMessageStreamEvent({
      ...event,
      content_block: { ...block, name: stripPrefix(block["name"]) },
    })
  }
  return event
}

// ── Layer ──

type CreateMessageOptions = Parameters<AnthropicClient.Service["createMessage"]>[0]
type CreateMessageStreamOptions = Parameters<AnthropicClient.Service["createMessageStream"]>[0]

/** Wraps an AnthropicClient to apply Claude Code keychain conventions. */
export const makeKeychainClientLayer: Layer.Layer<
  AnthropicClient.AnthropicClient,
  never,
  AnthropicClient.AnthropicClient | KeychainTransformRequirements
> = Layer.effect(
  AnthropicClient.AnthropicClient,
  Effect.gen(function* () {
    const inner = yield* AnthropicClient.AnthropicClient
    const transformContext = yield* Effect.context<KeychainTransformRequirements>()
    const transformPayloadHere = (payload: JsonRecord) =>
      transformPayload(payload).pipe(Effect.provideContext(transformContext))

    const service: AnthropicClient.Service = {
      client: inner.client,
      streamRequest: inner.streamRequest,

      createMessage: (options: CreateMessageOptions) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeEffect(JsonRecordSchema)(options.payload).pipe(
            Effect.orDie,
          )
          const transformed = yield* transformPayloadHere(payload)
          return yield* inner.createMessage({
            ...options,
            payload: encodeMessagePayload(decodeMessagePayload(transformed)),
          })
        }).pipe(
          Effect.map(([body, response]) => {
            const b = Schema.decodeSync(JsonRecordSchema)(body)
            const content = b["content"]
            if (isRecordArray(content)) {
              const transformed = {
                ...b,
                content: transformResponseContent(content),
              }
              return [
                Schema.decodeUnknownSync(Generated.BetaMessage)(transformed),
                response,
              ] satisfies [typeof body, typeof response]
            }
            return [body, response] satisfies [typeof body, typeof response]
          }),
        ),

      createMessageStream: (options: CreateMessageStreamOptions) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeEffect(JsonRecordSchema)(options.payload).pipe(
            Effect.orDie,
          )
          const transformed = yield* transformPayloadHere(payload)
          return yield* inner.createMessageStream({
            ...options,
            payload: encodeMessagePayload(decodeMessagePayload(transformed)),
          })
        }).pipe(
          Effect.map(([response, stream]) => [
            response,
            stream.pipe(Stream.map(transformStreamEvent)),
          ]),
        ),
    }

    return service
  }),
)
