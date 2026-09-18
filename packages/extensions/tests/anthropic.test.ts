import { describe, expect, it, test } from "effect-bun-test"
import {
  AnthropicBetaCache,
  type AnthropicBetaCacheApi,
  type AnthropicCredentialIO,
  AnthropicCredentialService,
  type AnthropicKeychainEnv,
  AnthropicPlatform,
  type BetaCacheCell,
  buildAnthropicModelDriver as buildAnthropicModelDriverLive,
  buildBillingHeaderValue as buildBillingHeaderValueEffect,
  buildKeychainTransformClient,
  type ClaudeCredentials,
  computeCch as computeCchEffect,
  computeVersionSuffix as computeVersionSuffixEffect,
  EMPTY_BETA_CELL,
  extractFirstUserMessageText,
  freshEnoughForUse,
  getCcVersion,
  getModelBetas,
  getModelOverride,
  isLongContextError,
  MODEL_CONFIG,
  parseOAuthResponse,
  PRIMARY_CLAUDE_SERVICE,
  repairToolPairs,
  shouldFallBackToCli,
  shouldFallBackToCredentialsFile,
  supports1mContext,
  SYSTEM_IDENTITY_PREFIX,
  transformPayload as transformPayloadEffect,
  transformResponseContent,
  transformStreamEvent,
  updateCredentialBlob,
} from "../src/anthropic.js"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import type * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { ExtensionHostProcessError } from "@gent/core-internal/domain/extension"
import { BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { testHostFacts } from "@gent/core-internal/test-utils/index"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import {
  type CredentialCache,
  type CredentialCacheCell,
  EMPTY_CREDENTIAL_CELL,
} from "../src/providers.js"
import {
  type ExtensionHostService,
  ProviderAuthError,
  type ProviderAuthInfo,
} from "@gent/core/extensions/api"
import { runEffectBoundary } from "./run-effect-boundary.js"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import { createHash } from "node:crypto"
import { LanguageModel, Prompt } from "effect/unstable/ai"
import {
  fakeFetchLayer,
  type FakeFetchState,
  makeFakeFetchState,
  oneGenerate,
} from "@gent/core-internal/test-utils/language-model"

// ── anthropic/anthropic-keychain.test ───────────────────────────────────────

describe("isLongContextError", () => {
  test("detects extra usage error", () => {
    expect(isLongContextError("Extra usage is required for long context requests")).toBe(true)
  })

  test("detects subscription error", () => {
    expect(
      isLongContextError("The long context beta is not yet available for this subscription."),
    ).toBe(true)
  })

  test("detects errors in JSON", () => {
    expect(
      isLongContextError(
        '{"error": {"message": "Extra usage is required for long context requests"}}',
      ),
    ).toBe(true)
  })

  test("does not match other errors", () => {
    expect(isLongContextError("Some other error message")).toBe(false)
    expect(isLongContextError("")).toBe(false)
  })
})

// ── anthropic/anthropic-keychain-client.test ────────────────────────────────

const testPlatformLayer = Layer.succeed(
  AnthropicPlatform,
  AnthropicPlatform.of({
    platform: "darwin",
    home: "/tmp/gent-test-home",
    parentEnv: {},
    runProcess: (command) =>
      Effect.fail(
        new ExtensionHostProcessError({
          command,
          message: "test runProcess unavailable",
        }),
      ),
    env: {},
  }),
)

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>

// Synchronously run a transformPayload effect with the live Bun platform —
// `BunGentPlatformLive` is `Layer.succeed`, so the underlying SHA256 hash is
// computed eagerly without needing an async runtime.
const transformPayload = (payload: JsonRecord): JsonRecord =>
  Effect.runSync(
    transformPayloadEffect(payload).pipe(
      Effect.provide(Layer.merge(BunGentPlatformLive, testPlatformLayer)),
    ),
  )

const WireContentBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  tool_use_id: Schema.optional(Schema.String),
})
const decodeNamedTools = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String })),
)
const decodeMessagesWithBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(WireContentBlock) })),
)
const decodeMessagesWithText = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ content: Schema.String })),
)
const decodeSystemBlocks = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ text: Schema.String })),
)
const decodeToolChoice = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.String, name: Schema.String }),
)
const decodeOutputConfig = Schema.decodeUnknownSync(
  Schema.Struct({ effort: Schema.optional(Schema.String), other: Schema.optional(Schema.Finite) }),
)
const decodeThinking = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.optional(Schema.String), effort: Schema.optional(Schema.String) }),
)
const decodeContentBlocks = Schema.decodeUnknownSync(Schema.Array(WireContentBlock))

// ── transformPayload ──

describe("transformPayload", () => {
  // Tool names go on the wire as `mcp_<PascalCase>` — Anthropic's OAuth
  // billing validator rejects lowercase-after-prefix tool names when
  // multiple tools are present (matches Claude Code's PascalCase
  // convention; opencode-claude-auth issue notes).
  test("prefixes tool names in tools[] with PascalCase", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tools: [
        { type: "custom", name: "echo", input_schema: { type: "object" } },
        { type: "custom", name: "search", input_schema: { type: "object" } },
      ],
    }
    const result = transformPayload(payload)
    const tools = decodeNamedTools(result["tools"])
    expect(tools[0]!.name).toBe("mcp_Echo")
    expect(tools[1]!.name).toBe("mcp_Search")
  })

  test("prefixes tool_use names in historical messages with PascalCase", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "tc-1", name: "echo", input: { text: "hi" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tc-1", content: "echoed" }],
        },
      ],
    }
    const result = transformPayload(payload)
    const msgs = decodeMessagesWithBlocks(result["messages"])
    const toolUse = msgs[0]!.content[1]!
    expect(toolUse["name"]).toBe("mcp_Echo")
  })

  test("does not prefix non-tool_use blocks", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }
    const result = transformPayload(payload)
    const msgs = decodeMessagesWithBlocks(result["messages"])
    expect(msgs[0]!.content[0]!["type"]).toBe("text")
    expect(msgs[0]!.content[0]!["text"]).toBe("hello")
  })

  test("prefixes tool_choice name with PascalCase when type is tool", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tool_choice: { type: "tool", name: "echo" },
    }
    const result = transformPayload(payload)
    const tc = decodeToolChoice(result["tool_choice"])
    expect(tc.name).toBe("mcp_Echo")
  })

  test("does not modify tool_choice when type is auto", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tool_choice: { type: "auto" },
    }
    const result = transformPayload(payload)
    expect(result["tool_choice"]).toEqual({ type: "auto" })
  })

  test("unconditionally prefixes — mcp_foo becomes mcp_Mcp_foo", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
      tools: [{ type: "custom", name: "mcp_foo", input_schema: { type: "object" } }],
    }
    const result = transformPayload(payload)
    const tools = decodeNamedTools(result["tools"])
    expect(tools[0]!.name).toBe("mcp_Mcp_foo")
  })

  test("passes through payload without tools/messages", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [],
    }
    const result = transformPayload(payload)
    expect(result["model"]).toBe("claude-opus-4-6")
    expect(result["max_tokens"]).toBe(4096)
  })
})

// ── transformResponseContent ──

describe("transformResponseContent", () => {
  test("strips mcp_ prefix from tool_use blocks", () => {
    const content = [
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "tc-1", name: "mcp_echo", input: { text: "hi" } },
    ]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBeUndefined()
    expect(result[1]!["name"]).toBe("echo")
  })

  test("does not modify non-tool_use blocks", () => {
    const content = [{ type: "text", text: "hello" }]
    const result = transformResponseContent(content)
    expect(result[0]).toEqual({ type: "text", text: "hello" })
  })

  test("passes through tool_use without mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBe("echo")
  })

  test("strips exactly one mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "mcp_mcp_foo", input: {} }]
    const result = transformResponseContent(content)
    expect(result[0]!["name"]).toBe("mcp_foo")
  })
})

// ── transformStreamEvent ──

describe("transformStreamEvent", () => {
  test("strips mcp_ from content_block_start tool_use events", () => {
    const event = {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tc-1", name: "mcp_echo", input: {} },
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent(event)
    expect(result.type).toBe("content_block_start")
    if (result.type === "content_block_start" && result.content_block.type === "tool_use") {
      expect(result.content_block.name).toBe("echo")
    }
  })

  test("does not modify content_block_start text events", () => {
    const event = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent(event)
    expect(result.type).toBe("content_block_start")
    if (result.type === "content_block_start") expect(result.content_block.type).toBe("text")
  })

  test("passes through non-content_block_start events", () => {
    const event = {
      type: "message_stop",
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent(event)
    expect(result).toBe(event)
  })

  test("passes through content_block_delta events", () => {
    const event = {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"text":' },
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent(event)
    expect(result).toBe(event)
  })
})

// ── repairToolPairs (opencode parity B) ──

describe("repairToolPairs", () => {
  test("drops orphan tool_use blocks (no matching downstream tool_result)", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "trying" },
          { type: "tool_use", id: "tc-1", name: "echo", input: {} },
          { type: "tool_use", id: "tc-2", name: "echo", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "ok" }],
      },
    ]
    const repaired = repairToolPairs(messages)
    const assistantContent = decodeContentBlocks(repaired[0]?.["content"])
    // tool_use tc-2 is dropped; tc-1 + the text block survive.
    expect(assistantContent).toHaveLength(2)
    expect(assistantContent.find((b) => b["id"] === "tc-1")).toBeDefined()
    expect(assistantContent.find((b) => b["id"] === "tc-2")).toBeUndefined()
  })

  test("drops orphan tool_result blocks (no matching upstream tool_use)", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc-orphan", content: "stale" },
          { type: "text", text: "follow-up" },
        ],
      },
    ]
    const repaired = repairToolPairs(messages)
    const userContent = decodeContentBlocks(repaired[0]?.["content"])
    expect(userContent).toHaveLength(1)
    expect(userContent[0]!["type"]).toBe("text")
  })

  test("removes a message whose content fully empties out after filtering", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-only", name: "echo", input: {} }],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!["role"]).toBe("user")
  })

  test("returns input unchanged when every pair matches", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-1", content: "ok" }],
      },
    ]
    const repaired = repairToolPairs(messages)
    // Same reference — no defensive copy when nothing to repair.
    expect(repaired).toBe(messages)
  })

  test("ignores messages whose content is a string (no tool blocks possible)", () => {
    const messages = [
      { role: "user", content: "plain text" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
      },
    ]
    // No tool_result for tc-1, so the assistant's tool_use is orphaned
    // and gets dropped — but the string-content user message rides
    // through untouched.
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(1)
    expect(repaired[0]!["content"]).toBe("plain text")
  })
})

// ── system relocation (opencode parity A) ──

describe("transformPayload — system content relocation", () => {
  test("moves third-party system blocks into the first user message", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [
        { type: "text", text: "third-party system instructions" },
        { type: "text", text: "additional rules" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }
    const result = transformPayload(payload)
    const system = decodeSystemBlocks(result["system"])
    // After relocation, system[] holds only billing + identity entries.
    expect(system).toHaveLength(2)
    const systemTexts = system.map((b) => b.text ?? "")
    expect(systemTexts.some((t) => t.startsWith("x-anthropic-billing-header"))).toBe(true)
    expect(systemTexts.some((t) => t.startsWith(SYSTEM_IDENTITY_PREFIX))).toBe(true)
    // Relocated content is prepended to the first user message.
    const messages = decodeMessagesWithBlocks(result["messages"])
    const firstUserContent = messages[0]!.content
    expect(firstUserContent[0]!["type"]).toBe("text")
    expect(firstUserContent[0]!["text"]).toContain("third-party system instructions")
    expect(firstUserContent[0]!["text"]).toContain("additional rules")
    // Original user text survives at the tail.
    expect(firstUserContent[1]!["text"]).toBe("hello")
  })

  test("relocates into a string-content user message", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: "third-party prefix" }],
      messages: [{ role: "user", content: "hello" }],
    }
    const result = transformPayload(payload)
    const messages = decodeMessagesWithText(result["messages"])
    expect(messages[0]!.content).toContain("third-party prefix")
    expect(messages[0]!.content.endsWith("hello")).toBe(true)
  })

  test("leaves system unchanged when there are no third-party blocks", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }
    const result = transformPayload(payload)
    const system = decodeSystemBlocks(result["system"])
    // billing + identity only — no extras to move.
    expect(system).toHaveLength(2)
    const messages = decodeMessagesWithBlocks(result["messages"])
    expect(messages[0]!.content).toHaveLength(1)
  })

  test("splits IDENTITY+rest blocks so the rest gets relocated", () => {
    // OpenCode's system.transform hook produces a single block of
    // shape `IDENTITY + "\n\n<real instructions>"`. Pre-fix, the
    // partition treated the whole block as identity-only and silently
    // dropped <real instructions>. The remainder must survive into
    // the first user message via relocation.
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: `${SYSTEM_IDENTITY_PREFIX}\n\nDO-NOT-DROP these rules.` }],
      messages: [{ role: "user", content: "hello" }],
    }
    const result = transformPayload(payload)
    const system = decodeSystemBlocks(result["system"])
    // System still holds [billing, identity] — identity is the bare
    // prefix without the trailing rules.
    expect(system[1]!.text).toBe(SYSTEM_IDENTITY_PREFIX)
    // The rules survived: relocated into the first user message.
    const messages = decodeMessagesWithText(result["messages"])
    expect(messages[0]!.content).toContain("DO-NOT-DROP these rules.")
    expect(messages[0]!.content.endsWith("hello")).toBe(true)
  })

  test("billing hash matches the post-relocation first-user text", () => {
    // The prior order computed billing before relocation, so the hash
    // on the wire didn't match what the API actually saw. Compare
    // against a control payload with the same POST-relocation
    // first-user text but no system to relocate — the billing hash
    // header must be identical.
    const relocatedPayload = transformPayload({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: "third-party prefix" }],
      messages: [{ role: "user", content: "hello" }],
    })
    const controlPayload = transformPayload({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [],
      // The control directly carries what the relocator would produce.
      messages: [{ role: "user", content: "third-party prefix\n\nhello" }],
    })
    const relocatedBilling = decodeSystemBlocks(relocatedPayload["system"])[0]?.text
    const controlBilling = decodeSystemBlocks(controlPayload["system"])[0]?.text
    expect(relocatedBilling).toBe(controlBilling)
  })

  test("inserts relocated text after a leading tool_result run (preserves Anthropic ordering)", () => {
    // Anthropic requires tool_result blocks to be the FIRST blocks of
    // a user message that carries any. Counsel  follow-up: relocator
    // must splice the prefix in AFTER the leading tool_result run,
    // not at index 0, otherwise the API returns 400.
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: [{ type: "text", text: "third-party prefix" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tc-1", content: "ok" },
            { type: "tool_result", tool_use_id: "tc-2", content: "ok" },
            { type: "text", text: "follow-up" },
          ],
        },
      ],
      // Provide the matching upstream tool_use blocks so repairToolPairs
      // doesn't drop the tool_result entries.
      tools: [],
    }
    // Add an upstream assistant turn so the tool_result blocks survive
    // the orphan check.
    const payloadWithPair = {
      ...payload,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tc-1", name: "echo", input: {} },
            { type: "tool_use", id: "tc-2", name: "echo", input: {} },
          ],
        },
        ...payload.messages,
      ],
    }
    const result = transformPayload(payloadWithPair)
    const messages = decodeMessagesWithBlocks(result["messages"])
    const userMsg = Option.fromNullishOr(messages.find((message) => message.role === "user"))
    expect(Option.isSome(userMsg)).toBe(true)
    if (Option.isNone(userMsg)) return
    expect(userMsg.value.content[0]?.type).toBe("tool_result")
    expect(userMsg.value.content[1]?.type).toBe("tool_result")
    expect(userMsg.value.content[2]?.type).toBe("text")
    expect(userMsg.value.content[2]?.text).toBe("third-party prefix")
    expect(userMsg.value.content[3]?.type).toBe("text")
    expect(userMsg.value.content[3]?.text).toBe("follow-up")
  })
})

// ── haiku effort-strip (opencode parity C) ──

describe("transformPayload — haiku effort-strip", () => {
  test("strips output_config.effort when model starts with claude-haiku", () => {
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    }
    const result = transformPayload(payload)
    expect(result["output_config"]).toBeUndefined()
  })

  test("preserves other output_config keys when stripping effort", () => {
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high", other: 123 },
    }
    const result = transformPayload(payload)
    const oc = decodeOutputConfig(result["output_config"])
    expect(oc.effort).toBeUndefined()
    expect(oc.other).toBe(123)
  })

  test("leaves output_config.effort intact for non-haiku models", () => {
    const payload = {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "high" },
    }
    const result = transformPayload(payload)
    const oc = decodeOutputConfig(result["output_config"])
    expect(oc.effort).toBe("high")
  })

  test("strips thinking.effort for haiku models (defensive — opencode parity)", () => {
    // gent's anthropic/index.ts only emits output_config.effort today,
    // but the upstream Anthropic SDK may emit thinking.effort in
    // future shapes. Counsel  follow-up — match the opencode reference
    // and strip both, so the haiku 400 stays away regardless of which
    // shape carries the knob.
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", effort: "high" },
    }
    const result = transformPayload(payload)
    const thinking = decodeThinking(result["thinking"])
    expect(thinking.effort).toBeUndefined()
    expect(thinking.type).toBe("enabled")
  })

  test("removes thinking entirely when stripping leaves it empty", () => {
    const payload = {
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
      thinking: { effort: "high" },
    }
    const result = transformPayload(payload)
    expect(result["thinking"]).toBeUndefined()
  })
})

// ── anthropic/anthropic-keychain-transform.test ─────────────────────────────

/**
 * keychainTransformClient — auth-headers middleware (Commit 2a).
 *
 * Builds a fake `HttpClient` (via `HttpClient.make`) that captures
 * incoming requests and returns canned responses. The transform under
 * test wraps that fake client; tests assert that headers seen by the
 * fake match the expected OAuth shape.
 *
 * No global mutation. No `globalThis.fetch` swap. No Reference
 * memoization concerns. The fake is a real `HttpClient.HttpClient`
 * passed via Layer — the same composition production uses.
 */

const TEST_ENV: AnthropicKeychainEnv = {}
// ── Helpers ──
// Real Clock here (no TestClock), so expiresAt must be a real future
// Unix-millis timestamp. 10h from real now is comfortably outside the
// 60s freshness margin.
const makeCredsKeychain = (label: string): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt: 1_800_000_000_000,
})
interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}
// Sentinel object the responder can return to ask the fake client to
// emit `HttpClientError(TransportError)` instead of a successful
// response — exercises the wire-failure retry branch.
interface TransportFailure {
  readonly _tag: "TransportFailure"
  readonly message: string
}
const transportFailure = (message: string): TransportFailure => ({
  _tag: "TransportFailure",
  message,
})
const hasTransportFailureTag = Predicate.isTagged("TransportFailure")
const isTransportFailure = (v: Response | TransportFailure): v is TransportFailure =>
  hasTransportFailureTag(v)
interface FakeClientState {
  captured: Array<CapturedRequest>
  responder: (call: number) => Response | TransportFailure
}
const respondFirstWith =
  (first: Response | TransportFailure, later: Response | TransportFailure) =>
  (call: number): Response | TransportFailure => {
    if (call === 0) return first
    return later
  }
const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const headersObj: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (Schema.is(Schema.String)(value)) headersObj[key] = value
    }
    let bodyText = Option.getOrUndefined(Option.none<string>())
    if (request.body._tag === "Uint8Array") {
      bodyText = new TextDecoder().decode(request.body.body)
    } else if (request.body._tag === "Raw" && Schema.is(Schema.String)(request.body.body)) {
      bodyText = request.body.body
    }
    state.captured.push({
      url: request.url,
      method: request.method,
      headers: headersObj,
      body: bodyText,
    })
    const result = state.responder(state.captured.length - 1)
    if (isTransportFailure(result)) {
      return Effect.fail(
        new HttpClientError({
          reason: new TransportError({
            request,
            cause: result,
            description: result.message,
          }),
        }),
      )
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, result))
  })
// Capture the credential-service "instance" by running its layer once
// and grabbing the service from context. The transform takes this
// instance directly (closure-based, not yielded from R).
const buildCreds = (io: AnthropicCredentialIO): Promise<CredentialCache<ClaudeCredentials>> => {
  const host = testHostFacts().host
  const platformLayer = Layer.succeed(
    AnthropicPlatform,
    AnthropicPlatform.of({
      platform: host.osInfo.platform,
      home: host.homeDirectory,
      parentEnv: host.parentEnv,
      runProcess: host.runProcess,
      env: {},
    }),
  )
  const layer = AnthropicCredentialService.layerFromIO(io).pipe(
    Layer.provide(Layer.merge(BunServices.layer, platformLayer)),
  )
  return runEffectBoundary(
    Layer.build(layer).pipe(
      Effect.scoped,
      Effect.map((ctx) => {
        const creds = Context.get(ctx, AnthropicCredentialService)
        return {
          getFresh: creds.getFresh,
          invalidate: creds.invalidate,
        }
      }),
    ),
  )
}
// Same instance-extraction trick for AnthropicBetaCache. Each call
// returns a FRESH cache (the layer builds a new Ref) so tests are
// isolated.
const buildBetaCache = (): Promise<AnthropicBetaCacheApi> =>
  runEffectBoundary(
    Layer.build(AnthropicBetaCache.layer).pipe(
      Effect.scoped,
      Effect.map((ctx) => Context.get(ctx, AnthropicBetaCache)),
    ),
  )
const validCredsIO = (label: string): AnthropicCredentialIO => ({
  read: Effect.succeed(makeCredsKeychain(label)),
  refresh: Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})
// `HttpBody.jsonUnsafe` mirrors how the Anthropic SDK serializes
// outgoing JSON bodies (via `text` → Uint8Array). The transform reads
// the body via `requestBodyText` which decodes that Uint8Array back to
// a string, so this matches production representation.
const jsonBody = (payload: JsonRecord) => HttpBody.jsonUnsafe(payload)
// `Effect.orDie` collapses typed errors to defects so test bodies can
// assert success without `as Effect<unknown, never, never>` casts.
const runOk = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
  runEffectBoundary(Effect.scoped(eff.pipe(Effect.orDie)))
// Drives Schedule.exponential("1 second") in virtual time. Used by
// any test path that crosses a retry sleep — primarily 2b's transient
// retry but also 2d's parity-drift test for 429+long-context-body.
const runWithTestClockKeychain = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> => {
  const program = Effect.gen(function* () {
    const fiber = yield* Effect.scoped(eff).pipe(Effect.forkChild)
    // Walk past the exponential backoff window deterministically.
    // 1s + 2s = 3s covers 2 retries with `Schedule.exponential("1 second")`.
    yield* TestClock.adjust("3 seconds")
    return yield* Fiber.join(fiber)
  })
  return runEffectBoundary(Effect.scoped(program).pipe(Effect.provide(TestClock.layer())))
}
// ── Tests ──
describe("keychainTransformClient — auth headers (Commit 2a)", () => {
  it.live("injects Authorization Bearer from credential service", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.live("removes x-api-key (would otherwise conflict with OAuth Bearer)", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // Simulate the SDK's baseline by injecting x-api-key on the
      // outgoing request. The transform must strip it.
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            headers: { "x-api-key": "oauth-placeholder", "anthropic-version": "2023-06-01" },
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured[0]!.headers["x-api-key"]).toBeUndefined()
      // Preserves SDK baseline header
      expect(fakeState.captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
    }),
  )
  it.live("sets x-app, user-agent, anthropic-dangerous-direct-browser-access", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const headers = fakeState.captured[0]!.headers
      expect(headers["x-app"]).toBe("cli")
      expect(headers["user-agent"]).toMatch(/^claude-cli\/.+ \(external, cli\)$/)
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
    }),
  )
  it.live("merges anthropic-beta with model defaults", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // Body declares claude-opus-4-6, which has model-default betas
      // (base set + 1M-context + effort-2025-11-24 from the override).
      // Incoming "incoming-beta-1" must merge with those, not replace.
      yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            headers: { "anthropic-beta": "incoming-beta-1" },
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const beta = fakeState.captured[0]!.headers["anthropic-beta"]
      expect(beta).toBeDefined()
      const betas = beta!.split(",").map((s) => s.trim())
      // Incoming preserved
      expect(betas).toContain("incoming-beta-1")
      // Model default present (oauth-2025-04-20 is in MODEL_CONFIG.baseBetas)
      expect(betas).toContain("oauth-2025-04-20")
      // Per-model-override present (effort-2025-11-24 is added for "4-6")
      expect(betas).toContain("effort-2025-11-24")
    }),
  )
  it.live("credential-service failure surfaces as HttpClientError (transport)", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() =>
        buildCreds({
          read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
          refresh: Effect.fail(new ProviderAuthError({ message: "no refresh token either" })),
        }),
      )
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // The credential failure flows through the transient retry layer
      // (`Schedule.exponential("1 second")` + 2 retries = 3s real-clock).
      // Drive the schedule via TestClock so the test stays instant.
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.scoped(
            Effect.exit(
              wrapped.post("https://api.anthropic.com/v1/messages", {
                body: jsonBody({ model: "claude-opus-4-6" }),
              }),
            ),
          ).pipe(Effect.forkChild)
          yield* TestClock.adjust("3 seconds")
          return yield* Fiber.join(fiber)
        }),
      )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        .pipe(Effect.provide(TestClock.layer()))
      // The fake client never saw the request — the transform short-
      // circuited at the credential read.
      expect(fakeState.captured).toHaveLength(0)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
describe("keychainTransformClient — 429/529 retry (Commit 2b)", () => {
  it.live("429 once then 200 — retry succeeds, caller sees 200", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("rate limited", { status: 429 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
    }),
  )
  it.live("529 once then 200 — retry includes 529 (which retryTransient does not)", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("overloaded", { status: 529 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
    }),
  )
  it.live("3 consecutive 429 — budget exhausted, final 429 surfaces", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("rate limited", { status: 429 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      // 1 initial + 2 retries = 3 attempts
      expect(fakeState.captured).toHaveLength(3)
      expect(response.status).toBe(429)
    }),
  )
  it.live("transport failure (HttpClientError) once then 200 is retried", () =>
    Effect.gen(function* () {
      // Middleware retries both TransientResponseError (429/529) and
      // HttpClientError from the wire, preserving the resilience contract.
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          transportFailure("socket hang up"),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
    }),
  )
  it.live("3 consecutive transport failures — budget exhausted, error propagates", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => transportFailure("connection refused"),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.scoped(
              wrapped.post("https://api.anthropic.com/v1/messages", {
                body: jsonBody({ model: "claude-opus-4-6" }),
              }),
            ).pipe(Effect.forkChild)
            yield* TestClock.adjust("3 seconds")
            return yield* Fiber.join(fiber)
          }),
        )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(TestClock.layer())),
      )
      // 1 initial + 2 retries = 3 attempts
      expect(fakeState.captured).toHaveLength(3)
      expect(exit._tag).toBe("Failure")
    }),
  )
  it.live("non-transient 4xx (e.g. 400) does not trigger retry", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("bad request", { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(response.status).toBe(400)
    }),
  )
})
describe("keychainTransformClient — long-context beta retry (Commit 2d)", () => {
  // Long-context error markers Anthropic returns in the 400 body.
  // `keychain-transform` matches via `isLongContextError(body)`.
  const LONG_CONTEXT_BODY =
    '{"type":"error","error":{"message":"Extra usage is required for long context requests"}}'
  const NON_LONG_CONTEXT_400 = '{"type":"error","error":{"message":"some other 400"}}'
  it.live("400 long-context once → drops one beta → retry succeeds", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response(LONG_CONTEXT_BODY, { status: 400 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // The retry sent fewer betas than the initial request (one was
      // recorded as excluded after the 400). Compare beta cardinality.
      const initialBetas = fakeState.captured[0]!.headers["anthropic-beta"]!.split(",").length
      const retryBetas = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      expect(retryBetas).toBe(initialBetas - 1)
    }),
  )
  it.live("learning persists into the cache — next request starts pre-narrowed", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response(LONG_CONTEXT_BODY, { status: 400 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // First request: 400 → retry → 200. Two captures.
      yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      const learnedBetaCount = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      // Second request — the cache should already have the previously
      // rejected beta, so the FIRST attempt sends the narrower set.
      yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(3)
      const nextRequestBetas = fakeState.captured[2]!.headers["anthropic-beta"]!.split(",").length
      expect(nextRequestBetas).toBe(learnedBetaCount)
    }),
  )
  it.live("429 with long-context-shaped body still retries via outer transient layer", () =>
    Effect.gen(function* () {
      // Long-context layer is 400-only. A 429 — even if its body string
      // happens to match the long-context marker — flows through to the
      // outer transient layer untouched. Two-attempt sequence: 429-LC-body
      // → 200. Asserts the outer 429 retry kicked in (2 captures), NOT
      // the long-context retry (which would have rebuilt headers; on a
      // 429 there's nothing useful to narrow because the rate limit isn't
      // beta-related).
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response(LONG_CONTEXT_BODY, { status: 429 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runWithTestClockKeychain(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // Crucial: header beta count unchanged between the two attempts —
      // long-context layer did NOT narrow the set on the 429.
      const initialBetas = fakeState.captured[0]!.headers["anthropic-beta"]!.split(",").length
      const retryBetas = fakeState.captured[1]!.headers["anthropic-beta"]!.split(",").length
      expect(retryBetas).toBe(initialBetas)
    }),
  )
  it.live("non-long-context 400 passes through without retry", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response(NON_LONG_CONTEXT_400, { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(response.status).toBe(400)
    }),
  )
  it.live("exhausted candidates surface terminal 400 (every long-context beta tried)", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(validCredsIO("k1")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        // Always return long-context 400 — middleware should give up
        // after exhausting candidates and hand back the 400.
        responder: () => new Response(LONG_CONTEXT_BODY, { status: 400 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped
            .post("https://api.anthropic.com/v1/messages", {
              body: jsonBody({ model: "claude-opus-4-6" }),
            })
            .pipe(Effect.orDie),
        ),
      )
      // claude-opus-4-6 emits 2 long-context betas
      // (context-1m-2025-08-07 + interleaved-thinking-2025-05-14).
      // Initial attempt + 2 narrowing attempts = 3 captures.
      expect(fakeState.captured).toHaveLength(3)
      expect(response.status).toBe(400)
    }),
  )
})
describe("keychainTransformClient — 401 recovery (Commit 2e)", () => {
  // IO that flips its `read` result on each call — simulates the
  // production sequence: stale cached token sent on attempt 1, 401 fires
  // creds.invalidate, attempt 2's mapRequestEffect re-reads keychain and
  // gets the fresh token. No global mutation; the toggle lives in a
  // closure over `attempt`.
  const togglingCredsIO = (staleLabel: string, freshLabel: string): AnthropicCredentialIO => {
    let attempt = 0
    return {
      read: Effect.suspend(() => {
        if (attempt === 0) {
          attempt++
          return Effect.succeed(makeCredsKeychain(staleLabel))
        }
        attempt++
        return Effect.succeed(makeCredsKeychain(freshLabel))
      }),
      refresh: Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
  }
  it.live("401 once → invalidate creds → retry succeeds with fresh token", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("stale", "fresh")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("auth", { status: 401 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // Crucial: token differs across attempts — invalidate forced the
      // mapRequestEffect to re-read creds, getting the fresh token.
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer fresh-access")
    }),
  )
  it.live("two consecutive 401s — second surfaces (real auth failure, no infinite loop)", () =>
    Effect.gen(function* () {
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("stale", "still-bad")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        // Both attempts get 401 — the second 401 is a real auth failure
        // (revoked session, missing scope) and must reach the caller.
        responder: () => new Response("auth", { status: 401 }),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      // 1 initial + 1 retry = 2 attempts (no third)
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(401)
    }),
  )
  it.live("non-401 failure does not invalidate creds", () =>
    Effect.gen(function* () {
      // Fire TWO sequential requests (500 then 200) on the same creds
      // service. If a non-401 mistakenly invalidated the cache, request
      // #2 would re-read and pick up the second token. Asserting both
      // requests use the first token proves the cache survived the 500.
      const creds = yield* Effect.promise(() => buildCreds(togglingCredsIO("first", "second")))
      const cache = yield* Effect.promise(() => buildBetaCache())
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("server error", { status: 500 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, cache, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const r1 = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      const r2 = yield* Effect.promise(() =>
        runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(r1.status).toBe(500)
      expect(r2.status).toBe(200)
      // Both requests used the cached "first" token. If the 500 had
      // wrongly invalidated, request #2 would carry "second-access".
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer first-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer first-access")
    }),
  )
})
// Suppress unused-warning for Layer/Ref imports kept for symmetry with
// other test files in this directory.
void Layer
void Ref

// ── anthropic/anthropic-credential-service.test ─────────────────────────────

/**
 * AnthropicCredentialService — Effect-native credential cache.
 *
 * The service caches credentials in a `Ref` with TTL 30s + a 60s
 * freshness margin (refresh before the wire-side auth gate rejects).
 * This test drives the IO seam (`AnthropicCredentialIO`) deterministically
 * via `TestClock` so we can assert cache semantics without spawning
 * `security` or hitting the keychain.
 */
const testPlatformLayerCredentialService = (): Layer.Layer<AnthropicPlatform> => {
  const host = testHostFacts().host
  return Layer.succeed(
    AnthropicPlatform,
    AnthropicPlatform.of({
      platform: host.osInfo.platform,
      home: host.homeDirectory,
      parentEnv: host.parentEnv,
      runProcess: host.runProcess,
      env: {},
    }),
  )
}
const credLayer = (...args: Parameters<typeof AnthropicCredentialService.layerFromIO>) =>
  AnthropicCredentialService.layerFromIO(...args).pipe(
    Layer.provide(Layer.merge(BunServices.layer, testPlatformLayerCredentialService())),
  )
// ── Helpers ──
const makeCreds = (label: string, expiresAt: number): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt,
})
interface IOState {
  readResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
  refreshResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
}
const makeIO = (state: IOState): AnthropicCredentialIO => ({
  read: Effect.suspend(() => state.readResult()),
  refresh: Effect.suspend(() => state.refreshResult()),
})
interface PersistState {
  lastWritten: Option.Option<{
    access: string
    refresh: string
    expires: number
  }>
  failNext: boolean
}
const makeAuthInfo = (state: PersistState): ProviderAuthInfo => ({
  type: "oauth",
  persist: (updated) =>
    Effect.suspend(() => {
      if (state.failNext) {
        state.failNext = false
        return Effect.die(new Error("simulated persist failure"))
      }
      state.lastWritten = Option.some(updated)
      return Effect.void
    }),
})
// TestClock starts at time 0, so all expiresAt values are absolute offsets.
const FAR_FUTURE = 10 * 60 * 1000 // expiresAt = 10 minutes from t=0
const COMPLETE = Option.getOrUndefined(Option.none<void>())
// `TestClock.adjust` requires a `Scope` (it manages internal sleeper
// fibers). Wrap with `Effect.scoped` so tests don't have to thread
// scope manually.
const runWithTestClock = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.scoped(eff).pipe(Effect.provide(TestClock.layer()))
// ── Tests ──
describe("AnthropicCredentialService — cache hit/miss", () => {
  it.live("returns cached creds within TTL even when source changes", () =>
    Effect.gen(function* () {
      // Outcome assertion: if the source switches underneath, a cached
      // call must STILL return the original creds — that proves the
      // cache was consulted, no internal call counter needed.
      const creds1 = makeCreds("k1", FAR_FUTURE)
      const creds2 = makeCreds("k2", FAR_FUTURE)
      const callsRef = { current: creds1 }
      const state: IOState = {
        readResult: () => Effect.succeed(callsRef.current),
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const layer = credLayer(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const first = yield* svc.getFresh
          callsRef.current = creds2 // source switches; cache should ignore
          const second = yield* svc.getFresh
          expect(first.accessToken).toBe("k1-access")
          expect(second.accessToken).toBe("k1-access")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("re-reads source after TTL expires", () =>
    Effect.gen(function* () {
      const creds1 = makeCreds("k1", FAR_FUTURE)
      const creds2 = makeCreds("k2", FAR_FUTURE)
      const callsRef = { current: creds1 }
      const state: IOState = {
        readResult: () => Effect.succeed(callsRef.current),
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const layer = credLayer(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const first = yield* svc.getFresh
          callsRef.current = creds2
          yield* TestClock.adjust("31 seconds")
          const second = yield* svc.getFresh
          expect(first.accessToken).toBe("k1-access")
          expect(second.accessToken).toBe("k2-access")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
describe("AnthropicCredentialService — refresh on stale", () => {
  it.live("concurrent stale calls share one refresh", () =>
    Effect.gen(function* () {
      const stale = makeCreds("stale", 30000)
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const refreshStarted = yield* Deferred.make<void>()
      const releaseRefresh = yield* Deferred.make<void>()
      let refreshCount = 0
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () =>
          Effect.gen(function* () {
            refreshCount += 1
            yield* Deferred.succeed(refreshStarted, COMPLETE)
            yield* Deferred.await(releaseRefresh)
            return fresh
          }),
      }
      const persistState: PersistState = { lastWritten: Option.none(), failNext: false }
      const layer = credLayer(makeIO(state), makeAuthInfo(persistState))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const fiber = yield* Effect.all([svc.getFresh, svc.getFresh], {
            concurrency: 2,
          }).pipe(Effect.forkChild)
          yield* Deferred.await(refreshStarted)
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          expect(refreshCount).toBe(1)
          yield* Deferred.succeed(releaseRefresh, COMPLETE)
          const results = yield* Fiber.join(fiber)
          expect(results[0].accessToken).toBe("fresh-access")
          expect(results[1].accessToken).toBe("fresh-access")
          expect(refreshCount).toBe(1)
          expect(Option.map(persistState.lastWritten, (value) => value.access)).toEqual(
            Option.some("fresh-access"),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("expiring-soon creds trigger refresh; refreshed creds returned + persisted", () =>
    Effect.gen(function* () {
      // Outcome assertions: returned creds are the refreshed ones (not
      // the stale ones), and persist saw the new credential. Both are
      // observable via the public surface (return value + persist
      // recording its argument) — no internal call counter needed.
      const stale = makeCreds("stale", 30000) // 30s — inside the 60s freshness margin
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () => Effect.succeed(fresh),
      }
      const persistState: PersistState = { lastWritten: Option.none(), failNext: false }
      const layer = credLayer(makeIO(state), makeAuthInfo(persistState))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const result = yield* svc.getFresh
          expect(result.accessToken).toBe("fresh-access")
          expect(Option.map(persistState.lastWritten, (value) => value.access)).toEqual(
            Option.some("fresh-access"),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("refresh failure surfaces ProviderAuthError to caller", () =>
    Effect.gen(function* () {
      const stale = makeCreds("stale", 30000)
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "OAuth 401 from refresh" })),
      }
      const layer = credLayer(makeIO(state))
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          return yield* Effect.exit(svc.getFresh)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.message).toContain("unavailable or expired")
        }
      }
    }),
  )
})
describe("AnthropicCredentialService — invalidate", () => {
  it.live("invalidate forces next getFresh to re-read", () =>
    Effect.gen(function* () {
      const creds1 = makeCreds("k1", FAR_FUTURE)
      const creds2 = makeCreds("k2", FAR_FUTURE)
      const callsRef = { current: creds1 }
      const state: IOState = {
        readResult: () => Effect.succeed(callsRef.current),
        refreshResult: () =>
          Effect.fail(new ProviderAuthError({ message: "should not be called" })),
      }
      const layer = credLayer(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const before = yield* svc.getFresh
          callsRef.current = creds2
          yield* svc.invalidate
          const after = yield* svc.getFresh
          expect(before.accessToken).toBe("k1-access")
          expect(after.accessToken).toBe("k2-access")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
describe("AnthropicCredentialService — durable persist failure", () => {
  it.live("write-back failure surfaces ProviderAuthError", () =>
    Effect.gen(function* () {
      const stale = makeCreds("stale", 30000)
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () => Effect.succeed(fresh),
      }
      const persistState: PersistState = { lastWritten: Option.none(), failNext: true }
      const layer = credLayer(makeIO(state), makeAuthInfo(persistState))
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          return yield* Effect.exit(svc.getFresh)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.message).toContain(
            "Failed to persist refreshed Anthropic credentials",
          )
        }
      }
      expect(Option.isNone(persistState.lastWritten)).toBe(true)
    }),
  )
  it.live("failed write-back is retried on the next getFresh without a second refresh", () =>
    Effect.gen(function* () {
      const stale = makeCreds("stale", 30000)
      const fresh = makeCreds("fresh", FAR_FUTURE)
      let refreshCount = 0
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () => {
          refreshCount += 1
          return Effect.succeed(fresh)
        },
      }
      const persistState: PersistState = { lastWritten: Option.none(), failNext: true }
      const layer = credLayer(makeIO(state), makeAuthInfo(persistState))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const failure = yield* Effect.exit(svc.getFresh)
          expect(failure._tag).toBe("Failure")
          const retry = yield* svc.getFresh
          expect(retry.accessToken).toBe("fresh-access")
          expect(refreshCount).toBe(1)
          expect(Option.map(persistState.lastWritten, (value) => value.access)).toEqual(
            Option.some("fresh-access"),
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
describe("AnthropicCredentialService — keychain miss falls through to refresh", () => {
  it.live("read fails → refresh succeeds → returns refreshed creds", () =>
    Effect.gen(function* () {
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        readResult: () => Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
        refreshResult: () => Effect.succeed(fresh),
      }
      const layer = credLayer(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* AnthropicCredentialService
          const result = yield* svc.getFresh
          // Outcome: when read fails, the refresh path's creds reach the
          // caller. No internal call counters needed.
          expect(result.accessToken).toBe("fresh-access")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
// Suppress unused-warning for Layer/Ref imports (intentional helper imports)
void Layer
void Ref

// ── anthropic/anthropic-oauth-refresh.test ──────────────────────────────────

/**
 * Tests for the pure helpers backing Claude Code OAuth refresh +
 * keychain write-back. The HTTP path itself is exercised through the
 * Live integration (and gated by a real keychain entry); these tests
 * cover the deterministic transformations that decide whether a
 * refresh succeeds and what the keychain blob ends up containing.
 *
 * Counsel keychain alignment K1 + K2 — pulled in from
 * `griffinmartin/opencode-claude-auth`'s reference implementation.
 */

const WrappedCredentialBlob = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Finite,
    subscriptionType: Schema.String,
  }),
  mcpOAuth: Schema.Struct({ something: Schema.String }),
})
const FlatCredentialBlob = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
})
const decodeWrappedCredentialBlob = Schema.decodeUnknownSync(
  Schema.fromJsonString(WrappedCredentialBlob),
)
const decodeFlatCredentialBlob = Schema.decodeUnknownSync(Schema.fromJsonString(FlatCredentialBlob))

describe("parseOAuthResponse", () => {
  test("parses a well-formed Anthropic refresh response", () => {
    const raw = encodeExternalJson({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    })
    const now = 1_700_000_000_000
    const creds = parseOAuthResponse(raw, "old-refresh", now)
    expect(Option.isSome(creds)).toBe(true)
    if (Option.isSome(creds)) {
      expect(creds.value.accessToken).toBe("new-access")
      expect(creds.value.refreshToken).toBe("new-refresh")
      expect(creds.value.expiresAt).toBe(now + 3600 * 1000)
    }
  })

  test("falls back to the caller's refresh token when the response omits one", () => {
    const raw = encodeExternalJson({ access_token: "new-access", expires_in: 3600 })
    const creds = parseOAuthResponse(raw, "old-refresh", 0)
    expect(Option.isSome(creds)).toBe(true)
    if (Option.isSome(creds)) expect(creds.value.refreshToken).toBe("old-refresh")
  })

  test("defaults expires_in to 36 000s (10h) when missing", () => {
    const raw = encodeExternalJson({ access_token: "new-access" })
    const now = 1_700_000_000_000
    const creds = parseOAuthResponse(raw, "old-refresh", now)
    expect(Option.isSome(creds)).toBe(true)
    if (Option.isSome(creds)) expect(creds.value.expiresAt).toBe(now + 36_000 * 1000)
  })

  test("returns None for non-JSON input", () => {
    expect(Option.isNone(parseOAuthResponse("not json", "x", 0))).toBe(true)
  })

  test("returns None when access_token is missing", () => {
    const raw = encodeExternalJson({ refresh_token: "x", expires_in: 3600 })
    expect(Option.isNone(parseOAuthResponse(raw, "old-refresh", 0))).toBe(true)
  })

  test("returns None when the body is not an object", () => {
    expect(Option.isNone(parseOAuthResponse(encodeExternalJson("oops"), "x", 0))).toBe(true)
    expect(Option.isNone(parseOAuthResponse(encodeExternalJson(externalWireNull), "x", 0))).toBe(
      true,
    )
  })
})

describe("updateCredentialBlob", () => {
  test("rewrites the wrapped `claudeAiOauth` payload preserving sibling fields", () => {
    const existing = encodeExternalJson({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 0,
        subscriptionType: "max",
      },
      mcpOAuth: { something: "preserve-me" },
    })
    const next = updateCredentialBlob(existing, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 9_999,
    })
    expect(Option.isSome(next)).toBe(true)
    if (Option.isSome(next)) {
      const parsed = decodeWrappedCredentialBlob(next.value)
      expect(parsed.claudeAiOauth.accessToken).toBe("new-access")
      expect(parsed.claudeAiOauth.refreshToken).toBe("new-refresh")
      expect(parsed.claudeAiOauth.expiresAt).toBe(9_999)
      expect(parsed.claudeAiOauth.subscriptionType).toBe("max")
      expect(parsed.mcpOAuth.something).toBe("preserve-me")
    }
  })

  test("rewrites a flat payload (no `claudeAiOauth` wrapper)", () => {
    const existing = encodeExternalJson({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
    })
    const next = updateCredentialBlob(existing, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 1_234,
    })
    expect(Option.isSome(next)).toBe(true)
    if (Option.isSome(next)) {
      const parsed = decodeFlatCredentialBlob(next.value)
      expect(parsed.accessToken).toBe("new-access")
      expect(parsed.refreshToken).toBe("new-refresh")
      expect(parsed.expiresAt).toBe(1_234)
    }
  })

  test("returns None for non-JSON input", () => {
    const next = updateCredentialBlob("not json", {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: 0,
    })
    expect(Option.isNone(next)).toBe(true)
  })
})

describe("PRIMARY_CLAUDE_SERVICE", () => {
  // Counsel K2 — the primary service name was hard-coded inside the
  // module. Exposing it as a named export forces every caller that
  // assumes "the default account" to spell it out, so a future
  // multi-account picker UI can audit-grep all the places that need
  // updating.
  test("is the canonical Claude Code keychain service name", () => {
    expect(PRIMARY_CLAUDE_SERVICE).toBe("Claude Code-credentials")
  })
})

describe("source-policy gates", () => {
  // Two real defects this guards: a non-primary keychain miss silently
  // falling through to the on-disk file (which holds only the primary
  // credential), and the CLI refresh fallback running for any source
  // (the CLI persists to whichever account is active, not the
  // requested one). Both policies extracted into pure helpers so the
  // gate is unit-testable without spawning `security` or `claude`.
  describe("shouldFallBackToCredentialsFile", () => {
    test("returns true on non-darwin (no keychain at all)", () => {
      expect(shouldFallBackToCredentialsFile("linux", PRIMARY_CLAUDE_SERVICE)).toBe(true)
      expect(shouldFallBackToCredentialsFile("linux", "Claude Code-credentials-abc123")).toBe(true)
    })

    test("returns true for the primary source on darwin", () => {
      expect(shouldFallBackToCredentialsFile("darwin", PRIMARY_CLAUDE_SERVICE)).toBe(true)
    })

    test("returns false for non-primary sources on darwin", () => {
      expect(shouldFallBackToCredentialsFile("darwin", "Claude Code-credentials-abc123")).toBe(
        false,
      )
    })
  })

  describe("shouldFallBackToCli", () => {
    test("returns true for the primary source", () => {
      expect(shouldFallBackToCli(PRIMARY_CLAUDE_SERVICE)).toBe(true)
    })

    test("returns false for non-primary sources", () => {
      expect(shouldFallBackToCli("Claude Code-credentials-abc123")).toBe(false)
    })
  })
})

describe("freshEnoughForUse", () => {
  // The gate that decides "use these creds vs. refresh first" must
  // allow at least a 60s safety margin so a token that's about to
  // expire isn't sent on the wire mid-refresh. Note: this only tests
  // the *threshold*, not the integration. The full
  // regression ("refresh returns fresh creds → caller uses them in
  // memory even when write-back failed") is verified at the call
  // sites (credential-service, acp-agents/index, anthropic/index)
  // through code review — none of them re-read keychain after
  // refresh anymore.
  const now = 1_700_000_000_000

  test("returns true when expiry is more than 60s away", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now + 61_000 }, now),
    ).toBe(true)
  })

  test("returns false at exactly the 60s threshold (strict >)", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now + 60_000 }, now),
    ).toBe(false)
  })

  test("returns false when expiry is in the past", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 }, now),
    ).toBe(false)
  })
})

// ── anthropic/anthropic-signing.test ────────────────────────────────────────

/**
 * Tests for the Claude Code billing-header signing helpers — the
 * algorithm Anthropic's OAuth-billing validator checks against. The
 * placeholder `cch=c5e82` we shipped before this surface tripped the
 * validator on every request, surfacing as `InvalidKey` from the SDK.
 */

// `BunGentPlatformLive` is `Layer.succeed` — the real SHA256 hash is
// computed synchronously, so each helper can run via `Effect.runSync`.
const runSync = <A>(effect: Effect.Effect<A, never, never>): A => Effect.runSync(effect)

const computeCch = (text: string): string =>
  runSync(computeCchEffect(text).pipe(Effect.provide(BunGentPlatformLive)))
const computeVersionSuffix = (text: string, version: string): string =>
  runSync(computeVersionSuffixEffect(text, version).pipe(Effect.provide(BunGentPlatformLive)))
const buildBillingHeaderValue = (
  messages: Parameters<typeof buildBillingHeaderValueEffect>[0],
  version: string,
  entrypoint: string,
): string =>
  runSync(
    buildBillingHeaderValueEffect(messages, version, entrypoint).pipe(
      Effect.provide(BunGentPlatformLive),
    ),
  )

describe("extractFirstUserMessageText", () => {
  test("returns the empty string when no messages", () => {
    expect(extractFirstUserMessageText([])).toBe("")
  })

  test("returns the empty string when no user message", () => {
    expect(extractFirstUserMessageText([{ role: "assistant", content: "hi" }])).toBe("")
  })

  test("reads a string-content user message verbatim", () => {
    expect(extractFirstUserMessageText([{ role: "user", content: "hello" }])).toBe("hello")
  })

  test("reads the first text block of an array-content user message", () => {
    expect(
      extractFirstUserMessageText([
        {
          role: "user",
          content: [
            { type: "image" },
            { type: "text", text: "hello" },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toBe("hello")
  })

  test("returns the FIRST user message even when later ones exist", () => {
    expect(
      extractFirstUserMessageText([
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ]),
    ).toBe("first")
  })
})

describe("computeCch", () => {
  test("returns the first 5 hex chars of sha256(text)", () => {
    const text = "hello"
    const expected = createHash("sha256").update(text).digest("hex").slice(0, 5)
    expect(computeCch(text)).toBe(expected)
  })

  test("is stable across calls — same text → same hash", () => {
    expect(computeCch("hi")).toBe(computeCch("hi"))
  })

  test("differs for different text — single-char change flips the hash", () => {
    expect(computeCch("hi")).not.toBe(computeCch("hj"))
  })
})

describe("computeVersionSuffix", () => {
  test("samples chars 4, 7, 20 (zero-padded when shorter) and hashes with the salt + version", () => {
    // Short message: every sample falls back to "0".
    const suffix = computeVersionSuffix("hi", "2.1.80")
    expect(suffix).toMatch(/^[0-9a-f]{3}$/)
  })

  test("differs when the version string changes", () => {
    expect(computeVersionSuffix("hello", "2.1.80")).not.toBe(
      computeVersionSuffix("hello", "2.1.81"),
    )
  })

  test("is stable for the same (text, version) pair", () => {
    expect(computeVersionSuffix("hello world here is more", "2.1.80")).toBe(
      computeVersionSuffix("hello world here is more", "2.1.80"),
    )
  })
})

describe("buildBillingHeaderValue", () => {
  test("formats `x-anthropic-billing-header: cc_version=V.S; cc_entrypoint=E; cch=H;`", () => {
    const messages = [{ role: "user", content: "hi" }]
    const value = buildBillingHeaderValue(messages, "2.1.80", "cli")
    expect(value).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.80\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
    )
  })

  test("computes cch from the first user message text", () => {
    const value = buildBillingHeaderValue(
      [
        { role: "assistant", content: "preamble" },
        { role: "user", content: "the prompt" },
      ],
      "2.1.80",
      "cli",
    )
    const expectedCch = computeCch("the prompt")
    expect(value).toContain(`cch=${expectedCch};`)
  })

  test("uses the entrypoint verbatim", () => {
    const value = buildBillingHeaderValue([{ role: "user", content: "hi" }], "2.1.80", "test-entry")
    expect(value).toContain("cc_entrypoint=test-entry;")
  })
})

// ── anthropic/anthropic-beta-cache.test ─────────────────────────────────────

/**
 * AnthropicBetaCache — cross-request beta-rejection learning.
 *
 * Outcome-based tests: assert what the next `getExcluded` returns
 * after a sequence of records / env changes / model switches. No
 * internal call counters. The cache is pure logic over `Ref<CacheCell>`
 * so a real Effect runtime + the service's own layer is the simplest
 * harness.
 */
const run = <A, E>(eff: Effect.Effect<A, E, AnthropicBetaCache>) =>
  Effect.scoped(eff.pipe(Effect.provide(AnthropicBetaCache.layer)))
describe("AnthropicBetaCache — basic record / get", () => {
  it.live("get on empty cache returns empty set", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        const excluded = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(excluded.size).toBe(0)
      }),
    ),
  )
  it.live("recorded beta appears in next getExcluded for same model", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        yield* cache.recordExcluded(
          "claude-opus-4-6",
          "context-1m-2025-08-07",
          Option.some("flag-a"),
        )
        const excluded = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(excluded.has("context-1m-2025-08-07")).toBe(true)
        expect(excluded.size).toBe(1)
      }),
    ),
  )
  it.live("multiple records accumulate in the same model's set", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.some("flag-a"))
        yield* cache.recordExcluded("claude-opus-4-6", "beta-y", Option.some("flag-a"))
        const excluded = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(excluded.has("beta-x")).toBe(true)
        expect(excluded.has("beta-y")).toBe(true)
        expect(excluded.size).toBe(2)
      }),
    ),
  )
  it.live("recordExcluded is standalone-safe — no prior getExcluded required", () =>
    // Counsel-driven contract: recordExcluded carries currentBetaFlags
    // and applies the same env/model-change clear/seed as getExcluded.
    // Calling record before any get must NOT lose data on the next read.
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.some("flag-a"))
        const excluded = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(excluded.has("beta-x")).toBe(true)
        expect(excluded.size).toBe(1)
      }),
    ),
  )
})
describe("AnthropicBetaCache — clear-on-env-change", () => {
  it.live("changing betaFlags env clears all learned exclusions", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.some("flag-a"))
        // Env changes: prior learning should be discarded.
        const after = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-b"))
        expect(after.size).toBe(0)
        // And subsequent same-env requests start fresh.
        const stillEmpty = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-b"))
        expect(stillEmpty.size).toBe(0)
      }),
    ),
  )
  it.live("env change from undefined → defined also clears", () =>
    // Learn under env=undefined, then switch to env="flag-a" — prior
    // learning must be discarded.
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.none())
        const after = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(after.size).toBe(0)
      }),
    ),
  )
})
describe("AnthropicBetaCache — clear-on-model-change", () => {
  it.live("switching model clears prior model's learning", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.some("flag-a"))
        // Different model under same env → cache cleared.
        const haiku = yield* cache.getExcluded("claude-haiku-4-5", Option.some("flag-a"))
        expect(haiku.size).toBe(0)
        // Switching back doesn't restore the prior learning either.
        const opus = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
        expect(opus.size).toBe(0)
      }),
    ),
  )
})
describe("AnthropicBetaCache — same-model same-env stability", () => {
  it.live("repeated getExcluded with unchanged inputs is stable across many calls", () =>
    run(
      Effect.gen(function* () {
        const cache = yield* AnthropicBetaCache
        yield* cache.recordExcluded("claude-opus-4-6", "beta-x", Option.some("flag-a"))
        for (let i = 0; i < 5; i++) {
          const excluded = yield* cache.getExcluded("claude-opus-4-6", Option.some("flag-a"))
          expect(excluded.has("beta-x")).toBe(true)
        }
      }),
    ),
  )
})

// ── anthropic/anthropic-model-config.test ───────────────────────────────────

/**
 * Per-model Anthropic configuration — beta lists + ccVersion + override
 * table. Counsel  — locks the port of
 * `griffinmartin/opencode-claude-auth/src/model-config.ts` so future
 * version bumps + override edits stay aligned with Claude Code's wire
 * shape.
 */

describe("MODEL_CONFIG", () => {
  test("ccVersion is the currently-advertised Claude Code CLI version", () => {
    // Reference: opencode-claude-auth/src/model-config.ts:15
    expect(MODEL_CONFIG.ccVersion).toBe("2.1.90")
    expect(getCcVersion()).toBe(MODEL_CONFIG.ccVersion)
  })

  test("baseBetas carry the five flags Claude Code currently sends", () => {
    // Lock the exact set so a missed reference-impl update fails
    // loudly in CI rather than silently drifting from the wire shape.
    expect([...MODEL_CONFIG.baseBetas]).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "prompt-caching-scope-2026-01-05",
      "context-management-2025-06-27",
    ])
  })

  test("longContextBetas include the 1M-context flag first", () => {
    expect(MODEL_CONFIG.longContextBetas[0]).toBe("context-1m-2025-08-07")
  })
})

describe("getModelOverride", () => {
  test("haiku family disables effort and excludes interleaved-thinking", () => {
    const override = getModelOverride("claude-haiku-4-5")
    expect(Option.isSome(override)).toBe(true)
    if (Option.isSome(override)) {
      expect(override.value.disableEffort).toBe(true)
      expect(override.value.exclude).toContain("interleaved-thinking-2025-05-14")
    }
  })

  test("4-6 models add the effort beta", () => {
    const override = getModelOverride("claude-sonnet-4-6")
    expect(Option.isSome(override)).toBe(true)
    if (Option.isSome(override)) expect(override.value.add).toContain("effort-2025-11-24")
  })

  test("4-7 models add the effort beta", () => {
    const override = getModelOverride("claude-opus-4-7")
    expect(Option.isSome(override)).toBe(true)
    if (Option.isSome(override)) expect(override.value.add).toContain("effort-2025-11-24")
  })

  test("returns None for models matching no override pattern", () => {
    expect(Option.isNone(getModelOverride("claude-sonnet-3-5"))).toBe(true)
  })

  test("matches case-insensitively", () => {
    const override = getModelOverride("CLAUDE-HAIKU-4-5")
    expect(Option.isSome(override)).toBe(true)
    if (Option.isSome(override)) expect(override.value.disableEffort).toBe(true)
  })
})

describe("supports1mContext", () => {
  test("opus 4.6+ supports 1m", () => {
    expect(supports1mContext("claude-opus-4-6")).toBe(true)
    expect(supports1mContext("claude-opus-4-7")).toBe(true)
    expect(supports1mContext("claude-opus-5-0")).toBe(true)
  })

  test("sonnet 4.6+ supports 1m", () => {
    expect(supports1mContext("claude-sonnet-4-6")).toBe(true)
    expect(supports1mContext("claude-sonnet-5-0")).toBe(true)
  })

  test("opus/sonnet below 4.6 does not", () => {
    expect(supports1mContext("claude-opus-4-5")).toBe(false)
    expect(supports1mContext("claude-sonnet-3-5")).toBe(false)
  })

  test("haiku is not eligible regardless of version", () => {
    expect(supports1mContext("claude-haiku-4-7")).toBe(false)
  })

  test("date-suffix model ids are treated as x.0 (not x.<N>)", () => {
    // Counsel  — date suffix like 20250514 reads minor>99 → effective 0,
    // so opus-4-20250514 is treated as 4.0 (not 1m-eligible).
    expect(supports1mContext("claude-opus-4-20250514")).toBe(false)
  })
})

describe("getModelBetas", () => {
  test("includes every base beta for a generic sonnet model", () => {
    const betas = getModelBetas("claude-sonnet-4-5", Option.none())
    for (const beta of MODEL_CONFIG.baseBetas) {
      expect(betas).toContain(beta)
    }
  })

  test("opus 4.6+ also gets the long-context beta", () => {
    const betas = getModelBetas("claude-opus-4-6", Option.none())
    expect(betas).toContain("context-1m-2025-08-07")
    // Plus the 4-6 override adds the effort beta.
    expect(betas).toContain("effort-2025-11-24")
  })

  test("haiku omits interleaved-thinking (excluded by override)", () => {
    const betas = getModelBetas("claude-haiku-4-5", Option.none())
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    // baseBetas minus the excluded one.
    expect(betas).toContain("claude-code-20250219")
    expect(betas).toContain("oauth-2025-04-20")
  })

  test("env override replaces the base list comma-split", () => {
    const betas = getModelBetas("claude-sonnet-4-5", Option.some("alpha,beta,gamma"))
    expect(betas).toEqual(["alpha", "beta", "gamma"])
  })

  test("excluded set drops the listed betas (long-context backoff path)", () => {
    const betas = getModelBetas(
      "claude-opus-4-6",
      Option.none(),
      Option.some(new Set(["context-1m-2025-08-07"])),
    )
    expect(betas).not.toContain("context-1m-2025-08-07")
    // Other betas survive.
    expect(betas).toContain("oauth-2025-04-20")
  })

  test("does not duplicate add-overrides already present in the base list", () => {
    // Simulate an env that already includes the override-added beta.
    const betas = getModelBetas(
      "claude-sonnet-4-6",
      Option.some("claude-code-20250219,effort-2025-11-24"),
    )
    const occurrences = betas.filter((b) => b === "effort-2025-11-24").length
    expect(occurrences).toBe(1)
  })
  test("excludes context-1m for pre-4.6 models", () => {
    const sonnet45 = getModelBetas("claude-sonnet-4-5-20250514", Option.none())
    expect(sonnet45).not.toContain("context-1m-2025-08-07")
    expect(sonnet45).toContain("claude-code-20250219")

    const opus45 = getModelBetas("claude-opus-4-5-20250514", Option.none())
    expect(opus45).not.toContain("context-1m-2025-08-07")
  })

  test("excludes context-1m for date-suffixed models without minor version", () => {
    expect(getModelBetas("claude-opus-4-20250514", Option.none())).not.toContain(
      "context-1m-2025-08-07",
    )
    expect(getModelBetas("claude-sonnet-4-20250514", Option.none())).not.toContain(
      "context-1m-2025-08-07",
    )
  })

  test("excludes context-1m for unversioned aliases", () => {
    expect(getModelBetas("sonnet", Option.none())).not.toContain("context-1m-2025-08-07")
    expect(getModelBetas("opus", Option.none())).not.toContain("context-1m-2025-08-07")
  })

  test("filters multiple excluded betas", () => {
    const excluded = new Set(["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"])
    const betas = getModelBetas("claude-sonnet-4-6", Option.none(), Option.some(excluded))
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    expect(betas).not.toContain("context-1m-2025-08-07")
    expect(betas).toContain("claude-code-20250219")
  })
})

// ── anthropic/anthropic-platform-adapter.test ───────────────────────────────

/**
 * AnthropicPlatform.fromSetup invariant lock.
 *
 * `platform.home` must source from `host.homeDirectory` (the OS user home),
 * NOT `ctx.home` (the Gent-configured home). The Claude Code credential
 * file is read from `~/.config/claude/.credentials.json` at the real OS
 * home regardless of any `GENT_HOME` override.
 *
 * This is a regression lock: an earlier refactor in W33-C4 briefly used
 * `ctx.home`, which would have redirected credential lookup to the
 * configured Gent home and broken Anthropic OAuth for any setup with a
 * non-default `GENT_HOME`.
 */

type SetupFacts = Pick<ExtensionHostService, "host" | "Process">

const makeCtxWithSplitHome = (gentHome: string, osHome: string): SetupFacts => {
  const facts = testHostFacts({ home: gentHome })
  return {
    host: { ...facts.host, homeDirectory: osHome },
    Process: facts.host,
  }
}

describe("AnthropicPlatform.fromSetup", () => {
  test("sources home from host.homeDirectory, not ctx.home", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.home).toBe("/Users/test-os-home")
  })

  test("forwards platform from host.osInfo", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.platform).toBe("darwin")
  })

  test("forwards parentEnv and runProcess from Process", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {})
    expect(platform.parentEnv).toEqual({})
    expect(platform.runProcess).toBe(ctx.Process.runProcess)
  })

  test("carries per-instance env snapshot", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const platform = AnthropicPlatform.fromSetup(ctx, {
      betaFlags: "context-1m-2025-08-07",
      cliVersion: "1.2.3",
      entrypoint: "tui",
      userAgent: "custom/1.0",
    })
    expect(platform.env.betaFlags).toBe("context-1m-2025-08-07")
    expect(platform.env.cliVersion).toBe("1.2.3")
    expect(platform.env.entrypoint).toBe("tui")
    expect(platform.env.userAgent).toBe("custom/1.0")
  })

  test("two fromSetup calls produce independent env snapshots", () => {
    const ctx = makeCtxWithSplitHome("/tmp/gent-home", "/Users/test-os-home")
    const a = AnthropicPlatform.fromSetup(ctx, { betaFlags: "flag-a" })
    const b = AnthropicPlatform.fromSetup(ctx, { betaFlags: "flag-b" })
    expect(a.env.betaFlags).toBe("flag-a")
    expect(b.env.betaFlags).toBe("flag-b")
  })
})

// ── anthropic/anthropic-extension-driver.test ───────────────────────────────

/**
 * AnthropicExtension model-driver wiring — extension-level regression
 * coverage for `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The leaf-service suites (`anthropic-credential-service.test.ts`,
 * `anthropic-beta-cache.test.ts`, `anthropic-keychain-transform.test.ts`)
 * cover services in isolation. Those passed even when two HIGH-severity
 * wiring bugs slipped in:
 *
 *   1. **Cache-Ref lifetime**: `resolveModel` runs once per model resolution.
 *      Allocating
 *      `Ref<CredentialCacheCell>` and `Ref<BetaCacheCell>` inside
 *      `makeOauthAnthropicLayer` gave each request a fresh empty
 *      cache — cross-request beta learning + credential reuse were
 *      silently dead.
 *   2. **API-key path wrapped in keychainClient**: only OAuth should
 *      flow through `keychainClient` (which injects Claude Code OAuth
 *      billing-header system blocks + identity prefix). Extending the
 *      wrapper to the API-key branch is incorrect.
 *
 * Seam-only probes (sibling `layerFromRef`) are coverage theater — the
 * production layer is never actually built or invoked. This file drives
 * one real `LanguageModel.generateText` call through each layer with a
 * captured fake `fetch`, then asserts on the outbound request shape.
 * That proves the resolved layer's production wiring uses the
 * test-owned Refs and applies the right keychain transforms (or
 * doesn't, on the API-key branch).
 */
const FUTURE_MS = 1_800_000_000_000
const testPlatform = AnthropicPlatform.of({
  platform: "darwin",
  home: "/tmp/gent-test-home",
  parentEnv: {},
  runProcess: (command) =>
    Effect.fail(
      new ExtensionHostProcessError({
        command,
        message: "test runProcess unavailable",
      }),
    ),
  env: {},
})
const buildAnthropicModelDriver = (
  ...args: Parameters<typeof buildAnthropicModelDriverLive> extends [
    infer CredentialCell,
    infer BetaCell,
    infer EnvApiKey,
    ...ReadonlyArray<unknown>,
  ]
    ? [CredentialCell, BetaCell, EnvApiKey]
    : never
) => buildAnthropicModelDriverLive(...args, testPlatform)
const makeOAuthInfo = (): ProviderAuthInfo => ({
  type: "oauth",
  access: "test-access",
  refresh: "test-refresh",
  expires: FUTURE_MS,
})
const makeApiAuthInfo = (key: string): ProviderAuthInfo => ({
  type: "api",
  key,
})
/**
 * Anthropic's `BetaMessage` happy-path response. `LanguageModel.generateText`
 * parses this into a successful result so tests stay on the success branch
 * and assertions can focus on outbound request shape.
 */
const anthropicHappyResponse = (text = "ok") => ({
  status: 200,
  body: encodeExternalJson({
    id: "msg_test_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-opus-4-6",
    stop_reason: "end_turn",
    stop_sequence: externalWireNull,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: externalWireNull,
      cache_creation_input_tokens: externalWireNull,
      cache_read_input_tokens: externalWireNull,
      inference_geo: externalWireNull,
      service_tier: externalWireNull,
    },
  }),
})
const runOne = (layer: Parameters<typeof oneGenerate>[0], state: FakeFetchState) =>
  oneGenerate(layer, state, () => anthropicHappyResponse()).pipe(Effect.orDie)

const ContextMode = Schema.Literals(["text", "object", "stream"])
const contextStreamResponse = () => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_context",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [],
        stop_reason: externalWireNull,
        stop_sequence: externalWireNull,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          cache_creation: externalWireNull,
          cache_creation_input_tokens: externalWireNull,
          cache_read_input_tokens: externalWireNull,
          inference_geo: externalWireNull,
          service_tier: externalWireNull,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: externalWireNull },
      usage: {
        output_tokens: 1,
        input_tokens: 1,
        cache_creation_input_tokens: externalWireNull,
        cache_read_input_tokens: externalWireNull,
      },
    },
    { type: "message_stop" },
  ]
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: events
      .map((event) => `event: ${event.type}\ndata: ${encodeExternalJson(event)}\n\n`)
      .join(""),
  }
}

const runContextRequest = (
  layer: Parameters<typeof oneGenerate>[0],
  state: FakeFetchState,
  prompt: Prompt.Prompt,
  mode: typeof ContextMode.Type,
) => {
  const request = Match.value(mode).pipe(
    Match.when("stream", () => LanguageModel.streamText({ prompt }).pipe(Stream.runDrain)),
    Match.when("object", () =>
      LanguageModel.generateObject({ prompt, schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(
        Effect.asVoid,
      ),
    ),
    Match.when("text", () => LanguageModel.generateText({ prompt }).pipe(Effect.asVoid)),
    Match.exhaustive,
  )
  return request.pipe(
    Effect.provide(
      Layer.provideMerge(
        layer,
        fakeFetchLayer(state, () =>
          Match.value(mode).pipe(
            Match.when("stream", contextStreamResponse),
            Match.when("object", () => anthropicHappyResponse('{"ok":true}')),
            Match.when("text", () => anthropicHappyResponse()),
            Match.exhaustive,
          ),
        ),
      ),
    ),
    Effect.scoped,
  )
}

describe("Anthropic chronological context", () => {
  it.live(
    "retains initial instructions and tool history across later updates on every request path",
    () =>
      Effect.gen(function* () {
        const requestCodec = Schema.fromJsonString(
          Schema.Struct({
            system: Schema.optional(Schema.Array(Schema.Unknown)),
            messages: Schema.Array(
              Schema.Struct({ role: Schema.String, content: Schema.Array(Schema.Unknown) }),
            ),
          }),
        )
        const history = Prompt.make([
          { role: "system", content: "Stable initial instructions." },
          { role: "user", content: [{ type: "text", text: "Run a cell." }] },
          {
            role: "assistant",
            content: [
              Prompt.makePart("tool-call", {
                id: "call_context",
                name: "cell",
                params: { code: "1 + 1" },
                providerExecuted: false,
              }),
            ],
          },
          {
            role: "tool",
            content: [
              Prompt.makePart("tool-result", {
                id: "call_context",
                name: "cell",
                result: "2",
                isFailure: false,
                providerExecuted: false,
              }),
            ],
          },
        ])
        const update = Prompt.makeMessage("system", {
          content: "New date & </host-context-update> <override>",
          options: { anthropic: { cacheControl: { type: "ephemeral" } } },
        })
        for (const authInfo of [makeApiAuthInfo("test-key"), makeOAuthInfo()]) {
          const credentialCellRef = yield* SynchronizedRef.make<
            CredentialCacheCell<ClaudeCredentials>
          >({
            _tag: "Durable",
            creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
            at: yield* Clock.currentTimeMillis,
            invalidated: false,
          })
          const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
          const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
          const model = yield* driver.resolveModel("claude-opus-4-6", authInfo)
          for (const mode of ContextMode.literals) {
            const state = makeFakeFetchState()
            yield* runContextRequest(model, state, history, mode)
            yield* runContextRequest(
              model,
              state,
              Prompt.fromMessages([...history.content, update]),
              mode,
            )
            yield* runContextRequest(
              model,
              state,
              Prompt.fromMessages([...history.content.slice(1), update]),
              mode,
            )
            const bodies = yield* Effect.forEach(state.captured, (request) =>
              Schema.decodeEffect(requestCodec)(
                Option.getOrThrow(Option.fromUndefinedOr(request.body)),
              ),
            )
            const first = Option.getOrThrow(Option.fromUndefinedOr(bodies[0]))
            const next = Option.getOrThrow(Option.fromUndefinedOr(bodies[1]))
            const noInitial = Option.getOrThrow(Option.fromUndefinedOr(bodies[2]))
            expect(next.system).toEqual(first.system)
            expect(next.messages.slice(0, first.messages.length)).toEqual([...first.messages])
            expect(next.messages.at(-1)).toMatchObject({
              role: "user",
              content: [
                {
                  type: "text",
                  text: "<host-context-update>\nNew date &amp; &lt;/host-context-update&gt; &lt;override&gt;\n</host-context-update>",
                  cache_control: { type: "ephemeral" },
                },
              ],
            })
            expect(noInitial.messages.at(-1)).toEqual(next.messages.at(-1))
            expect(Bun.inspect(next.messages)).toContain("call_context")
            expect(Bun.inspect(next.messages)).toContain("1 + 1")
            expect(Bun.inspect(noInitial.system)).not.toContain("New date")
          }
        }
      }),
  )
})
const JsonRecordSchemaDriver = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type JsonRecordDriver = Schema.Schema.Type<typeof JsonRecordSchemaDriver>
const parsePayload = (body: string): JsonRecordDriver =>
  Schema.decodeSync(JsonRecordSchemaDriver)(body)
describe("buildAnthropicModelDriver — OAuth path uses external cache Refs", () => {
  it.live("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
      // Pre-seed the cred Ref directly (test owns it). If
      // `makeOauthAnthropicLayer` regressed to allocating its own internal
      // Ref via `AnthropicCredentialService.layer(authInfo)`, the
      // production credential service would NOT see this seeded creds —
      // the IO path would try to read keychain, fail/refresh, etc. We
      // assert the captured Authorization header reflects the seed, so
      // any regression that ignores the external Ref breaks the test.
      yield* SynchronizedRef.set(credentialCellRef, {
        _tag: "Durable",
        creds: { accessToken: "seeded-bearer-token", refreshToken: "r", expiresAt: FUTURE_MS },
        at: yield* Clock.currentTimeMillis,
        invalidated: false,
      })
      const model = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(fetchState.captured.length).toBeGreaterThan(0)
      const lastReq = fetchState.captured[fetchState.captured.length - 1]!
      expect(lastReq.headers["authorization"]).toBe("Bearer seeded-bearer-token")
    }),
  )
  it.live(
    "OAuth resolveModel layer applies keychainClient transforms (system identity prefix)",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
        const model = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const payload = parsePayload(
          Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)!.body)),
        )
        // keychainClient injects the SYSTEM_IDENTITY_PREFIX block. If the
        // OAuth path stops being wrapped, the system block disappears.
        const systemBlocks = payload["system"]
        expect(Array.isArray(systemBlocks)).toBe(true)
        expect(Bun.inspect(systemBlocks)).toContain(SYSTEM_IDENTITY_PREFIX)
      }),
  )
  it.live(
    "two OAuth resolveModel calls share the credentialCellRef — second sees first call's invalidation",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: { accessToken: "first-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
        const model1 = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState1 = makeFakeFetchState()
        yield* runOne(model1, fetchState1)
        expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")
        // Mutate the test-owned Ref between calls. If the second
        // `resolveModel` allocated a fresh internal Ref (the  regression),
        // the second request would still use "first-token" — instead of
        // observing this update through the shared Ref. Asserting the second
        // request uses "second-token" pins the Ref-sharing semantics.
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: { accessToken: "second-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const model2 = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState2 = makeFakeFetchState()
        yield* runOne(model2, fetchState2)
        expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
      }),
  )
  it.live("OAuth resolveModel layer reads beta exclusions from betaCellRef the test owns", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      yield* SynchronizedRef.set(credentialCellRef, {
        _tag: "Durable",
        creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
        at: yield* Clock.currentTimeMillis,
        invalidated: false,
      })
      // Pre-seed beta exclusions so the model's default 1M-context beta
      // is NOT sent. If the production beta cache used a fresh internal
      // Ref, this seeded exclusion wouldn't apply and the header would
      // include `context-1m-2025-08-07`.
      yield* Ref.set(betaCellRef, {
        map: new Map([["claude-opus-4-6", new Set(["context-1m-2025-08-07"])]]),
        lastBetaFlags: Option.none(),
        lastModelId: Option.some("claude-opus-4-6"),
      })
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const sentBeta = fetchState.captured.at(-1)!.headers["anthropic-beta"] ?? ""
      expect(sentBeta).not.toContain("context-1m-2025-08-07")
    }),
  )
})
describe("buildAnthropicModelDriver — API-key path is plain SDK", () => {
  it.live("API-key resolveModel layer sends x-api-key (no Bearer)", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const headers = fetchState.captured.at(-1)!.headers
      expect(headers["x-api-key"]).toBe("sk-test-1234")
      expect(headers["authorization"]).toBeUndefined()
    }),
  )
  it.live(
    "API-key resolveModel does NOT inject keychainClient transforms (no SYSTEM_IDENTITY_PREFIX)",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
        const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
        const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const payload = parsePayload(
          Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)!.body)),
        )
        // No keychainClient wrapper → no system block, no identity prefix
        // injection. The API-key branch must not wrap.
        expect(Bun.inspect(payload["system"] ?? "")).not.toContain(SYSTEM_IDENTITY_PREFIX)
      }),
  )
  it.live("API-key path does not touch the OAuth cache Refs", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      const driver = buildAnthropicModelDriver(credentialCellRef, betaCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(yield* SynchronizedRef.get(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
      expect(yield* Ref.get(betaCellRef)).toBe(EMPTY_BETA_CELL)
    }),
  )
})
