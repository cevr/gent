import { createDependencies, StateLocation } from "@gent/core/host"
import { describe, expect, it, test } from "effect-bun-test"
import {
  makeAnthropicCredentialCache,
  AnthropicExtension,
  type AnthropicCredentialIO,
  type AnthropicKeychainEnv,
  AnthropicPlatform,
  buildAnthropicModelDriver as buildAnthropicModelDriverLive,
  buildBillingHeaderValue as buildBillingHeaderValueEffect,
  buildKeychainTransformClient,
  type ClaudeCredentials,
  extractFirstUserMessageText,
  getModelBetas,
  parseOAuthResponse,
  readPromptCacheTtl,
  SYSTEM_IDENTITY_PREFIX,
  transformPayload as transformPayloadEffect,
  transformResponseContent,
  transformStreamEvent,
  updateCredentialBlob,
} from "../src/anthropic.js"
import {
  Cause,
  Clock,
  ConfigProvider,
  Context,
  type Crypto,
  FileSystem,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Path,
  PlatformError,
  Ref,
  Result,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import type * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import { ChildProcessSpawner } from "effect/process"
import {
  captureProviderStopReason,
  storedCredentialModel,
  createRpcHarness,
  createRpcClient,
  ConfigService,
  modelCatalogFixture,
  BunGentPlatformLive,
  LanguageModelLayers,
  testAgent,
  textStep,
  fixtureModelCatalog,
  testHostFacts,
  turnNoticesText,
} from "@gent/core/test-utils"
import { resolveShipped } from "./helpers/api-classes.js"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/http"
import {
  type CredentialCacheCell,
  type CredentialFailure,
  CredentialRefreshUnavailable,
  EMPTY_CREDENTIAL_CELL,
  hostContextUpdateText,
} from "../src/providers.js"
import {
  type ExtensionHostService,
  ExtensionHost,
  defineExtension,
  ProviderAuthError,
  CredentialSlot,
  type ProviderHints,
  SessionId,
  ProviderAuthInfo,
} from "@gent/core/extensions/api"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import {
  type FakeClientState,
  fakeFetchLayer,
  type FakeFetchState,
  type FakeResponder,
  makeFakeClient,
  makeFakeFetchState,
  oneGenerate,
  respondFirstWith,
  transportFailure,
} from "./helpers/fake-http-client.js"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { AnthropicClient as AnthropicSdkClient, AnthropicLanguageModel } from "@effect/ai-anthropic"

// ── payload transforms ──────────────────────────────────────────────────────

const testPlatformLayer = Layer.succeed(
  AnthropicPlatform,
  AnthropicPlatform.of({
    platform: "darwin",
    home: "/nonexistent/gent-test-home",
    env: {},
  }),
)

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>

/** The payload transform with the host's crypto and platform provided. */
const transformPayload = (payload: JsonRecord) =>
  transformPayloadEffect(payload, Option.some({ request: "1h", shared: "1h" })).pipe(
    Effect.provide(Layer.merge(BunCrypto.layer, testPlatformLayer)),
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

// ── transformPayload ──

describe("transformPayload", () => {
  // Tool names go on the wire as `mcp_<PascalCase>` — Anthropic's OAuth
  // billing validator rejects lowercase-after-prefix tool names when
  // multiple tools are present (matches Claude Code's PascalCase
  // convention; opencode-claude-auth issue notes).
  it.effect("prefixes tool names in tools[] with PascalCase", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [],
        tools: [
          { type: "custom", name: "echo", input_schema: { type: "object" } },
          { type: "custom", name: "search", input_schema: { type: "object" } },
        ],
      }
      const result = yield* transformPayload(payload)
      const tools = decodeNamedTools(result["tools"])
      expect(tools[0]!.name).toBe("mcp_Echo")
      expect(tools[1]!.name).toBe("mcp_Search")
    }),
  )

  it.effect("prefixes tool_use names in historical messages with PascalCase", () =>
    Effect.gen(function* () {
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
      const result = yield* transformPayload(payload)
      const msgs = decodeMessagesWithBlocks(result["messages"])
      const toolUse = msgs[0]!.content[1]!
      expect(toolUse["name"]).toBe("mcp_Echo")
    }),
  )

  it.effect("does not prefix non-tool_use blocks", () =>
    Effect.gen(function* () {
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
      const result = yield* transformPayload(payload)
      const msgs = decodeMessagesWithBlocks(result["messages"])
      expect(msgs[0]!.content[0]!["type"]).toBe("text")
      expect(msgs[0]!.content[0]!["text"]).toBe("hello")
    }),
  )

  it.effect("prefixes tool_choice name with PascalCase when type is tool", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [],
        tool_choice: { type: "tool", name: "echo" },
      }
      const result = yield* transformPayload(payload)
      const tc = decodeToolChoice(result["tool_choice"])
      expect(tc.name).toBe("mcp_Echo")
    }),
  )

  it.effect("does not modify tool_choice when type is auto", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [],
        tool_choice: { type: "auto" },
      }
      const result = yield* transformPayload(payload)
      expect(result["tool_choice"]).toEqual({ type: "auto" })
    }),
  )

  it.effect("unconditionally prefixes — mcp_foo becomes mcp_Mcp_foo", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [],
        tools: [{ type: "custom", name: "mcp_foo", input_schema: { type: "object" } }],
      }
      const result = yield* transformPayload(payload)
      const tools = decodeNamedTools(result["tools"])
      expect(tools[0]!.name).toBe("mcp_Mcp_foo")
    }),
  )

  it.effect("keeps model and max_tokens on a payload with no tools", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        messages: [],
      }
      const result = yield* transformPayload(payload)
      expect(result["model"]).toBe("claude-opus-4-6")
      expect(result["max_tokens"]).toBe(4096)
    }),
  )
})

// ── transformResponseContent ──

describe("transformResponseContent", () => {
  test("strips mcp_ prefix from tool_use blocks", () => {
    const content = [
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "tc-1", name: "mcp_echo", input: { text: "hi" } },
    ]
    const result = transformResponseContent(content, [])
    expect(result[0]!["name"]).toBeUndefined()
    expect(result[1]!["name"]).toBe("echo")
  })

  test("does not modify non-tool_use blocks", () => {
    const content = [{ type: "text", text: "hello" }]
    const result = transformResponseContent(content, [])
    expect(result[0]).toEqual({ type: "text", text: "hello" })
  })

  test("passes through tool_use without mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }]
    const result = transformResponseContent(content, [])
    expect(result[0]!["name"]).toBe("echo")
  })

  test("restores a tool id with an uppercase first letter from the request's tools", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "mcp_Deploy", input: {} }]
    const result = transformResponseContent(content, ["Deploy", "echo"])
    expect(result[0]!["name"]).toBe("Deploy")
  })

  test("strips exactly one mcp_ prefix", () => {
    const content = [{ type: "tool_use", id: "tc-1", name: "mcp_mcp_foo", input: {} }]
    const result = transformResponseContent(content, [])
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
    const result = transformStreamEvent([])(event)
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
    const result = transformStreamEvent([])(event)
    expect(result.type).toBe("content_block_start")
    if (result.type === "content_block_start") expect(result.content_block.type).toBe("text")
  })

  test("passes through events other than content_block_start, content_block_delta included", () => {
    const events: ReadonlyArray<AnthropicClient.MessageStreamEvent> = [
      { type: "message_stop" },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"text":' },
      },
    ]
    for (const event of events) {
      expect(transformStreamEvent([])(event)).toBe(event)
    }
  })
})

// ── system relocation (opencode parity A) ──

describe("transformPayload — system content relocation", () => {
  it.effect("moves third-party system blocks into the first user message", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [
          { type: "text", text: "third-party system instructions" },
          { type: "text", text: "additional rules" },
        ],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }
      const result = yield* transformPayload(payload)
      const system = decodeSystemBlocks(result["system"])
      // After relocation, system[] holds only billing + identity entries.
      expect(system).toHaveLength(2)
      const systemTexts = system.map((b) => b.text ?? "")
      expect(systemTexts.some((t) => t.startsWith("x-anthropic-billing-header"))).toBe(true)
      expect(systemTexts.some((t) => t.startsWith(SYSTEM_IDENTITY_PREFIX))).toBe(true)
      // Each relocated block leads the first user message, in its order.
      const messages = decodeMessagesWithBlocks(result["messages"])
      expect(messages[0]!.content.map((block) => block["text"])).toEqual([
        "third-party system instructions",
        "additional rules",
        // Original user text survives at the tail.
        "hello",
      ])
    }),
  )

  it.effect("relocates into a string-content user message", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [{ type: "text", text: "third-party prefix" }],
        messages: [{ role: "user", content: "hello" }],
      }
      const result = yield* transformPayload(payload)
      const messages = decodeMessagesWithText(result["messages"])
      expect(messages[0]!.content).toContain("third-party prefix")
      expect(messages[0]!.content.endsWith("hello")).toBe(true)
    }),
  )

  it.effect("leaves system unchanged when there are no third-party blocks", () =>
    Effect.gen(function* () {
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }
      const result = yield* transformPayload(payload)
      const system = decodeSystemBlocks(result["system"])
      // billing + identity only — no extras to move.
      expect(system).toHaveLength(2)
      const messages = decodeMessagesWithBlocks(result["messages"])
      expect(messages[0]!.content).toHaveLength(1)
    }),
  )

  it.effect("splits IDENTITY+rest blocks so the rest gets relocated", () =>
    Effect.gen(function* () {
      // OpenCode's system.transform hook produces a single block of
      // shape `IDENTITY + "\n\n<real instructions>"`. The partition keeps
      // only the bare identity prefix in the system prompt; the remainder
      // must survive into the first user message via relocation.
      const payload = {
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [{ type: "text", text: `${SYSTEM_IDENTITY_PREFIX}\n\nDO-NOT-DROP these rules.` }],
        messages: [{ role: "user", content: "hello" }],
      }
      const result = yield* transformPayload(payload)
      const system = decodeSystemBlocks(result["system"])
      // System still holds [billing, identity] — identity is the bare
      // prefix without the trailing rules.
      expect(system[1]!.text).toBe(SYSTEM_IDENTITY_PREFIX)
      // The rules survived: relocated into the first user message.
      const messages = decodeMessagesWithText(result["messages"])
      expect(messages[0]!.content).toContain("DO-NOT-DROP these rules.")
      expect(messages[0]!.content.endsWith("hello")).toBe(true)
    }),
  )

  it.effect("billing hash matches the post-relocation first-user text", () =>
    Effect.gen(function* () {
      // Billing is computed after relocation, so the hash on the wire
      // matches the first-user text the API sees. Compare against a
      // control payload with the same POST-relocation first-user text but
      // no system to relocate — the billing hash header must be identical.
      const relocatedPayload = yield* transformPayload({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [{ type: "text", text: "third-party prefix" }],
        messages: [{ role: "user", content: "hello" }],
      })
      const controlPayload = yield* transformPayload({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: [],
        // The control directly carries what the relocator would produce.
        messages: [{ role: "user", content: "third-party prefix\n\nhello" }],
      })
      const relocatedBilling = decodeSystemBlocks(relocatedPayload["system"])[0]?.text
      const controlBilling = decodeSystemBlocks(controlPayload["system"])[0]?.text
      expect(relocatedBilling).toBe(controlBilling)
    }),
  )

  it.effect(
    "inserts relocated text after a leading tool_result run (preserves Anthropic ordering)",
    () =>
      Effect.gen(function* () {
        // Anthropic requires tool_result blocks to be the FIRST blocks of
        // a user message that carries any. The relocator
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
          tools: [],
        }
        // A valid history: each tool_result has its tool_use upstream.
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
        const result = yield* transformPayload(payloadWithPair)
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
      }),
  )
})

// ── keychain transform client ───────────────────────────────────────────────

/**
 * keychainTransformClient — auth-headers middleware.
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
// A credential cache over a fresh cell, on the test host's platform.
const credentialCache = (io: AnthropicCredentialIO) => {
  const host = testHostFacts().host
  const platformLayer = Layer.succeed(
    AnthropicPlatform,
    AnthropicPlatform.of({
      platform: host.osInfo.platform,
      home: host.homeDirectory,
      env: {},
    }),
  )
  return SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
    Effect.flatMap((cellRef) => makeAnthropicCredentialCache(cellRef, io)),
    Effect.provide(Layer.merge(BunServices.layer, platformLayer)),
  )
}
const validCredsIO = (label: string): AnthropicCredentialIO => ({
  read: Effect.succeed(makeCredsKeychain(label)),
  refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})
// `HttpBody.jsonUnsafe` mirrors how the Anthropic SDK serializes
// outgoing JSON bodies (via `text` → Uint8Array). The transform reads
// the body via `requestJsonObject`, which decodes that Uint8Array back to
// JSON, so this matches production representation.
const jsonBody = (payload: JsonRecord) => HttpBody.jsonUnsafe(payload)
// `Effect.orDie` collapses typed errors to defects so test bodies can
// assert success without `as Effect<unknown, never, never>` casts.
const runOk = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.scoped(eff.pipe(Effect.orDie))
const answerOk = () => ({ status: 200, body: "ok" })
/**
 * A keychain-transform client over a fake that records each request and
 * answers with `responder`. `post` sends one claude-opus-4-6 message.
 */
const keychainClient = (responder: FakeResponder, io: AnthropicCredentialIO = validCredsIO("k1")) =>
  Effect.gen(function* () {
    const creds = yield* credentialCache(io)
    const fakeState: FakeClientState = { captured: [], responder }
    const wrapped = buildKeychainTransformClient(creds, TEST_ENV)(makeFakeClient(fakeState))
    const post = (headers: Record<string, string> = {}) =>
      wrapped.post("https://api.anthropic.com/v1/messages", {
        headers,
        body: jsonBody({ model: "claude-opus-4-6" }),
      })
    return { post, captured: fakeState.captured }
  })
/** One message through a fresh keychain-transform client: its exit and the requests the fake saw. */
const sendOnce = (
  responder: FakeResponder,
  options: { readonly io?: AnthropicCredentialIO; readonly headers?: Record<string, string> } = {},
) =>
  Effect.gen(function* () {
    const { post, captured } = yield* keychainClient(responder, options.io)
    const exit = yield* Effect.scoped(post(options.headers)).pipe(Effect.exit)
    return { exit, captured }
  })
/** The status of a request that reached the fake, or false if it failed. */
const statusOf = (exit: Exit.Exit<HttpClientResponse.HttpClientResponse, unknown>) =>
  Exit.isSuccess(exit) && exit.value.status
// ── Tests ──
describe("keychainTransformClient — auth headers", () => {
  it.scopedLive("injects Authorization Bearer from credential service", () =>
    Effect.gen(function* () {
      const { exit, captured } = yield* sendOnce(answerOk)
      expect(statusOf(exit)).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.scopedLive("removes x-api-key (would otherwise conflict with OAuth Bearer)", () =>
    Effect.gen(function* () {
      // Simulate the SDK's baseline by injecting x-api-key on the
      // outgoing request. The transform must strip it.
      const { exit, captured } = yield* sendOnce(answerOk, {
        headers: { "x-api-key": "oauth-placeholder", "anthropic-version": "2023-06-01" },
      })
      expect(statusOf(exit)).toBe(200)
      expect(captured[0]!.headers["x-api-key"]).toBeUndefined()
      // Preserves SDK baseline header
      expect(captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
    }),
  )
  it.scopedLive("sets x-app, user-agent, anthropic-dangerous-direct-browser-access", () =>
    Effect.gen(function* () {
      const { exit, captured } = yield* sendOnce(answerOk)
      expect(statusOf(exit)).toBe(200)
      const headers = captured[0]!.headers
      expect(headers["x-app"]).toBe("cli")
      expect(headers["user-agent"]).toMatch(/^claude-cli\/.+ \(external, cli\)$/)
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
    }),
  )
  it.scopedLive("merges anthropic-beta with model defaults", () =>
    Effect.gen(function* () {
      // Body declares claude-opus-4-6, which has model-default betas
      // (base set + 1M-context + effort-2025-11-24 from the override).
      // Incoming "incoming-beta-1" must merge with those, not replace.
      const { exit, captured } = yield* sendOnce(answerOk, {
        headers: { "anthropic-beta": "incoming-beta-1" },
      })
      expect(statusOf(exit)).toBe(200)
      const beta = captured[0]!.headers["anthropic-beta"]
      expect(beta).toBeDefined()
      const betas = beta!.split(",").map((s) => s.trim())
      // Incoming preserved
      expect(betas).toContain("incoming-beta-1")
      // Model default present (oauth-2025-04-20 is a base beta)
      expect(betas).toContain("oauth-2025-04-20")
      // Per-model-override present (effort-2025-11-24 is added for "4-6")
      expect(betas).toContain("effort-2025-11-24")
    }),
  )
  it.scopedLive("credential-service failure surfaces as a request-build HttpClientError", () =>
    Effect.gen(function* () {
      const { exit, captured } = yield* sendOnce(answerOk, {
        io: {
          read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
          refresh: () => Effect.fail(new ProviderAuthError({ message: "no refresh token either" })),
        },
      })
      // The fake client never saw the request — the transform short-
      // circuited at the credential read.
      expect(captured).toHaveLength(0)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = Cause.findErrorOption(exit.cause)
      // EncodeError maps to a non-retryable AiError; TransportError would be retried.
      expect(Option.isSome(error) && error.value.reason._tag).toBe("EncodeError")
    }),
  )
})
describe("keychainTransformClient — transient failures reach the loop", () => {
  // The agent loop owns the retry of 429, 529, 5xx, and transport failures
  // (it honors retry-after and reports each attempt). The transform sends
  // each request once and hands the result back.
  for (const status of [429, 529, 500]) {
    it.scopedLive(`a ${status} reaches the caller after one attempt`, () =>
      Effect.gen(function* () {
        const { exit, captured } = yield* sendOnce(() => ({ status, body: "busy" }))
        expect(captured).toHaveLength(1)
        expect(Exit.isSuccess(exit) && exit.value.status).toBe(status)
      }),
    )
  }
  it.scopedLive("a long-context 400 reaches the caller after one attempt, betas untouched", () =>
    Effect.gen(function* () {
      const body =
        '{"type":"error","error":{"message":"Extra usage is required for long context requests"}}'
      const { exit, captured } = yield* sendOnce(() => ({ status: 400, body: body }))
      expect(captured).toHaveLength(1)
      expect(Exit.isSuccess(exit) && exit.value.status).toBe(400)
      expect(captured[0]!.headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14")
    }),
  )
  it.scopedLive("a transport failure reaches the caller after one attempt", () =>
    Effect.gen(function* () {
      const { exit, captured } = yield* sendOnce(() => transportFailure("socket hang up"))
      expect(captured).toHaveLength(1)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
describe("keychainTransformClient — 401 recovery", () => {
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
      refresh: () => Effect.fail(new ProviderAuthError({ message: "should not be called" })),
    }
  }
  it.scopedLive("401 once → invalidate creds → retry succeeds with fresh token", () =>
    Effect.gen(function* () {
      const { exit, captured } = yield* sendOnce(
        respondFirstWith({ status: 401, body: "auth" }, answerOk()),
        { io: togglingCredsIO("stale", "fresh") },
      )
      expect(captured).toHaveLength(2)
      expect(statusOf(exit)).toBe(200)
      // Crucial: token differs across attempts — invalidate forced the
      // mapRequestEffect to re-read creds, getting the fresh token.
      expect(captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
      expect(captured[1]!.headers["authorization"]).toBe("Bearer fresh-access")
    }),
  )
  it.scopedLive("401 with the keychain unchanged → refresh with its refresh token → retry", () =>
    Effect.gen(function* () {
      // The server revoked a token whose expiry is still ahead; the keychain
      // still holds it, so only a refresh can replace it.
      const held: Array<Option.Option<ClaudeCredentials>> = []
      const { exit, captured } = yield* sendOnce(
        respondFirstWith({ status: 401, body: "auth" }, answerOk()),
        {
          io: {
            read: Effect.succeed(makeCredsKeychain("revoked")),
            refresh: (credential) =>
              Effect.sync(() => {
                held.push(credential)
                return makeCredsKeychain("renewed")
              }),
          },
        },
      )
      expect(statusOf(exit)).toBe(200)
      expect(captured[0]!.headers["authorization"]).toBe("Bearer revoked-access")
      expect(captured[1]!.headers["authorization"]).toBe("Bearer renewed-access")
      expect(held).toEqual([Option.some(makeCredsKeychain("revoked"))])
    }),
  )
  it.scopedLive("a late 401 for a token already replaced does not refresh again", () =>
    Effect.gen(function* () {
      // The refresh writes the keychain, as the real one does.
      const keychain = yield* Ref.make(makeCredsKeychain("old"))
      const refreshes = yield* Ref.make(0)
      const creds = yield* credentialCache({
        read: Ref.get(keychain),
        refresh: () =>
          Effect.gen(function* () {
            yield* Ref.update(refreshes, (count) => count + 1)
            yield* Ref.set(keychain, makeCredsKeychain("new"))
            return makeCredsKeychain("new")
          }),
      })
      // A and B both send the old token. B's 401 arrives after A refreshed.
      const bSent = yield* Deferred.make<boolean>()
      const aRenewed = yield* Deferred.make<boolean>()
      const sent: Array<string> = []
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          const authorization = String(request.headers["authorization"])
          const call = sent.push(authorization) - 1
          if (call === 0) yield* Deferred.await(bSent)
          if (call === 1) {
            yield* Deferred.succeed(bSent, true)
            yield* Deferred.await(aRenewed)
          }
          if (authorization === "Bearer new-access") {
            yield* Deferred.succeed(aRenewed, true)
            return HttpClientResponse.fromWeb(request, new Response("ok", { status: 200 }))
          }
          return HttpClientResponse.fromWeb(request, new Response("auth", { status: 401 }))
        }),
      )
      const wrapped = buildKeychainTransformClient(creds, TEST_ENV)(client)
      const post = runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      const a = yield* Effect.forkScoped(post)
      // B starts once A holds the old token on the wire.
      yield* Effect.yieldNow
      const b = yield* Effect.forkScoped(post)
      const responses = yield* Effect.all([Fiber.join(a), Fiber.join(b)]).pipe(
        Effect.timeout("4 seconds"),
      )
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(sent.slice(0, 2)).toEqual(["Bearer old-access", "Bearer old-access"])
      expect(yield* Ref.get(refreshes)).toBe(1)
    }),
  )
  it.scopedLive(
    "two consecutive 401s — second surfaces (real auth failure, no infinite loop)",
    () =>
      Effect.gen(function* () {
        // Both attempts get 401 — the second 401 is a real auth failure
        // (revoked session, missing scope) and must reach the caller.
        const { exit, captured } = yield* sendOnce(() => ({ status: 401, body: "auth" }), {
          io: togglingCredsIO("stale", "still-bad"),
        })
        // 1 initial + 1 retry = 2 attempts (no third)
        expect(captured).toHaveLength(2)
        expect(statusOf(exit)).toBe(401)
      }),
  )
  it.scopedLive("non-401 failure does not invalidate creds", () =>
    Effect.gen(function* () {
      // Fire TWO sequential requests (500 then 200) on the same creds
      // service. If a non-401 mistakenly invalidated the cache, request
      // #2 would re-read and pick up the second token. Asserting both
      // requests use the first token proves the cache survived the 500.
      const { post, captured } = yield* keychainClient(
        respondFirstWith({ status: 500, body: "server error" }, answerOk()),
        togglingCredsIO("first", "second"),
      )
      const r1 = yield* runOk(post())
      const r2 = yield* runOk(post())
      expect(captured).toHaveLength(2)
      expect(r1.status).toBe(500)
      expect(r2.status).toBe(200)
      // Both requests used the cached "first" token. If the 500 had
      // wrongly invalidated, request #2 would carry "second-access".
      expect(captured[0]!.headers["authorization"]).toBe("Bearer first-access")
      expect(captured[1]!.headers["authorization"]).toBe("Bearer first-access")
    }),
  )
})
describe("keychainTransformClient — credential failure through the SDK", () => {
  it.scopedLive(
    "a failed refresh runs once and reaches the caller as a non-retryable error with its reason",
    () =>
      Effect.gen(function* () {
        let refreshes = 0
        const creds = yield* credentialCache({
          read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
          refresh: () =>
            Effect.suspend(() => {
              refreshes++
              return Effect.fail(new ProviderAuthError({ message: "refresh token revoked" }))
            }),
        })
        const state = makeFakeFetchState()
        const clientLayer = AnthropicSdkClient.layer({
          transformClient: buildKeychainTransformClient(creds, TEST_ENV),
        }).pipe(Layer.provide(FetchHttpClient.layer))
        const modelLayer = AnthropicLanguageModel.layer({ model: "claude-opus-4-6" }).pipe(
          Layer.provide(clientLayer),
        )
        const exit = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
          Effect.provide(
            Layer.provideMerge(
              modelLayer,
              fakeFetchLayer(state, () => anthropicHappyResponse()),
            ),
          ),
          Effect.scoped,
          Effect.timeout("4 seconds"),
          Effect.exit,
        )
        expect(state.captured).toHaveLength(0)
        expect(refreshes).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) return
        const error = Cause.findErrorOption(exit.cause).pipe(Option.filter(AiError.isAiError))
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          // Core retries only a retryable AiError; a credential failure must not be one.
          expect(error.value.isRetryable).toBe(false)
          expect(error.value.message).toContain("refresh token revoked")
        }
      }),
  )
})

// ── credential cache ────────────────────────────────────────────────────────

/**
 * Anthropic credential cache — Effect-native, over `makeCredentialCache`.
 *
 * The service caches credentials in a `Ref` with TTL 30s + a 60s
 * freshness margin (refresh before the wire-side auth gate rejects).
 * This test drives the IO seam (`AnthropicCredentialIO`) deterministically
 * via `TestClock` so we can assert cache semantics without spawning
 * `security` or hitting the keychain.
 */
// ── Helpers ──
const makeCreds = (label: string, expiresAt: number): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt,
})
interface IOState {
  readResult: () => Effect.Effect<ClaudeCredentials, ProviderAuthError>
  refreshResult: () => Effect.Effect<ClaudeCredentials, CredentialFailure>
}
const makeIO = (state: IOState): AnthropicCredentialIO => ({
  read: Effect.suspend(() => state.readResult()),
  refresh: () => Effect.suspend(() => state.refreshResult()),
})
// TestClock starts at time 0, so all expiresAt values are absolute offsets.
const FAR_FUTURE = 10 * 60 * 1000 // expiresAt = 10 minutes from t=0
// `TestClock.adjust` requires a `Scope` (it manages internal sleeper
// fibers). Wrap with `Effect.scoped` so tests don't have to thread
// scope manually.
const runWithTestClock = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.scoped(eff).pipe(Effect.provide(TestClock.layer()))
// ── Tests ──
describe("Anthropic credential cache — cache hit/miss", () => {
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
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const first = yield* svc.getFresh
          callsRef.current = creds2
          yield* TestClock.adjust("31 seconds")
          const second = yield* svc.getFresh
          expect(first.accessToken).toBe("k1-access")
          expect(second.accessToken).toBe("k2-access")
        }),
      )
    }),
  )
})
describe("Anthropic credential cache — refresh on stale", () => {
  it.live("an unreachable token endpoint stays a failure that can pass", () =>
    Effect.gen(function* () {
      const stale = makeCreds("stale", 30000)
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () =>
          Effect.fail(new CredentialRefreshUnavailable({ message: "token endpoint 503" })),
      }
      const cache = credentialCache(makeIO(state))
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          return yield* Effect.flip(svc.getFresh)
        }),
      )
      expect(result._tag).toBe("CredentialRefreshUnavailable")
    }),
  )
})
describe("Anthropic credential cache — keychain miss falls through to refresh", () => {
  it.live("read fails → refresh succeeds → returns refreshed creds", () =>
    Effect.gen(function* () {
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        readResult: () => Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
        refreshResult: () => Effect.succeed(fresh),
      }
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const result = yield* svc.getFresh
          // Outcome: when read fails, the refresh path's creds reach the
          // caller. No internal call counters needed.
          expect(result.accessToken).toBe("fresh-access")
        }),
      )
    }),
  )
})

// ── oauth refresh ───────────────────────────────────────────────────────────

/**
 * Tests for the pure helpers backing Claude Code OAuth refresh +
 * keychain write-back. The HTTP path itself is exercised through the
 * Live integration (and gated by a real keychain entry); these tests
 * cover the deterministic transformations that decide whether a
 * refresh succeeds and what the keychain blob ends up containing, as
 * `griffinmartin/opencode-claude-auth`'s reference implementation does.
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

// ── request signing ─────────────────────────────────────────────────────────

/**
 * Tests for the Claude Code billing-header signing helpers — the
 * algorithm Anthropic's OAuth-billing validator checks against. A header
 * the validator rejects (such as a fixed `cch` placeholder) fails every
 * request, surfacing as `InvalidKey` from the SDK.
 */

// Each helper provides the host's crypto to the signing step it names.
const buildBillingHeaderValue = (
  messages: Parameters<typeof buildBillingHeaderValueEffect>[0],
  version: string,
  entrypoint: string,
) =>
  buildBillingHeaderValueEffect(messages, version, entrypoint).pipe(Effect.provide(BunCrypto.layer))

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

describe("buildBillingHeaderValue", () => {
  it.effect("signs the first user message: cch is the first 5 hex digits of its sha256", () =>
    Effect.gen(function* () {
      // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      const value = yield* buildBillingHeaderValue(
        [
          { role: "assistant", content: "preamble" },
          { role: "user", content: "hello" },
        ],
        "2.1.80",
        "cli",
      )
      expect(value).toBe(
        "x-anthropic-billing-header: cc_version=2.1.80.e14; cc_entrypoint=cli; cch=2cf24;",
      )
    }),
  )

  it.effect(
    "a message shorter than the sampled indices pads them, and the version is hashed in",
    () =>
      Effect.gen(function* () {
        const sign = (version: string) =>
          buildBillingHeaderValue([{ role: "user", content: "hi" }], version, "cli")
        expect(yield* sign("2.1.80")).toBe(
          "x-anthropic-billing-header: cc_version=2.1.80.7aa; cc_entrypoint=cli; cch=8f434;",
        )
        expect(yield* sign("2.1.81")).toBe(
          "x-anthropic-billing-header: cc_version=2.1.81.c43; cc_entrypoint=cli; cch=8f434;",
        )
      }),
  )

  it.effect("matches a fixed vector byte for byte", () =>
    Effect.gen(function* () {
      const value = yield* buildBillingHeaderValue(
        [{ role: "user", content: "Fix the flaky test in the billing module, please." }],
        "2.1.80",
        "cli",
      )
      expect(value).toBe(
        "x-anthropic-billing-header: cc_version=2.1.80.764; cc_entrypoint=cli; cch=cb258;",
      )
    }),
  )

  it.effect("uses the entrypoint verbatim", () =>
    Effect.gen(function* () {
      const value = yield* buildBillingHeaderValue(
        [{ role: "user", content: "hi" }],
        "2.1.80",
        "test-entry",
      )
      expect(value).toContain("cc_entrypoint=test-entry;")
    }),
  )
})

// ── model config ────────────────────────────────────────────────────────────

describe("getModelBetas", () => {
  test("a generic sonnet model sends the five betas Claude Code sends", () => {
    // Written out, not read from MODEL_CONFIG: a beta dropped from the table
    // must fail here.
    expect(getModelBetas("claude-sonnet-4-5", Option.none())).toEqual([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "prompt-caching-scope-2026-01-05",
      "context-management-2025-06-27",
    ])
  })

  test("no model gets the context-1m beta: a 1M window is the default", () => {
    for (const model of [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-sonnet-4-5-20250514",
      "claude-opus-4-20250514",
      "claude-sonnet-5",
      "sonnet",
    ]) {
      expect(getModelBetas(model, Option.none())).not.toContain("context-1m-2025-08-07")
    }
    // The 4-6 override still adds the effort beta.
    expect(getModelBetas("claude-opus-4-6", Option.none())).toContain("effort-2025-11-24")
  })

  test("haiku omits interleaved-thinking (excluded by override)", () => {
    const betas = getModelBetas("claude-haiku-4-5", Option.none())
    expect(betas).not.toContain("interleaved-thinking-2025-05-14")
    // baseBetas minus the excluded one.
    expect(betas).toContain("claude-code-20250219")
    expect(betas).toContain("oauth-2025-04-20")
  })

  test("4-7 models add the effort beta, and a model id matches in any case", () => {
    expect(getModelBetas("claude-opus-4-7", Option.none())).toContain("effort-2025-11-24")
    expect(getModelBetas("CLAUDE-HAIKU-4-5", Option.none())).not.toContain(
      "interleaved-thinking-2025-05-14",
    )
  })

  test("env override replaces the base list comma-split", () => {
    const betas = getModelBetas("claude-sonnet-4-5", Option.some("alpha,beta,gamma"))
    expect(betas).toEqual(["alpha", "beta", "gamma"])
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
})

// ── platform adapter ────────────────────────────────────────────────────────

/**
 * AnthropicPlatform.fromSetup invariant lock.
 *
 * `platform.home` must source from `host.homeDirectory` (the OS user home),
 * NOT `ctx.home` (the home gent runs with). The Claude Code credential
 * file is read from `~/.config/claude/.credentials.json` at the real OS
 * home whatever `ctx.home` is: reading it under `ctx.home` would break
 * Anthropic OAuth for a host whose `ctx.home` is not the OS home.
 */

type SetupFacts = Pick<ExtensionHostService, "host">

const makeCtxWithSplitHome = (gentHome: string, osHome: string): SetupFacts => {
  const facts = testHostFacts({ home: gentHome })
  return {
    host: { ...facts.host, homeDirectory: osHome },
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

// ── model driver ────────────────────────────────────────────────────────────

/**
 * AnthropicExtension model-driver wiring — extension-level coverage for
 * `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The leaf-service suites cover services in isolation. These tests pin two
 * wiring rules the leaf suites cannot see:
 *
 *   1. **Cache-Ref lifetime**: `resolveModel` runs once per model resolution,
 *      and every resolution reads the one `Ref<CredentialCacheCell>` the
 *      driver was built with. `makeOauthAnthropicLayer` must not allocate a
 *      cell of its own, or each request starts with an empty cache.
 *   2. **Only OAuth is wrapped in buildKeychainTransformClient**: it injects
 *      the Claude Code OAuth billing-header system blocks and the identity
 *      prefix. The API-key branch is the plain SDK.
 *
 * Each test drives one real `LanguageModel.generateText` call through the
 * resolved layer with a captured fake `fetch`, then asserts on the outbound
 * request shape: the production wiring uses the test-owned cell and applies
 * the keychain transforms only on the OAuth branch.
 */
const FUTURE_MS = 1_800_000_000_000
/** A stored sign-in the cache holds, written at `at`. */
const makeDurableCell = (
  creds: ClaudeCredentials,
  at: number,
): CredentialCacheCell<ClaudeCredentials> => ({ _tag: "Durable", creds, at, invalidated: false })
const testPlatform = AnthropicPlatform.of({
  platform: "darwin",
  home: "/nonexistent/gent-test-home",
  env: {},
})
/** The driver's services as setup captures them: the running platform, its crypto, and the Claude Code facts. */
const driverServices = (platform: typeof testPlatform) =>
  Effect.map(
    Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
    >(),
    Context.add(AnthropicPlatform, platform),
  )
type DriverArgs = Parameters<typeof buildAnthropicModelDriverLive>
/** The driver over the test platform; its markers ask for `promptCacheTtl`, 1 hour unless a test sets the switch. */
const buildAnthropicModelDriver = (
  credentialCellRef: DriverArgs[0],
  envApiKey: DriverArgs[1],
  promptCacheTtl: DriverArgs[3] = "1h",
) =>
  driverServices(testPlatform).pipe(
    Effect.map((services) =>
      buildAnthropicModelDriverLive(credentialCellRef, envApiKey, services, promptCacheTtl),
    ),
    Effect.provide(BunServices.layer),
  )
// The Claude Code path reads the keychain, never the gent store.
const makeOAuthInfo = (): ProviderAuthInfo =>
  ProviderAuthInfo.cases.Oauth.make({
    update: () => Effect.die(new Error("the Claude Code path never reads the gent store")),
  })
const makeApiAuthInfo = (key: string): ProviderAuthInfo => ProviderAuthInfo.cases.Api.make({ key })
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
/**
 * The last request `send` makes through `modelName`, resolved by a driver
 * that holds a fresh Claude Code sign-in and no ANTHROPIC_API_KEY.
 */
const sentThroughSignedInDriver = (
  modelName: string,
  authInfo: ProviderAuthInfo,
  hints: ProviderHints,
  send: (
    model: Layer.Layer<LanguageModel.LanguageModel>,
    state: FakeFetchState,
  ) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
      makeDurableCell(
        { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
        yield* Clock.currentTimeMillis,
      ),
    )
    const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
    // Core resolves over the catalog, with the driver's overrides applied.
    const model = yield* resolveShipped(
      driver,
      fixtureModelCatalog(),
      modelName,
      Option.some(authInfo),
      Option.some(hints),
    )
    const state = makeFakeFetchState()
    yield* send(model, state)
    return Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)))
  })

const ContextMode = Schema.Literals(["text", "object", "stream"])
/** A streamed reply that ends with `stopReason`, as the wire names it. */
const streamReplyEnding = (stopReason: string) => {
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
      delta: { stop_reason: stopReason, stop_sequence: externalWireNull },
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
const contextStreamResponse = () => streamReplyEnding("end_turn")

describe("Anthropic stop reason", () => {
  it.live("a reply the full window cut off reports its raw stop reason to the loop", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-sonnet-4-5", makeApiAuthInfo("test-key"))
      const state = makeFakeFetchState()
      const finishes: Array<string> = []
      const reported = yield* captureProviderStopReason(
        LanguageModel.streamText({ prompt: "hi" }).pipe(
          Stream.runForEach((part) =>
            Effect.sync(() => {
              if (part.type === "finish") finishes.push(part.reason)
            }),
          ),
          Effect.provide(
            Layer.provideMerge(
              model,
              fakeFetchLayer(state, () => streamReplyEnding("model_context_window_exceeded")),
            ),
          ),
          Effect.scoped,
        ),
      )
      // Effect AI's map lacks the reason, so the finish part alone cannot tell.
      expect(finishes).toEqual(["unknown"])
      expect(reported).toEqual(Option.some("model_context_window_exceeded"))
    }),
  )
})

describe("Anthropic lost connection", () => {
  it.live("a stream whose connection drops mid-reply fails as a retryable lost connection", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-sonnet-4-5", makeApiAuthInfo("test-key"))
      const reply = streamReplyEnding("end_turn")
      const firstEvent = `${reply.body.split("\n\n")[0] ?? ""}\n\n`
      // The server sends the first event, then the socket closes under the read.
      const dropped = () => ({
        ...reply,
        body: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode(firstEvent))
            controller.error("socket closed")
          },
        }),
      })
      const error = yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
        Stream.runDrain,
        Effect.provide(Layer.provideMerge(model, fakeFetchLayer(makeFakeFetchState(), dropped))),
        Effect.scoped,
        Effect.flip,
      )
      expect(error.reason).toMatchObject({
        _tag: "NetworkError",
        reason: "TransportError",
        description: "connection lost while reading the response",
      })
      expect(error.isRetryable).toBe(true)
      expect(error.message).toContain("connection lost while reading the response")
    }),
  )
})

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

/** A request body without its `cache_control` markers, which are not part of the cached bytes. */
const withoutCacheMarkers = (body: string) =>
  body
    .replaceAll(/"cache_control":(?:null|\{[^}]*\}),/g, "")
    .replaceAll(/,"cache_control":(?:null|\{[^}]*\})/g, "")

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
          >(
            makeDurableCell(
              { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
              yield* Clock.currentTimeMillis,
            ),
          )
          const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
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
            const next = Option.getOrThrow(Option.fromUndefinedOr(bodies[1]))
            const noInitial = Option.getOrThrow(Option.fromUndefinedOr(bodies[2]))
            // The tail marker moves forward each request; it is not part of the cached bytes.
            const unmarked = yield* Effect.forEach(state.captured, (request) =>
              Schema.decodeEffect(requestCodec)(
                withoutCacheMarkers(Option.getOrThrow(Option.fromUndefinedOr(request.body))),
              ),
            )
            const firstUnmarked = Option.getOrThrow(Option.fromUndefinedOr(unmarked[0]))
            const nextUnmarked = Option.getOrThrow(Option.fromUndefinedOr(unmarked[1]))
            expect(nextUnmarked.system).toEqual(firstUnmarked.system)
            expect(nextUnmarked.messages.slice(0, firstUnmarked.messages.length)).toEqual([
              ...firstUnmarked.messages,
            ])
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
/** Every `cache_control` marker in a request body, in prefix order (tools, system, messages) whatever the order of its keys. */
const cacheMarkers = (body: string): ReadonlyArray<string> => {
  const payload = Schema.decodeSync(Schema.fromJsonString(JsonRecordSchema))(body)
  const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
  return ["tools", "system", "messages"]
    .filter((key) => key in payload)
    .flatMap((key) =>
      Array.from(toJson(payload[key]).matchAll(/"cache_control":\{[^}]*\}/g), (match) => match[0]),
    )
}

describe("Anthropic prompt-cache lifetime", () => {
  const conversation = Prompt.make([
    { role: "system", content: "Stable initial instructions." },
    { role: "user", content: [{ type: "text", text: "Run a cell." }] },
  ])
  /** The markers of one rendered request on each sign-in path: an API key, then Claude Code. */
  const renderedMarkers = (
    promptCacheTtl: "5m" | "1h",
    prompt: Prompt.Prompt = conversation,
    hints: ProviderHints = { cacheKey: "session-cache-key" },
  ) =>
    Effect.gen(function* () {
      const perPath: Array<ReadonlyArray<string>> = []
      for (const authInfo of [makeApiAuthInfo("test-key"), makeOAuthInfo()]) {
        const credentialCellRef = yield* SynchronizedRef.make<
          CredentialCacheCell<ClaudeCredentials>
        >(
          makeDurableCell(
            { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
            yield* Clock.currentTimeMillis,
          ),
        )
        const driver = yield* buildAnthropicModelDriver(
          credentialCellRef,
          Option.none(),
          promptCacheTtl,
        )
        const model = yield* driver.resolveModel("claude-opus-4-6", authInfo, hints)
        const state = makeFakeFetchState()
        yield* runContextRequest(model, state, prompt, "text")
        perPath.push(
          cacheMarkers(Option.getOrThrow(Option.fromUndefinedOr(state.captured[0]?.body))),
        )
      }
      return perPath
    })

  it.live(
    "a marker a message already carries takes the request's one lifetime, on both sign-in paths",
    () =>
      Effect.gen(function* () {
        // The SDK renders a message's `cacheControl` option as a 5-minute
        // marker; a 1-hour marker after it would break the ordering rule.
        const marked = Prompt.fromMessages([
          Prompt.makeMessage("system", { content: "Stable initial instructions." }),
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: "Run a cell." })],
            options: { anthropic: { cacheControl: { type: "ephemeral" } } },
          }),
          Prompt.makeMessage("assistant", {
            content: [Prompt.makePart("text", { text: "It ran." })],
          }),
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: "Run it again." })],
          }),
        ])
        for (const markers of yield* renderedMarkers("1h", marked)) {
          expect(markers.length).toBeGreaterThanOrEqual(3)
          for (const marker of markers) {
            expect(marker).toBe('"cache_control":{"type":"ephemeral","ttl":"1h"}')
          }
        }
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.live(
    "a child's markers ask for 5 minutes, its shared part 1 hour; a root's ask for 1 hour; the 5-minute switch sets every marker",
    () =>
      Effect.gen(function* () {
        const sharedPart = `# Shared\n\n${"Instructions every agent reads. ".repeat(160)}`
        const sharedPrompt = Prompt.fromMessages([
          Prompt.makeMessage("system", { content: sharedPart }),
          Prompt.makeMessage("system", { content: "# Children\n\n- Delegate independent work." }),
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: "Run a cell." })],
          }),
        ])
        const hour = '"cache_control":{"type":"ephemeral","ttl":"1h"}'
        const minutes = '"cache_control":{"type":"ephemeral","ttl":"5m"}'
        const [childApiKey, childClaudeCode] = yield* renderedMarkers("1h", sharedPrompt, {
          cacheKey: "child-session",
          child: true,
        })
        // A fresh child still reads the shared part its parent wrote, on both
        // sign-in paths; the longer lifetime renders first, as the ordering rule asks.
        expect(childApiKey).toEqual([hour, minutes, minutes])
        expect(childClaudeCode).toEqual([hour, minutes, minutes])
        for (const markers of yield* renderedMarkers("1h", sharedPrompt)) {
          expect(markers.length).toBeGreaterThanOrEqual(2)
          for (const marker of markers) expect(marker).toBe(hour)
        }
        // The 5-minute switch sets every marker of a root and of a child,
        // a child's shared part too.
        for (const hints of [
          { cacheKey: "session-cache-key" },
          { cacheKey: "child-session", child: true },
        ]) {
          for (const markers of yield* renderedMarkers("5m", sharedPrompt, hints)) {
            expect(markers.length).toBeGreaterThanOrEqual(2)
            for (const marker of markers) expect(marker).toBe(minutes)
          }
        }
      }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("a request with no cache key writes no cache, on both sign-in paths", () =>
    Effect.gen(function* () {
      // A one-off request, such as a compaction summary, has no later request
      // to read its entry back.
      for (const markers of yield* renderedMarkers("1h", conversation, {})) {
        expect(markers).toEqual([])
      }
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.live("ANTHROPIC_PROMPT_CACHE_TTL=5m sets the switch; unset or unknown keeps 1 hour", () =>
    Effect.gen(function* () {
      const read = (env: Record<string, string>) =>
        readPromptCacheTtl.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        )
      expect(yield* read({ ANTHROPIC_PROMPT_CACHE_TTL: "5m" })).toBe("5m")
      expect(yield* read({ ANTHROPIC_PROMPT_CACHE_TTL: "1h" })).toBe("1h")
      expect(yield* read({})).toBe("1h")
      expect(yield* read({ ANTHROPIC_PROMPT_CACHE_TTL: "10m" })).toBe("1h")
    }).pipe(Effect.timeout("5 seconds")),
  )
})

const JsonRecordSchemaDriver = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type JsonRecordDriver = Schema.Schema.Type<typeof JsonRecordSchemaDriver>
const parsePayload = (body: string): JsonRecordDriver =>
  Schema.decodeSync(JsonRecordSchemaDriver)(body)
describe("buildAnthropicModelDriver — OAuth path uses the external credential cell", () => {
  it.live(
    "OAuth resolveModel layer applies buildKeychainTransformClient transforms (system identity prefix)",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell(
            { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
            yield* Clock.currentTimeMillis,
          ),
        )
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
        const model = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const payload = parsePayload(
          Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)!.body)),
        )
        // buildKeychainTransformClient injects the SYSTEM_IDENTITY_PREFIX block. If the
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
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell(
            { accessToken: "first-token", refreshToken: "r", expiresAt: FUTURE_MS },
            yield* Clock.currentTimeMillis,
          ),
        )
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
        const model1 = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState1 = makeFakeFetchState()
        // The first request sends the sign-in the test-owned cell holds, not
        // one read from the keychain.
        yield* runOne(model1, fetchState1)
        expect(fetchState1.captured.at(-1)!.headers["authorization"]).toBe("Bearer first-token")
        // Every `resolveModel` reads the one cell the driver was built with,
        // so the second request sends the token the test writes between calls.
        yield* SynchronizedRef.set(
          credentialCellRef,
          makeDurableCell(
            { accessToken: "second-token", refreshToken: "r", expiresAt: FUTURE_MS },
            yield* Clock.currentTimeMillis,
          ),
        )
        const model2 = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
        const fetchState2 = makeFakeFetchState()
        yield* runOne(model2, fetchState2)
        expect(fetchState2.captured.at(-1)!.headers["authorization"]).toBe("Bearer second-token")
      }),
  )
})
describe("buildAnthropicModelDriver — the host's platform", () => {
  it.live("the Claude Code sign-in is read through the host's file system", () =>
    Effect.gen(function* () {
      // The file exists only in the host's file system, never on disk.
      const home = "/nonexistent/gent-probe-anthropic"
      const file = `${home}/.claude/.credentials.json`
      const disk = yield* FileSystem.FileSystem
      const hostFs: FileSystem.FileSystem = {
        ...disk,
        exists: (path) => {
          if (path === file) return Effect.succeed(true)
          return disk.exists(path)
        },
        readFileString: (path, encoding) => {
          if (path !== file) return disk.readFileString(path, encoding)
          return Effect.succeed(
            encodeExternalJson({
              claudeAiOauth: {
                accessToken: "host-access",
                refreshToken: "host-refresh",
                expiresAt: FUTURE_MS,
              },
            }),
          )
        },
      }
      const services = Context.add(
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        FileSystem.FileSystem,
        hostFs,
      )
      const driver = buildAnthropicModelDriverLive(
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL),
        Option.none(),
        services,
        "1h",
      )
      const fetchState = makeFakeFetchState()
      const model = yield* driver
        .resolveModel("claude-opus-4-6", makeOAuthInfo())
        .pipe(Effect.provide(fakeFetchLayer(fetchState, () => anthropicHappyResponse())))
      yield* runOne(model, fetchState)
      expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer host-access")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})
describe("buildAnthropicModelDriver — refresh token order", () => {
  it.live("refresh tries the keychain token first, then the held token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, ".claude"))
      // The keychain (the credentials file off darwin) holds an expired token
      // that the `claude` CLI rotated; the cache holds an older one.
      yield* fs.writeFileString(
        path.join(home, ".claude", ".credentials.json"),
        encodeExternalJson({
          claudeAiOauth: {
            accessToken: "keychain-access",
            refreshToken: "keychain-refresh",
            expiresAt: 0,
          },
        }),
      )
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      yield* SynchronizedRef.set(
        credentialCellRef,
        makeDurableCell(
          { accessToken: "held-access", refreshToken: "held-refresh", expiresAt: 0 },
          0,
        ),
      )
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        "1h",
      )
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
        if ((request.body ?? "").includes("refresh_token=held-refresh")) {
          return {
            status: 200,
            body: encodeExternalJson({
              access_token: "held-new-access",
              refresh_token: "held-new-refresh",
              expires_in: 3600,
            }),
          }
        }
        return { status: 400, body: '{"error":"invalid_grant"}' }
      })
      const model = yield* driver
        .resolveModel("claude-opus-4-6", makeOAuthInfo())
        .pipe(Effect.provide(fetchLayer))
      yield* runOne(model, fetchState)

      const refreshTokens = fetchState.captured
        .filter((request) => request.url.endsWith("/v1/oauth/token"))
        .map((request) => /refresh_token=([^&]*)/.exec(request.body ?? "")?.[1])
      expect(refreshTokens).toEqual(["keychain-refresh", "held-refresh"])
      expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer held-new-access")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
describe("buildAnthropicModelDriver — refresh writes only the keychain", () => {
  for (const stallsAt of ["read", "sync"] as const) {
    it.live(
      `a stalled credential-file ${stallsAt} releases the refresh and retains its rotation`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const home = yield* fs.makeTempDirectoryScoped()
          const credentialsFile = path.join(home, ".claude", ".credentials.json")
          yield* fs.makeDirectory(path.join(home, ".claude"))
          yield* fs.writeFileString(
            credentialsFile,
            encodeExternalJson({
              claudeAiOauth: {
                accessToken: "old-access",
                refreshToken: "old-refresh",
                expiresAt: 0,
              },
            }),
          )
          const stalled = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const expired = yield* Deferred.make<void>()
          const hang = Deferred.succeed(stalled, void 0).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "TimedOut",
                  module: "FileSystem",
                  method: "test-stall",
                }),
              ),
            ),
            Effect.onInterrupt(() => Deferred.succeed(expired, void 0)),
          )
          let reads = 0
          const hostFs: FileSystem.FileSystem = {
            ...fs,
            readFileString: (file, encoding) => {
              if (file === credentialsFile && ++reads === 2 && stallsAt === "read") return hang
              return fs.readFileString(file, encoding)
            },
            open: (file, options) =>
              fs.open(file, options).pipe(
                Effect.map((opened): FileSystem.File => ({
                  [FileSystem.FileTypeId]: FileSystem.FileTypeId,
                  stat: opened.stat,
                  seek: (offset, from) => opened.seek(offset, from),
                  sync: Effect.suspend(() => {
                    if (stallsAt === "sync") return hang
                    return opened.sync
                  }),
                  read: (buffer) => opened.read(buffer),
                  readAlloc: (size) => opened.readAlloc(size),
                  truncate: (length) => opened.truncate(length),
                  write: (buffer) => opened.write(buffer),
                  writeAll: (buffer) => opened.writeAll(buffer),
                })),
              ),
          }
          const cellRef = yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
            makeDurableCell(
              { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
              0,
            ),
          )
          const driver = buildAnthropicModelDriverLive(
            cellRef,
            Option.none(),
            Context.add(
              yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
              FileSystem.FileSystem,
              hostFs,
            ),
            "1h",
          )
          const fetchState = makeFakeFetchState()
          const fetchLayer = fakeFetchLayer(fetchState, () => ({
            status: 200,
            body: encodeExternalJson({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
          }))
          yield* Effect.gen(function* () {
            const resolving = yield* Effect.forkChild(
              driver
                .resolveModel("claude-opus-4-6", makeOAuthInfo())
                .pipe(Effect.provide(fetchLayer)),
            )
            yield* Deferred.await(stalled)
            yield* TestClock.adjust("6 seconds")
            const stoppedAtDeadline = yield* Deferred.isDone(expired)
            // Release the fake even on broken code, so the red proof closes its files.
            yield* Deferred.succeed(release, void 0)
            yield* Fiber.join(resolving)
            expect(stoppedAtDeadline).toBe(true)
            const cell = yield* SynchronizedRef.get(cellRef)
            expect(cell._tag).toBe("Durable")
            if (cell._tag !== "Empty") expect(cell.creds.refreshToken).toBe("new-refresh")
            expect(
              fetchState.captured.filter((request) => request.url.endsWith("/v1/oauth/token")),
            ).toHaveLength(1)
          }).pipe(Effect.provide(TestClock.layer()))
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("3 seconds")),
      5000,
    )
  }
  it.live("a refresh serves the request and never writes the gent auth store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, ".claude"))
      yield* fs.writeFileString(
        path.join(home, ".claude", ".credentials.json"),
        encodeExternalJson({
          claudeAiOauth: {
            accessToken: "keychain-access",
            refreshToken: "keychain-refresh",
            expiresAt: 0,
          },
        }),
      )
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        "1h",
      )
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
        return {
          status: 200,
          body: encodeExternalJson({
            access_token: "refreshed-access",
            refresh_token: "refreshed-refresh",
            expires_in: 3600,
          }),
        }
      })
      // Nothing reads the stored Claude Code tokens: a store that cannot be
      // written must not fail a refresh that worked.
      let storeWrites = 0
      const authInfo = ProviderAuthInfo.cases.Oauth.make({
        update: () =>
          Effect.suspend(() => {
            storeWrites += 1
            return Effect.die(new Error("auth store unavailable"))
          }),
      })
      const model = yield* driver
        .resolveModel("claude-opus-4-6", authInfo)
        .pipe(Effect.provide(fetchLayer))
      yield* runOne(model, fetchState)

      expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer refreshed-access")
      expect(storeWrites).toBe(0)
      const keychain = yield* fs.readFileString(path.join(home, ".claude", ".credentials.json"))
      expect(keychain).toContain("refreshed-refresh")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
  it.live(
    "a refresh replaces the credentials file whole, owner-only, with no staging file left",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const claudeDir = path.join(home, ".claude")
        yield* fs.makeDirectory(claudeDir)
        const credentialsFile = path.join(claudeDir, ".credentials.json")
        yield* fs.writeFileString(
          credentialsFile,
          encodeExternalJson({
            claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
          }),
          { mode: 0o644 },
        )
        const before = yield* fs.stat(credentialsFile)
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = buildAnthropicModelDriverLive(
          credentialCellRef,
          Option.none(),
          yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
          "1h",
        )
        const fetchState = makeFakeFetchState()
        const fetchLayer = fakeFetchLayer(fetchState, (request) => {
          if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
          return {
            status: 200,
            body: encodeExternalJson({
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
              expires_in: 3600,
            }),
          }
        })
        const authInfo = ProviderAuthInfo.cases.Oauth.make({
          update: () => Effect.die(new Error("the Claude Code path never writes the gent store")),
        })
        const model = yield* driver
          .resolveModel("claude-opus-4-6", authInfo)
          .pipe(Effect.provide(fetchLayer))
        yield* runOne(model, fetchState)

        const after = yield* fs.stat(credentialsFile)
        // A new inode: the refresh renamed a staged file over the old one, so a
        // concurrent reader (the claude CLI) never sees a half-written file.
        expect(after.ino).not.toEqual(before.ino)
        expect(after.mode & 0o777).toBe(0o600)
        expect(yield* fs.readDirectory(claudeDir)).toEqual([".credentials.json"])
        expect(yield* fs.readFileString(credentialsFile)).toContain("refreshed-refresh")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
  it.live("a sign-in stopped after the token endpoint rotated the token still writes it back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const credentialsFile = path.join(home, ".claude", ".credentials.json")
      yield* fs.makeDirectory(path.join(home, ".claude"))
      yield* fs.writeFileString(
        credentialsFile,
        encodeExternalJson({
          claudeAiOauth: {
            accessToken: "keychain-access",
            refreshToken: "keychain-refresh",
            expiresAt: 0,
          },
        }),
      )
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        "1h",
      )
      const rotated = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<void>()
      // The endpoint spends the token it is sent; its answer is on the way back.
      const fetchLayer = fakeFetchLayer(makeFakeFetchState(), () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(rotated, void 0)
          yield* Deferred.await(answered)
          return {
            status: 200,
            body: encodeExternalJson({
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
              expires_in: 3600,
            }),
          }
        }),
      )
      const authorize = Option.fromUndefinedOr(driver.auth?.authorize)
      if (Option.isNone(authorize)) return yield* Effect.die(new Error("no authorize"))
      const signIn = authorize.value({
        sessionId: SessionId.make("session-sign-in"),
        methodIndex: 0,
        authorizationId: "sign-in",
        persist: () => Effect.void,
      })
      const first = yield* Effect.forkChild(signIn.pipe(Effect.provide(fetchLayer)))
      yield* Deferred.await(rotated)
      // Stop the sign-in while the rotated token is in flight.
      const stopping = yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true })
      yield* Deferred.succeed(answered, void 0)
      yield* Fiber.join(stopping)

      expect(yield* fs.readFileString(credentialsFile)).toContain("refreshed-refresh")
    }).pipe(Effect.timeout("5 seconds"), Effect.scoped, Effect.provide(BunServices.layer)),
  )
  for (const persistFails of [false, true]) {
    let name = "a stopped sign-in retains its rotation when write-back fails"
    if (persistFails) name += " and auth persistence fails"
    it.live(name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const credentialsFile = path.join(home, ".claude", ".credentials.json")
        yield* fs.makeDirectory(path.join(home, ".claude"))
        yield* fs.writeFileString(
          credentialsFile,
          encodeExternalJson({
            claudeAiOauth: {
              accessToken: "old-access",
              refreshToken: "old-refresh",
              expiresAt: 0,
            },
          }),
        )
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const services = Context.add(
          yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
          FileSystem.FileSystem,
          {
            ...fs,
            rename: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              ),
          },
        )
        const driver = buildAnthropicModelDriverLive(
          credentialCellRef,
          Option.none(),
          services,
          "1h",
        )
        const rotated = yield* Deferred.make<void>()
        const answered = yield* Deferred.make<void>()
        const fetchState = makeFakeFetchState()
        const fetchLayer = fakeFetchLayer(fetchState, (request) => {
          if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
          return Effect.gen(function* () {
            yield* Deferred.succeed(rotated, void 0)
            yield* Deferred.await(answered)
            return {
              status: 200,
              body: encodeExternalJson({
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 3600,
              }),
            }
          })
        })
        const authorize = Option.fromUndefinedOr(driver.auth?.authorize)
        if (Option.isNone(authorize)) return yield* Effect.die(new Error("no authorize"))
        const persisted: Array<string> = []
        const first = yield* Effect.forkChild(
          authorize
            .value({
              sessionId: SessionId.make("session-sign-in"),
              methodIndex: 0,
              authorizationId: "sign-in",
              persist: (credential) =>
                Effect.gen(function* () {
                  if (credential.type === "oauth") persisted.push(credential.refresh)
                  if (persistFails)
                    return yield* new ProviderAuthError({ message: "auth store unavailable" })
                }),
            })
            .pipe(Effect.provide(fetchLayer)),
        )
        yield* Deferred.await(rotated)
        const stopping = yield* Effect.forkChild(Fiber.interrupt(first), {
          startImmediately: true,
        })
        yield* Deferred.succeed(answered, void 0)
        yield* Fiber.join(stopping)
        expect(persisted).toEqual(["new-refresh"])
        const cell = yield* SynchronizedRef.get(credentialCellRef)
        expect(cell._tag).toBe("Durable")
        if (cell._tag !== "Empty") expect(cell.creds.refreshToken).toBe("new-refresh")
        expect(yield* fs.readFileString(credentialsFile)).toContain("old-refresh")
        const model = yield* driver
          .resolveModel("claude-opus-4-6", makeOAuthInfo())
          .pipe(Effect.provide(fetchLayer))
        yield* runOne(model, fetchState)
        expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer new-access")
        expect(
          fetchState.captured.filter((request) => request.url.endsWith("/v1/oauth/token")),
        ).toHaveLength(1)
      }).pipe(Effect.timeout("5 seconds"), Effect.scoped, Effect.provide(BunServices.layer)),
    )
  }
  it.live("a sign-in written during the refresh survives, and the request uses it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, ".claude"))
      const credentialsFile = path.join(home, ".claude", ".credentials.json")
      yield* fs.writeFileString(
        credentialsFile,
        encodeExternalJson({
          claudeAiOauth: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 0 },
        }),
      )
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        "1h",
      )
      const newerSignIn = encodeExternalJson({
        claudeAiOauth: {
          accessToken: "signed-in-access",
          refreshToken: "signed-in-refresh",
          expiresAt: FUTURE_MS,
        },
      })
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
        // The user signs in again (`claude` writes the keychain) while the
        // refresh of the old token is in flight: the token POST answers only
        // after the new sign-in is on disk.
        return fs.writeFileString(credentialsFile, newerSignIn).pipe(
          Effect.orDie,
          Effect.as({
            status: 200,
            body: encodeExternalJson({
              access_token: "refreshed-access",
              refresh_token: "refreshed-refresh",
              expires_in: 3600,
            }),
          }),
        )
      })
      const model = yield* driver
        .resolveModel("claude-opus-4-6", makeOAuthInfo())
        .pipe(Effect.provide(fetchLayer))
      yield* runOne(model, fetchState)

      expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer signed-in-access")
      const keychain = yield* fs.readFileString(credentialsFile)
      expect(keychain).toContain("signed-in-refresh")
      expect(keychain).not.toContain("refreshed-refresh")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
  it.live("a sign-in to the held account during the stored account's refresh survives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(home, ".claude"))
      const credentialsFile = path.join(home, ".claude", ".credentials.json")
      // The cache holds account B; the store read finds account A, whose
      // refresh token is sent first.
      const accountB = { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 0 }
      yield* fs.writeFileString(
        credentialsFile,
        encodeExternalJson({
          claudeAiOauth: { accessToken: "a-access", refreshToken: "a-refresh", expiresAt: 0 },
        }),
      )
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      yield* SynchronizedRef.set(credentialCellRef, makeDurableCell(accountB, 0))
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        "1h",
      )
      const fetchState = makeFakeFetchState()
      const fetchLayer = fakeFetchLayer(fetchState, (request) => {
        if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
        if (!(request.body ?? "").includes("refresh_token=a-refresh")) {
          return { status: 400, body: '{"error":"invalid_grant"}' }
        }
        // The user signs in to B while A's refresh is in flight: the store
        // now equals the held credential, and A's refresh answers after.
        return fs
          .writeFileString(credentialsFile, encodeExternalJson({ claudeAiOauth: accountB }))
          .pipe(
            Effect.orDie,
            Effect.as({
              status: 200,
              body: encodeExternalJson({
                access_token: "a-new-access",
                refresh_token: "a-new-refresh",
                expires_in: 3600,
              }),
            }),
          )
      })
      // B is stored expired, so resolving it fails; the store is the subject.
      const resolved = yield* Effect.exit(
        driver.resolveModel("claude-opus-4-6", makeOAuthInfo()).pipe(Effect.provide(fetchLayer)),
      )
      expect(Exit.isFailure(resolved)).toBe(true)

      const stored = yield* fs.readFileString(credentialsFile)
      expect(stored).toContain("b-refresh")
      expect(stored).not.toContain("a-new-refresh")
      expect(
        fetchState.captured.some(
          (request) => request.headers["authorization"] === "Bearer a-new-access",
        ),
      ).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
  it.live(
    "a store that could not be read before the refresh and holds the held credential after it takes the refresh",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        yield* fs.makeDirectory(path.join(home, ".claude"))
        const credentialsFile = path.join(home, ".claude", ".credentials.json")
        // The first read fails (a locked Keychain off darwin is an unreadable
        // file), so the refresh runs on the held token.
        yield* fs.writeFileString(credentialsFile, "{not json")
        const heldCreds = { accessToken: "held-access", refreshToken: "held-refresh", expiresAt: 0 }
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        yield* SynchronizedRef.set(credentialCellRef, makeDurableCell(heldCreds, 0))
        const driver = buildAnthropicModelDriverLive(
          credentialCellRef,
          Option.none(),
          yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
          "1h",
        )
        const fetchState = makeFakeFetchState()
        const fetchLayer = fakeFetchLayer(fetchState, (request) => {
          if (!request.url.endsWith("/v1/oauth/token")) return anthropicHappyResponse()
          // The store reads again by the write-back, and holds the credential
          // this refresh started from: its refresh token was just consumed.
          return fs
            .writeFileString(credentialsFile, encodeExternalJson({ claudeAiOauth: heldCreds }))
            .pipe(
              Effect.orDie,
              Effect.as({
                status: 200,
                body: encodeExternalJson({
                  access_token: "refreshed-access",
                  refresh_token: "refreshed-refresh",
                  expires_in: 3600,
                }),
              }),
            )
        })
        const model = yield* driver
          .resolveModel("claude-opus-4-6", makeOAuthInfo())
          .pipe(Effect.provide(fetchLayer))
        yield* runOne(model, fetchState)

        expect(fetchState.captured.at(-1)?.headers["authorization"]).toBe("Bearer refreshed-access")
        const stored = yield* fs.readFileString(credentialsFile)
        expect(stored).toContain("refreshed-refresh")
        expect(stored).not.toContain("held-refresh")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  )
})
describe("buildAnthropicModelDriver — credential order", () => {
  it.live("a stored Claude Code sign-in beats ANTHROPIC_API_KEY", () =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
        makeDurableCell(
          { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
          yield* Clock.currentTimeMillis,
        ),
      )
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.some("sk-env-key"))
      const model = yield* driver.resolveModel("claude-opus-4-6", makeOAuthInfo())
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const headers = fetchState.captured.at(-1)!.headers
      expect(headers["authorization"]).toBe("Bearer sign-in-token")
      expect(headers["x-api-key"]).toBeUndefined()
    }),
  )
  it.live("a stored API key beats ANTHROPIC_API_KEY", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.some("sk-env-key"))
      const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-stored"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const headers = fetchState.captured.at(-1)!.headers
      expect(headers["x-api-key"]).toBe("sk-stored")
      expect(headers["authorization"]).toBeUndefined()
    }),
  )
  it.live("ANTHROPIC_API_KEY applies when nothing is stored", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.some("sk-env-key"))
      const model = yield* driver.resolveModel("claude-opus-4-6")
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(fetchState.captured.at(-1)!.headers["x-api-key"]).toBe("sk-env-key")
    }),
  )
})
describe("buildAnthropicModelDriver — reasoning effort and thinking", () => {
  const SentReasoning = Schema.fromJsonString(
    Schema.Struct({
      output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
      thinking: Schema.optional(
        Schema.Struct({ type: Schema.String, display: Schema.optional(Schema.String) }),
      ),
      temperature: Schema.optional(Schema.Finite),
    }),
  )
  const sentRequest = (
    modelName: string,
    authInfo: ProviderAuthInfo,
    hints: ProviderHints = { reasoning: "high" },
  ) =>
    Effect.gen(function* () {
      const request = yield* sentThroughSignedInDriver(modelName, authInfo, hints, runOne)
      return yield* Schema.decodeEffect(SentReasoning)(request.body ?? "{}")
    })
  /** The same request on both auth paths; the two must agree. */
  const sentOnBothPaths = (modelName: string, hints?: ProviderHints) =>
    Effect.gen(function* () {
      const api = yield* sentRequest(modelName, makeApiAuthInfo("sk-test"), hints)
      const oauth = yield* sentRequest(modelName, makeOAuthInfo(), hints)
      expect(oauth).toEqual(api)
      return api
    })
  const sentFor = (modelName: string, reasoning: ProviderHints["reasoning"] = "high") =>
    Effect.map(sentOnBothPaths(modelName, { reasoning }), (sent) => sent.output_config)

  // Anthropic answers 400 when a model outside its effort table gets one. The
  // catalog names a thinking budget for these models, so a hint thinks on one.
  it.live(
    "a model that takes no effort gets none, and thinks on a budget, on either auth path",
    () =>
      Effect.gen(function* () {
        for (const model of [
          "claude-haiku-4-5",
          "claude-sonnet-4-5",
          "claude-sonnet-4-5-20250929",
        ]) {
          expect(yield* sentOnBothPaths(model, { reasoning: "high" })).toEqual({
            thinking: { type: "enabled" },
          })
        }
      }),
  )

  // models.dev does not list Mythos under Anthropic: the request names no
  // effort, and the family's thinking stays on.
  it.live("a model the catalog does not list gets its family's thinking and no effort", () =>
    Effect.gen(function* () {
      for (const reasoning of ["none", "high"] as const) {
        expect(yield* sentOnBothPaths("claude-mythos-5", { reasoning })).toEqual({
          thinking: { type: "adaptive", display: "summarized" },
        })
      }
    }),
  )

  it.live("a model that takes effort gets it on either auth path", () =>
    Effect.gen(function* () {
      for (const model of [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-opus-4-5-20251101",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "claude-fable-5-1",
      ]) {
        expect(yield* sentFor(model)).toEqual({ effort: "high" })
      }
    }),
  )

  it.live("a hint maps onto the levels the model accepts", () =>
    Effect.gen(function* () {
      expect(yield* sentFor("claude-opus-4-5", "max")).toEqual({ effort: "high" })
      expect(yield* sentFor("claude-sonnet-4-6", "minimal")).toEqual({ effort: "low" })
      expect(yield* sentFor("claude-sonnet-4-6", "medium")).toEqual({ effort: "medium" })
      expect(yield* sentFor("claude-sonnet-4-6", "none")).toBeUndefined()
      // The effort page lists `xhigh` for these; the 4.6 models do not take it.
      for (const model of [
        "claude-sonnet-5",
        "claude-opus-5-5",
        "claude-opus-4-7",
        "claude-fable-5-1",
      ]) {
        expect(yield* sentFor(model, "xhigh")).toEqual({ effort: "xhigh" })
      }
      expect(yield* sentFor("claude-sonnet-4-6", "xhigh")).toEqual({ effort: "max" })
    }),
  )

  // The main agent runs at max; the effort page lists `max` for every model below.
  it.live("a max hint sends max on either auth path", () =>
    Effect.gen(function* () {
      for (const model of [
        "claude-sonnet-5",
        "claude-opus-5-5",
        "claude-opus-4-8",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-fable-5-1",
      ]) {
        expect(yield* sentFor(model, "max")).toEqual({ effort: "max" })
      }
    }),
  )

  // Opus 4.6-4.8 and Sonnet 4.6 leave thinking off unless the request turns it on.
  it.live("a reasoning hint turns adaptive thinking on for a model that defaults to off", () =>
    Effect.gen(function* () {
      for (const model of [
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
      ]) {
        expect((yield* sentOnBothPaths(model, { reasoning: "high" })).thinking).toEqual({
          type: "adaptive",
          display: "summarized",
        })
      }
      // Extended-thinking-only models reject adaptive thinking with a 400: they
      // think on a budget. Opus 4.5's effort alone does not turn thinking on,
      // so it gets the budget beside the effort.
      for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"]) {
        expect((yield* sentOnBothPaths(model, { reasoning: "high" })).thinking).toEqual({
          type: "enabled",
        })
      }
    }),
  )

  // These families default to `display: "omitted"`: thinking blocks stream with
  // empty text unless the request asks for the summary.
  it.live("a model that thinks gets the thinking summary on either auth path", () =>
    Effect.gen(function* () {
      const summarized = { type: "adaptive", display: "summarized" }
      // Thinking on by default: with a hint and without one.
      for (const model of [
        "claude-sonnet-5",
        "claude-sonnet-5-5",
        "claude-opus-5",
        "claude-opus-5-5",
        "claude-fable-5-1",
        "claude-mythos-5",
      ]) {
        expect((yield* sentOnBothPaths(model, { reasoning: "max" })).thinking).toEqual(summarized)
        expect((yield* sentOnBothPaths(model, {})).thinking).toEqual(summarized)
      }
      // Thinking off by default: only a hint turns it on.
      for (const model of ["claude-opus-4-8", "claude-opus-4-7"]) {
        expect((yield* sentOnBothPaths(model, { reasoning: "max" })).thinking).toEqual(summarized)
        expect((yield* sentOnBothPaths(model, {})).thinking).toBeUndefined()
      }
    }),
  )

  // The compaction summary asks for no reasoning under a 768-token cap; thinking
  // counts toward max_tokens, so a thinking summary comes back cut or empty.
  it.live("a none hint asks for as little reasoning as the model allows", () =>
    Effect.gen(function* () {
      const none: ProviderHints = { reasoning: "none", maxTokens: 768 }
      // Thinking on by default, and it can be turned off.
      for (const model of ["claude-sonnet-5", "claude-opus-5"]) {
        expect(yield* sentOnBothPaths(model, none)).toEqual({ thinking: { type: "disabled" } })
      }
      // Sonnet 5.5 turns its up-front thinking off with `between_tools`, not
      // `disabled`, and takes it at effort low to high only: the lowest effort
      // goes beside it.
      expect(yield* sentOnBothPaths("claude-sonnet-5-5", none)).toEqual({
        output_config: { effort: "low" },
        thinking: { type: "between_tools" },
      })
      // Thinking cannot be turned off: the lowest effort instead, with the
      // thinking every other level sends, so the change is an effort change.
      for (const model of ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]) {
        expect(yield* sentOnBothPaths(model, none)).toEqual({
          output_config: { effort: "low" },
          thinking: { type: "adaptive", display: "summarized" },
        })
      }
      // Thinking already off by default: nothing to send.
      for (const model of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
        expect(yield* sentOnBothPaths(model, none)).toEqual({})
      }
    }),
  )

  // Newer models answer 400 to any non-default temperature; the 4.6 models only while thinking.
  it.live("temperature goes only to a model that takes it", () =>
    Effect.gen(function* () {
      const temperature = (model: string, hints: ProviderHints) =>
        Effect.map(
          sentOnBothPaths(model, { ...hints, temperature: 0.2 }),
          (sent) => sent.temperature,
        )
      for (const model of ["claude-sonnet-5", "claude-opus-4-8", "claude-opus-5-5"]) {
        expect(yield* temperature(model, {})).toBeUndefined()
      }
      expect(yield* temperature("claude-sonnet-4-6", { reasoning: "high" })).toBeUndefined()
      expect(yield* temperature("claude-sonnet-4-6", {})).toBe(0.2)
      expect(yield* temperature("claude-sonnet-4-6", { reasoning: "none" })).toBe(0.2)
      // A budget-thinking request takes no temperature either.
      expect(yield* temperature("claude-haiku-4-5", {})).toBe(0.2)
      expect(yield* temperature("claude-haiku-4-5", { reasoning: "high" })).toBeUndefined()
    }),
  )
})
const CacheBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  cache_control: Schema.optional(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
})
type CacheBlock = typeof CacheBlock.Type
const CachedRequest = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.optional(Schema.Array(CacheBlock)),
    system: Schema.optional(Schema.Array(CacheBlock)),
    messages: Schema.Array(
      Schema.Struct({ role: Schema.String, content: Schema.Array(CacheBlock) }),
    ),
  }),
)
/** A request's top-level effort and each message's role and effort marker. */
const EffortRequest = Schema.fromJsonString(
  Schema.Struct({
    output_config: Schema.Struct({ effort: Schema.String }),
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.Array(Schema.Unknown),
        output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
      }),
    ),
  }),
)
const ReadTool = Tool.make("read", {
  description: "Read a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
})
/**
 * One request with a tool list and a tool round trip; `options` go on each
 * user-side part. `system` is the system prompt's blocks, one message each.
 */
const cachingConversation = (
  options: Prompt.ProviderOptions,
  system: ReadonlyArray<string> = ["Stable instructions."],
) => [
  ...system.map((content) => Prompt.makeMessage("system", { content })),
  ...Prompt.make([
    { role: "user", content: [{ type: "text", text: "Read a.txt.", options }] },
    {
      role: "assistant",
      content: [
        Prompt.makePart("tool-call", {
          id: "call_read",
          name: "read",
          params: { path: "a.txt" },
          providerExecuted: false,
        }),
      ],
    },
    {
      role: "tool",
      content: [
        Prompt.makePart("tool-result", {
          id: "call_read",
          name: "read",
          result: "alpha",
          isFailure: false,
          providerExecuted: false,
          options,
        }),
      ],
    },
    { role: "user", content: [{ type: "text", text: "Now summarize it." }] },
  ]).content,
]
const runCachingRequest = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  state: FakeFetchState,
  options: Prompt.ProviderOptions,
  /** Messages the runtime sends after the conversation. */
  after: ReadonlyArray<Prompt.Message> = [],
  system?: ReadonlyArray<string>,
) =>
  LanguageModel.generateText({
    prompt: Prompt.fromMessages([...cachingConversation(options, system), ...after]),
    toolkit: Toolkit.make(ReadTool),
    disableToolCallResolution: true,
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        model,
        fakeFetchLayer(state, () => anthropicHappyResponse()),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  )

describe("buildAnthropicModelDriver — prompt caching", () => {
  const isMarked = (block: CacheBlock) =>
    Option.fromNullishOr(block.cache_control).pipe(
      Option.exists((control) => control.type === "ephemeral"),
    )
  const lastMarked = (blocks: ReadonlyArray<CacheBlock>) =>
    Option.fromUndefinedOr(blocks.at(-1)).pipe(Option.exists(isMarked))
  const markerCount = (request: typeof CachedRequest.Type) =>
    [
      ...(request.tools ?? []),
      ...(request.system ?? []),
      ...request.messages.flatMap((message) => message.content),
    ].filter(isMarked).length
  const callerMarker: Prompt.ProviderOptions = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  }
  /** The request body as sent; `child` marks a spawned child session's request. */
  const bodyFor = (
    authInfo: ProviderAuthInfo,
    options: Prompt.ProviderOptions = {},
    after: ReadonlyArray<Prompt.Message> = [],
    system?: ReadonlyArray<string>,
    child = false,
    reasoning: Pick<ProviderHints, "reasoning"> = {},
  ) =>
    Effect.gen(function* () {
      const request = yield* sentThroughSignedInDriver(
        "claude-sonnet-4-6",
        authInfo,
        // A conversation turn names its session as the cache key; the driver marks only such a request.
        { cacheKey: "session-cache-key", child, ...reasoning },
        (model, state) => runCachingRequest(model, state, options, after, system),
      )
      return Option.getOrThrow(Option.fromUndefinedOr(request.body))
    })
  const sentFor = (
    authInfo: ProviderAuthInfo,
    options: Prompt.ProviderOptions = {},
    after: ReadonlyArray<Prompt.Message> = [],
    system?: ReadonlyArray<string>,
  ) =>
    bodyFor(authInfo, options, after, system).pipe(
      Effect.flatMap(Schema.decodeEffect(CachedRequest)),
    )

  // The tool list alone is below Anthropic's minimum cacheable length, so
  // the system prompt's marker caches it: tools render before the system.
  it.live("an API-key request marks the system prompt and the conversation tail", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeApiAuthInfo("sk-test"))
      expect(lastMarked(request.system ?? [])).toBe(true)
      expect(lastMarked(request.messages.at(-1)?.content ?? [])).toBe(true)
      expect((request.tools ?? []).some(isMarked)).toBe(false)
      expect(markerCount(request)).toBe(2)
    }),
  )

  // The billing and identity blocks take no marker; the system prompt moves
  // into the first user message and ends the prefix there, before the user's
  // own text, so a new session or a sibling child reads it from the cache.
  it.live("a Claude Code request marks the relocated system prompt and the tail", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeOAuthInfo())
      expect((request.system ?? []).some(isMarked)).toBe(false)
      const first = request.messages[0]?.content ?? []
      expect(first.filter(isMarked).map((block) => block.text)).toEqual(["Stable instructions."])
      expect(lastMarked(request.messages.at(-1)?.content ?? [])).toBe(true)
      expect((request.tools ?? []).some(isMarked)).toBe(false)
      expect(markerCount(request)).toBe(2)
    }),
  )

  // A turn notice rides after the conversation as a later system message.
  // It changes from turn to turn: a marker on it would cache bytes no later
  // request sends, and the next step would miss the conversation.
  it.live(
    "a turn notice after the conversation takes no marker; the tail stays on the conversation",
    () =>
      Effect.gen(function* () {
        const notice = Prompt.makeMessage("system", {
          content: Option.getOrThrow(
            turnNoticesText([
              { id: "stopped", content: "# Stopped <children>\n\n- one", keys: [] },
            ]),
          ),
        })
        for (const authInfo of [makeApiAuthInfo("sk-test"), makeOAuthInfo()]) {
          const plain = yield* sentFor(authInfo)
          const noticed = yield* sentFor(authInfo, {}, [notice])
          const update = noticed.messages.at(-1)?.content ?? []
          // The patched SDK builds the same wrap as `hostContextUpdateText`.
          expect(update.map((block) => block.text)).toEqual([hostContextUpdateText(notice.content)])
          expect(update[0]?.text).toContain("# Stopped &lt;children&gt;")
          expect(update.some(isMarked)).toBe(false)
          // The last stored message carries the tail marker, as without the notice.
          expect(lastMarked(noticed.messages.at(-2)?.content ?? [])).toBe(true)
          expect(noticed.messages.slice(0, -1)).toEqual([...plain.messages])
          expect(noticed.system).toEqual(plain.system)
          expect(markerCount(noticed)).toBe(2)
        }
      }),
  )

  // An effort change rides inside the conversation as an effort marker; the
  // top level keeps the effort the conversation ran at before the change.
  it.live(
    "a Claude Code request carries an effort change as a marker after the tool result, before the turn notice",
    () =>
      Effect.gen(function* () {
        const notice = Prompt.makeMessage("system", {
          content: Option.getOrThrow(
            turnNoticesText([{ id: "stopped", content: "# Stopped", keys: [] }]),
          ),
        })
        const request = yield* sentThroughSignedInDriver(
          "claude-opus-5",
          makeOAuthInfo(),
          {
            cacheKey: "session-cache-key",
            reasoning: "low",
            reasoningHistory: [Option.some("high")],
          },
          (model, state) => runCachingRequest(model, state, {}, [notice]),
        )
        const body = Option.getOrThrow(Option.fromUndefinedOr(request.body))
        const sent = yield* Schema.decodeEffect(EffortRequest)(body)
        expect(sent.output_config.effort).toBe("high")
        expect(
          sent.messages.map((message) =>
            Option.match(Option.fromUndefinedOr(message.output_config), {
              onNone: () => message.role,
              onSome: (config) => `${message.role}:${config.effort}`,
            }),
          ),
        ).toEqual(["user", "assistant", "user", "system:low", "user"])
        expect(sent.messages[3]?.content).toEqual([])
        const cached = yield* Schema.decodeEffect(CachedRequest)(body)
        expect(lastMarked(cached.messages[2]?.content ?? [])).toBe(true)
        const betas = (request.headers["anthropic-beta"] ?? "").split(",")
        expect(betas).toContain("mid-conversation-output-config-2026-07-01")
        expect(betas).toContain("oauth-2025-04-20")
      }),
  )

  // Anthropic answers 400 above four markers.
  it.live("markers the caller set count toward the limit of four on either auth path", () =>
    Effect.gen(function* () {
      for (const authInfo of [makeApiAuthInfo("sk-test"), makeOAuthInfo()]) {
        expect(markerCount(yield* sentFor(authInfo, callerMarker))).toBe(4)
      }
    }),
  )

  // The runtime sends the prompt as the part a session shares with its
  // children, then the agent's own part; a fresh child reads the shared part
  // back from its parent's entry at that block.
  const sharedPart = `# Shared\n\n${"Instructions every agent reads. ".repeat(160)}`
  const agentPart = "# Children\n\n- Delegate independent work."

  it.live("an API-key request also marks the end of the shared part of the system prompt", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeApiAuthInfo("sk-test"), {}, [], [sharedPart, agentPart])
      const system = request.system ?? []
      expect(system.map((block) => block.text)).toEqual([sharedPart, agentPart])
      expect(system.map(isMarked)).toEqual([true, true])
      // The existing markers stay: the system prompt's end and the conversation tail.
      expect(lastMarked(request.messages.at(-1)?.content ?? [])).toBe(true)
      expect(markerCount(request)).toBe(3)
    }),
  )

  it.live("a shared part below the minimum cacheable length takes no marker", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeApiAuthInfo("sk-test"), {}, [], ["# Shared", agentPart])
      expect((request.system ?? []).map(isMarked)).toEqual([false, true])
      expect(markerCount(request)).toBe(2)
    }),
  )

  it.live("the shared part's marker comes last, within the limit of four", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(
        makeApiAuthInfo("sk-test"),
        callerMarker,
        [],
        [sharedPart, agentPart],
      )
      expect((request.system ?? []).map(isMarked)).toEqual([false, true])
      expect(markerCount(request)).toBe(4)
    }),
  )

  // The Claude Code path moves each system block into the first user message
  // as a block of its own, so the shared part ends there too.
  it.live("a Claude Code request also marks the end of the relocated shared part", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeOAuthInfo(), {}, [], [sharedPart, agentPart])
      const first = request.messages[0]?.content ?? []
      expect(first.map((block) => block.text)).toEqual([sharedPart, agentPart, "Read a.txt."])
      expect(first.map(isMarked)).toEqual([true, true, false])
      expect(markerCount(request)).toBe(3)
    }),
  )

  // A fresh child reads the shared part back from its parent's entry only
  // when every cached byte through that part's end is the parent's.
  // Anthropic caches the prefix in the order tools → system → messages, and
  // a marker is not part of the cached bytes. The thinking settings and the
  // effort render into the prompt too: a change to either invalidates the
  // messages cache, and on some models the tools and system caches. On the
  // Claude Code path the billing header in `system` hashes the first user
  // text block.
  const PrefixRequest = Schema.fromJsonString(
    Schema.Struct({
      thinking: Schema.optional(Schema.Unknown),
      output_config: Schema.optional(Schema.Unknown),
      tools: Schema.optional(Schema.Array(Schema.Unknown)),
      system: Schema.optional(Schema.Array(Schema.Unknown)),
      messages: Schema.Array(
        Schema.Struct({
          role: Schema.String,
          content: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              text: Schema.optional(Schema.String),
              cache_control: Schema.optional(
                Schema.NullOr(Schema.Struct({ ttl: Schema.optional(Schema.String) })),
              ),
            }),
          ),
        }),
      ),
    }),
  )
  const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
  /**
   * The request in cache order, without its markers, after the thinking
   * settings and the effort that key it. The Claude Code path sends no
   * marker on the tools or the system blocks.
   */
  const cachedBytes = (request: typeof PrefixRequest.Type) =>
    encodeJson([
      { thinking: request.thinking, output_config: request.output_config },
      request.tools,
      request.system,
      request.messages.map((message) => ({
        role: message.role,
        content: message.content.map(({ cache_control: _marker, ...block }) => block),
      })),
    ])
  const sharedBlock = (request: typeof PrefixRequest.Type) =>
    request.messages
      .flatMap((message) => message.content)
      .find((block) => block.text === sharedPart)

  /**
   * A parent's and a child's first Claude Code request at the given efforts,
   * and where their cached bytes first differ. The shared text is matched as
   * it renders, without the closing quote: the parent may send it as a block
   * of its own or at the start of a longer one.
   */
  const parentAndChild = (
    parentReasoning: Pick<ProviderHints, "reasoning">,
    childReasoning: Pick<ProviderHints, "reasoning">,
  ) =>
    Effect.gen(function* () {
      const childPart = "# Task\n\n- Report to the parent."
      const decode = Schema.decodeEffect(PrefixRequest)
      // The Claude Code path: the API-key path keeps the shared part in `system`.
      const parent = yield* decode(
        yield* bodyFor(makeOAuthInfo(), {}, [], [sharedPart, agentPart], false, parentReasoning),
      )
      const child = yield* decode(
        yield* bodyFor(makeOAuthInfo(), {}, [], [sharedPart, childPart], true, childReasoning),
      )
      const parentBytes = cachedBytes(parent)
      const childBytes = cachedBytes(child)
      let firstDifference = 0
      while (parentBytes[firstDifference] === childBytes[firstDifference]) firstDifference += 1
      const sharedText = encodeJson(sharedPart).slice(0, -1)
      const sharedEnd = parentBytes.indexOf(sharedText) + sharedText.length
      return { parent, child, firstDifference, sharedEnd, sharedText }
    })

  it.live("a child's first request repeats its parent's cached bytes through the shared part", () =>
    Effect.gen(function* () {
      const { parent, child, firstDifference, sharedEnd, sharedText } = yield* parentAndChild(
        { reasoning: "max" },
        { reasoning: "max" },
      )
      expect(firstDifference).toBeGreaterThan(sharedEnd)
      expect(sharedEnd).toBeGreaterThan(sharedText.length)
      // Both mark the shared end for the parent's lifetime, so the child reads the parent's entry.
      expect(sharedBlock(parent)?.cache_control?.ttl).toBe("1h")
      expect(sharedBlock(child)?.cache_control?.ttl).toBe("1h")
    }),
  )

  // The live Claude Code run on a6c6b4edb: the `main` parent sent effort
  // `max`, the `delegate` child sent none, and the child's first step read 0
  // tokens. The effort renders ahead of the messages, so it keys every marker.
  it.live("a child at another effort than its parent differs before the shared part", () =>
    Effect.gen(function* () {
      const { firstDifference, sharedEnd } = yield* parentAndChild({ reasoning: "max" }, {})
      expect(firstDifference).toBeLessThan(sharedEnd)
    }),
  )
})
const ThinkingRequest = Schema.fromJsonString(
  Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            signature: Schema.optional(Schema.String),
            cache_control: Schema.optional(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
          }),
        ),
      }),
    ),
  }),
)
describe("buildAnthropicModelDriver — thinking replay", () => {
  // The part the loop stores for a signed thinking block (`projectResponsePartsToMessageParts`).
  const signedThinking = Prompt.makePart("reasoning", {
    text: "Read the file first.",
    options: { anthropic: { info: { type: "thinking", signature: "sig-step-1" } } },
  })
  const conversation = Prompt.make([
    { role: "system", content: "Stable instructions." },
    { role: "user", content: "Read a.txt." },
    {
      role: "assistant",
      content: [
        signedThinking,
        Prompt.makePart("tool-call", {
          id: "call_read",
          name: "read",
          params: { path: "a.txt" },
          providerExecuted: false,
        }),
      ],
    },
    {
      role: "tool",
      content: [
        Prompt.makePart("tool-result", {
          id: "call_read",
          name: "read",
          result: "alpha",
          isFailure: false,
          providerExecuted: false,
        }),
      ],
    },
  ])
  /** The conversation's next step, sent through `model`. */
  const sendConversation = (
    model: Layer.Layer<LanguageModel.LanguageModel>,
    state: FakeFetchState,
  ) =>
    LanguageModel.generateText({
      prompt: conversation,
      toolkit: Toolkit.make(ReadTool),
      disableToolCallResolution: true,
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          model,
          fakeFetchLayer(state, () => anthropicHappyResponse()),
        ),
      ),
      Effect.scoped,
      Effect.orDie,
    )

  it.live("a later step sends the thinking block back with its signature on both paths", () =>
    Effect.gen(function* () {
      for (const authInfo of [makeApiAuthInfo("sk-test"), makeOAuthInfo()]) {
        const sent = yield* sentThroughSignedInDriver(
          "claude-sonnet-4-6",
          authInfo,
          { reasoning: "high" },
          sendConversation,
        )
        const request = yield* Schema.decodeEffect(ThinkingRequest)(
          Option.getOrThrow(Option.fromUndefinedOr(sent.body)),
        )
        const assistant = request.messages.find((message) => message.role === "assistant")
        expect(assistant?.content.map((block) => block.type)).toEqual(["thinking", "tool_use"])
        const thinking = assistant?.content[0]
        expect(thinking?.signature).toBe("sig-step-1")
        // A thinking block takes no cache marker; Anthropic answers 400 on one.
        expect(Option.fromNullishOr(thinking?.cache_control).pipe(Option.isSome)).toBe(false)
      }
    }),
  )

  // platform.claude.com/docs/en/build-with-claude/preserved-thinking (read
  // 2026-09-23): on Fable 5.1 and Opus 5.5 a signed block is bound to the
  // system prompt, the tools, and every message before it, and the default
  // for a changed prefix is a 400. A resumed session has a new Date line; a
  // compacted window drops earlier messages. `drop_block` has the API drop
  // those blocks and answer; models without the check accept the field.
  it.live("a thinking request lets Anthropic drop a block bound to another prefix", () =>
    Effect.gen(function* () {
      const BoundRequest = Schema.fromJsonString(
        Schema.Struct({
          thinking: Schema.optional(
            Schema.Struct({
              type: Schema.String,
              block_binding: Schema.optional(
                Schema.Struct({ prefix_mismatch_behavior: Schema.String }),
              ),
            }),
          ),
        }),
      )
      const sent = (modelName: string, authInfo: ProviderAuthInfo, hints: ProviderHints) =>
        Effect.gen(function* () {
          const request = yield* sentThroughSignedInDriver(
            modelName,
            authInfo,
            hints,
            sendConversation,
          )
          const body = yield* Schema.decodeEffect(BoundRequest)(
            Option.getOrThrow(Option.fromUndefinedOr(request.body)),
          )
          const betas = Option.getOrElse(
            Option.fromUndefinedOr(request.headers["anthropic-beta"]),
            () => "",
          ).split(",")
          return {
            binding: Option.fromUndefinedOr(body.thinking?.block_binding?.prefix_mismatch_behavior),
            beta: betas.includes("thinking-binding-controls-2026-08-01"),
          }
        })
      for (const authInfo of [makeApiAuthInfo("sk-test"), makeOAuthInfo()]) {
        for (const modelName of ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5"]) {
          expect(yield* sent(modelName, authInfo, { reasoning: "high" })).toEqual({
            binding: Option.some("drop_block"),
            beta: true,
          })
        }
        // Thinking turned off sends no thinking object to bind, and no beta.
        expect(yield* sent("claude-sonnet-5", authInfo, { reasoning: "none" })).toEqual({
          binding: Option.none(),
          beta: false,
        })
      }
    }),
  )
})
describe("buildAnthropicModelDriver — API-key path is plain SDK", () => {
  it.live(
    "API-key resolveModel does NOT inject buildKeychainTransformClient transforms (no SYSTEM_IDENTITY_PREFIX)",
    () =>
      Effect.gen(function* () {
        const credentialCellRef =
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
        const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
        const fetchState = makeFakeFetchState()
        yield* runOne(model, fetchState)
        const payload = parsePayload(
          Option.getOrThrow(Option.fromUndefinedOr(fetchState.captured.at(-1)!.body)),
        )
        // No buildKeychainTransformClient wrapper → no system block, no identity prefix
        // injection. The API-key branch must not wrap.
        expect(Bun.inspect(payload["system"] ?? "")).not.toContain(SYSTEM_IDENTITY_PREFIX)
      }),
  )
  it.live("API-key path does not touch the OAuth credential cell", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-opus-4-6", makeApiAuthInfo("sk-test-1234"))
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      expect(yield* SynchronizedRef.get(credentialCellRef)).toBe(EMPTY_CREDENTIAL_CELL)
    }),
  )
})

// ── reset time decode ───────────────────────────────────────────────────────

/** The reset time the driver reads from a failed request's answer, counted from `nowMs`. */
const failedResetAt = (
  answer: { readonly status: number; readonly errorType: string },
  headers: Record<string, string>,
  nowMs: number,
) =>
  Effect.gen(function* () {
    const credentialCellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
    const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
    const model = yield* driver.resolveModel("claude-sonnet-4-5", makeApiAuthInfo("test-key"))
    const reply = () => ({
      status: answer.status,
      headers: { "content-type": "application/json", ...headers },
      body: encodeExternalJson({
        type: "error",
        error: { type: answer.errorType, message: "The request failed" },
      }),
    })
    const error = yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
      Stream.runDrain,
      Effect.provide(Layer.provideMerge(model, fakeFetchLayer(makeFakeFetchState(), reply))),
      Effect.scoped,
      Effect.flip,
    )
    return Option.getOrThrow(Option.fromUndefinedOr(driver.retry)).retryAt(error, nowMs)
  })

/** The reset time the driver reads from a 429 with `headers`, counted from `nowMs`. */
const rateLimitedResetAt = (headers: Record<string, string>, nowMs: number) =>
  failedResetAt({ status: 429, errorType: "rate_limit_error" }, headers, nowMs)

const RESET_NOW = Date.parse("2026-10-04T12:00:00Z")

describe("Anthropic reset time", () => {
  it.live("a rate limit resets when its latest spent limit is full again", () =>
    Effect.gen(function* () {
      const resetAt = yield* rateLimitedResetAt(
        {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-10-04T12:05:00Z",
          "anthropic-ratelimit-input-tokens-remaining": "0",
          "anthropic-ratelimit-input-tokens-reset": "2026-10-04T12:01:00Z",
          "anthropic-ratelimit-output-tokens-remaining": "8000",
          "anthropic-ratelimit-output-tokens-reset": "2026-10-04T13:00:00Z",
        },
        RESET_NOW,
      )
      expect(resetAt).toEqual(Option.some(Date.parse("2026-10-04T12:05:00Z")))
    }),
  )

  it.live("a limit with some left does not hold the retry", () =>
    Effect.gen(function* () {
      const resetAt = yield* rateLimitedResetAt(
        {
          "anthropic-ratelimit-requests-remaining": "40",
          "anthropic-ratelimit-requests-reset": "2026-10-04T12:05:00Z",
        },
        RESET_NOW,
      )
      expect(resetAt).toEqual(Option.none())
    }),
  )

  it.live("a short retry-after does not shorten a spent limit's reset", () =>
    Effect.gen(function* () {
      const resetAt = yield* rateLimitedResetAt(
        {
          "retry-after": "3",
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-10-04T12:05:00Z",
        },
        RESET_NOW,
      )
      expect(resetAt).toEqual(Option.some(Date.parse("2026-10-04T12:05:00Z")))
    }),
  )

  it.live("a refused request's limit headers name no reset", () =>
    Effect.gen(function* () {
      const resetAt = yield* failedResetAt(
        { status: 400, errorType: "invalid_request_error" },
        {
          "anthropic-ratelimit-requests-remaining": "0",
          "anthropic-ratelimit-requests-reset": "2026-10-04T12:05:00Z",
        },
        RESET_NOW,
      )
      expect(resetAt).toEqual(Option.none())
    }),
  )
})

describe("named Anthropic directory import", () => {
  it.scopedLive("imports only the requested directory through RPC", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const directory = path.join(home, "second")
      yield* fs.makeDirectory(directory)
      yield* fs.writeFileString(
        path.join(directory, ".credentials.json"),
        encodeExternalJson({
          claudeAiOauth: {
            accessToken: "fake-second-access",
            refreshToken: "fake-second-refresh",
            expiresAt: (yield* Clock.currentTimeMillis) + 3600000,
          },
        }),
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
      const { client, sessionId } = yield* createRpcHarness({
        agents: [testAgent],
        extensionInputs: [AnthropicExtension],
        providerLayer,
        home,
      })
      const methods = yield* client.auth.listMethods({ sessionId })
      expect(methods["anthropic"]?.[2]?.prompts?.[0]?.key).toBe("directory")
      // A refresh rotates the token, so a copy that two programs refresh
      // signs one of them out: the import asks for a directory no live
      // Claude Code uses, and never writes it.
      expect(methods["anthropic"]?.[2]?.prompts?.[0]?.label).toContain("only for gent")
      const source = yield* fs.readFileString(path.join(directory, ".credentials.json"))
      const slot = CredentialSlot.make("personal")
      const imported = yield* client.auth.authorize({
        sessionId,
        provider: "anthropic",
        method: 2,
        slot,
        inputs: { directory },
      })
      expect(imported?.instructions).toContain("gent refreshes it alone")
      expect(imported?.instructions).toContain("do not run Claude Code on that directory again")
      expect(yield* fs.readFileString(path.join(directory, ".credentials.json"))).toBe(source)
      const rows = yield* client.auth.listProviders({ sessionId })
      const row = rows.find((row) => row.provider === "anthropic")
      expect(
        row?.credentials?.some(
          (entry) => entry.slot === slot && entry.hasKey && entry.authType === "oauth",
        ),
      ).toBe(true)
      expect(row?.hasKey).toBe(false)
      const refused = yield* Effect.exit(
        client.auth.authorize({
          sessionId,
          provider: "anthropic",
          method: 0,
          slot: CredentialSlot.make("other"),
        }),
      )
      expect(Exit.isFailure(refused)).toBe(true)
      const missing = yield* Effect.exit(
        client.auth.authorize({
          sessionId,
          provider: "anthropic",
          method: 2,
          slot: CredentialSlot.make("missing"),
          inputs: { directory: path.join(home, "missing") },
        }),
      )
      expect(Exit.isFailure(missing)).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

describe("named Anthropic credential cache", () => {
  it.scopedLive("named refresh uses only direct OAuth and never the primary source or CLI", () =>
    Effect.gen(function* () {
      let spawned = 0
      const services = Context.add(
        yield* driverServices(
          AnthropicPlatform.of({
            platform: "linux",
            home: "/nonexistent/gent-named-refresh",
            env: {},
          }),
        ),
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawned++
          }).pipe(Effect.andThen(Effect.die("named refresh forbids CLI"))),
        ),
      )
      const driver = buildAnthropicModelDriverLive(
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL),
        Option.none(),
        services,
        "1h",
      )
      const state = makeFakeFetchState()
      const fetch = fakeFetchLayer(state, (request) => {
        const refresh = new URLSearchParams(request.body ?? "").get("refresh_token")
        if (refresh === "fake-revoked")
          return { status: 400, body: encodeExternalJson({ error: "invalid_grant" }) }
        return {
          status: 200,
          body: encodeExternalJson({
            access_token: "fake-rotated-access",
            refresh_token: "fake-rotated-refresh",
            expires_in: 3600,
          }),
        }
      })
      for (const [slot, token, success] of [
        [CredentialSlot.make("personal"), "fake-direct", true],
        [CredentialSlot.make("revoked"), "fake-revoked", false],
      ] as const) {
        const model = storedCredentialModel({
          modelDrivers: [driver],
          stored: {},
          oauth: [
            {
              provider: "anthropic",
              slot,
              credential: { access: "fake-expired", refresh: token, expires: 0 },
            },
          ],
          modelId: "anthropic/claude-opus-4-6",
          catalog: fixtureModelCatalog(),
          credentialSlot: slot,
        })
        const result = yield* Effect.exit(Layer.build(model).pipe(Effect.provide(fetch)))
        expect(Exit.isSuccess(result)).toBe(success)
        if (Exit.isFailure(result)) {
          const defect = Cause.findDefect(result.cause)
          // The token endpoint refused it: a turn may move to the next credential.
          expect(
            Result.isSuccess(defect) &&
              Schema.is(ProviderAuthError)(defect.success) &&
              defect.success.message.includes("import it again") &&
              defect.success.credentialFailure === "Rejected",
          ).toBe(true)
        }
      }
      expect(state.captured.length).toBe(2)
      expect(
        state.captured.every((request) => request.url === "https://claude.ai/v1/oauth/token"),
      ).toBe(true)
      expect(
        new URLSearchParams(state.captured[0]?.body ?? "").get("refresh_token") === "fake-direct",
      ).toBe(true)
      expect(
        new URLSearchParams(state.captured[1]?.body ?? "").get("refresh_token") === "fake-revoked",
      ).toBe(true)
      expect(spawned).toBe(0)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.scopedLive("a named refresh reply without a token leaves the credential unmarked", () =>
    Effect.gen(function* () {
      const driver = buildAnthropicModelDriverLive(
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL),
        Option.none(),
        yield* driverServices(
          AnthropicPlatform.of({
            platform: "linux",
            home: "/nonexistent/gent-named-garbled",
            env: {},
          }),
        ),
        "1h",
      )
      // The token endpoint answers 200 with no access token: a parse fault.
      const fetch = fakeFetchLayer(makeFakeFetchState(), () => ({
        status: 200,
        body: encodeExternalJson({ token_type: "bearer" }),
      }))
      const slot = CredentialSlot.make("personal")
      const model = storedCredentialModel({
        modelDrivers: [driver],
        stored: {},
        oauth: [
          {
            provider: "anthropic",
            slot,
            credential: { access: "fake-expired", refresh: "fake-garbled", expires: 0 },
          },
        ],
        modelId: "anthropic/claude-opus-4-6",
        catalog: fixtureModelCatalog(),
        credentialSlot: slot,
      })
      const result = yield* Effect.exit(Layer.build(model).pipe(Effect.provide(fetch)))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) return
      const defect = Cause.findDefect(result.cause)
      // The reply proves nothing about the credential: the turn stays on it.
      expect(
        Result.isSuccess(defect) &&
          Schema.is(ProviderAuthError)(defect.success) &&
          defect.success.message.includes("import it again") &&
          Option.isNone(Option.fromUndefinedOr(defect.success.credentialFailure)),
      ).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )

  it.scopedLive(
    "a warm named slot never serves an expired or missing slot, or invokes the primary CLI",
    () =>
      Effect.gen(function* () {
        let spawned = 0
        const guard = ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            spawned++
          }).pipe(Effect.andThen(Effect.die("named credentials must not invoke a process"))),
        )
        const services = Context.add(
          yield* driverServices(
            AnthropicPlatform.of({
              platform: "linux",
              home: "/nonexistent/gent-named-primary",
              env: {},
            }),
          ),
          ChildProcessSpawner.ChildProcessSpawner,
          guard,
        )
        // One real builder survives all resolutions, exactly as an extension profile does.
        const driver = buildAnthropicModelDriverLive(
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
            EMPTY_CREDENTIAL_CELL,
          ),
          Option.none(),
          services,
          "1h",
        )
        const work = CredentialSlot.make("work")
        const personal = CredentialSlot.make("personal")
        const oauth = [
          {
            provider: "anthropic",
            slot: work,
            credential: {
              access: "fake-work",
              refresh: "fake-work-refresh",
              expires: (yield* Clock.currentTimeMillis) + 3600000,
            },
          },
          {
            provider: "anthropic",
            slot: personal,
            credential: { access: "fake-expired", refresh: "", expires: 0 },
          },
        ]
        for (const [slot, success] of [
          [work, true],
          [personal, false],
          [CredentialSlot.make("missing"), false],
        ] as const) {
          const model = storedCredentialModel({
            modelDrivers: [driver],
            stored: {},
            oauth,
            modelId: "anthropic/claude-opus-4-6",
            catalog: fixtureModelCatalog(),
            credentialSlot: slot,
          })
          const result = yield* Effect.exit(Layer.build(model))
          expect(Exit.isSuccess(result)).toBe(success)
        }
        expect(spawned).toBe(0)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("8 seconds")),
  )
})

// ── named import commit ─────────────────────────────────────────────────────

/** Actual RPC profile and its exact registered builder/cells; only filesystem I/O is gated. */
const namedImportCommitRig = (sharedDirectory: Option.Option<string> = Option.none<string>()) =>
  Effect.gen(function* () {
    const disk = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* disk.makeTempDirectoryScoped()
    const authDirectory = Option.getOrElse(sharedDirectory, () => path.join(home, "auth"))
    const sourceA = path.join(home, "source-a")
    const sourceB = path.join(home, "source-b")
    const slot = CredentialSlot.make("personal")
    const credentialFile = path.join(authDirectory, ".slots", "anthropic", slot)
    const blocked = path.join(home, "rename-blocked")
    yield* disk.makeDirectory(blocked)
    for (const [directory, access] of [
      [sourceA, "fake-a"],
      [sourceB, "fake-b"],
    ] as const) {
      yield* disk.makeDirectory(directory)
      yield* disk.writeFileString(
        path.join(directory, ".credentials.json"),
        encodeExternalJson({
          claudeAiOauth: {
            accessToken: access,
            refreshToken: access + "-refresh",
            expiresAt: (yield* Clock.currentTimeMillis) + 3600000,
          },
        }),
      )
    }
    let beforeRead: (file: string) => Effect.Effect<void> = () => Effect.void
    let afterRead: (file: string) => Effect.Effect<void> = () => Effect.void
    let afterRename: (file: string) => Effect.Effect<void> = () => Effect.void
    let rejectRename = false
    const renames = yield* Ref.make(0)
    const fs: FileSystem.FileSystem = {
      ...disk,
      readFileString: (file, encoding) =>
        Effect.suspend(() => beforeRead(file)).pipe(
          Effect.andThen(disk.readFileString(file, encoding)),
          Effect.tap(() => afterRead(file)),
        ),
      rename: (from, to) =>
        Effect.gen(function* () {
          if (to === credentialFile) {
            yield* Ref.update(renames, (count) => count + 1)
            if (rejectRename) return yield* disk.rename(from, blocked)
          }
          yield* disk.rename(from, to)
          yield* afterRename(to)
        }),
    }
    const basePlatform = yield* Layer.build(Layer.mergeAll(BunServices.layer, BunGentPlatformLive))
    const platform = Layer.succeedContext(Context.add(basePlatform, FileSystem.FileSystem, fs))
    const ready = yield* Deferred.make<ReturnType<typeof buildAnthropicModelDriverLive>>()
    const extension = defineExtension({
      id: "@test/named-import-commit",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        const services = Context.add(
          yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("named import forbids CLI")),
        ).pipe(Context.add(FileSystem.FileSystem, fs))
        const driver = buildAnthropicModelDriverLive(
          yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
            EMPTY_CREDENTIAL_CELL,
          ),
          Option.none(),
          services,
          "1h",
        )
        yield* host.register("agent", testAgent)
        yield* host.register("modelDriver", driver)
        yield* Deferred.succeed(ready, driver)
      }),
    })
    const catalog = yield* modelCatalogFixture
    const { client } = yield* createRpcClient(
      createDependencies({
        cwd: home,
        home,
        platform: "linux",
        authDirectory,
        state: StateLocation.cases.Memory.make({}),
        extensions: [extension],
        failOnExtensionFailure: true,
        overrides: {
          configServiceLayer: ConfigService.Test(),
          modelCatalogHttpLayer: catalog.layer,
        },
      }).pipe(Layer.provideMerge(Layer.merge(platform, catalog.layer))),
    )
    // This is the builder created by THIS host profile, never a second factory or wrapper.
    const driver = yield* Deferred.await(ready)
    const { sessionId } = yield* client.session.create({ cwd: home })
    const importSlot = (directory: string, target: CredentialSlot) =>
      client.auth.authorize({
        sessionId,
        provider: "anthropic",
        method: 2,
        slot: target,
        inputs: { directory },
      })
    const importFrom = (directory: string) => importSlot(directory, slot)
    const requestUses = (access: string) =>
      Effect.gen(function* () {
        const state = makeFakeFetchState()
        const model = storedCredentialModel({
          modelDrivers: [driver],
          stored: {},
          authDirectory,
          modelId: "anthropic/claude-opus-4-6",
          catalog: fixtureModelCatalog(),
          credentialSlot: slot,
        }).pipe(Layer.provide(platform))
        yield* oneGenerate(model, state, () => anthropicHappyResponse())
        return state.captured.at(-1)?.headers["authorization"] === "Bearer " + access
      })
    yield* importFrom(sourceA)
    expect(yield* requestUses("fake-a")).toBe(true)
    return {
      client,
      sessionId,
      driver,
      home,
      slot,
      authDirectory,
      sourceA,
      sourceB,
      credentialFile,
      disk,
      renames,
      importFrom,
      importSlot,
      requestUses,
      gateRead: (gate: typeof beforeRead) => {
        beforeRead = gate
      },
      gateReadComplete: (gate: typeof afterRead) => {
        afterRead = gate
      },
      gateRename: (gate: typeof afterRename) => {
        afterRename = gate
      },
      failRename: (fail: boolean) => {
        rejectRename = fail
      },
    }
  })

describe("named import persistence and publication", () => {
  it.scopedLive(
    "named imports cancel before commit while actual provider or SQLite locks are held",
    () =>
      Effect.gen(function* () {
        for (const separateHost of [false, true]) {
          const rig = yield* namedImportCommitRig()
          let owner = rig
          if (separateHost) owner = yield* namedImportCommitRig(Option.some(rig.authDirectory))
          const holdSlot = CredentialSlot.make("holding")
          const holdingFile = rig.authDirectory + "/.slots/anthropic/holding"
          const landed = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() => Deferred.completeWith(release, Effect.void))
          owner.gateRename((file) => {
            if (file !== holdingFile) return Effect.void
            return Deferred.completeWith(landed, Effect.void).pipe(
              Effect.andThen(Deferred.await(release)),
            )
          })
          const holding = yield* owner.importSlot(owner.sourceB, holdSlot).pipe(Effect.forkScoped)
          yield* Deferred.await(landed)
          const before = yield* rig.disk.readFileString(rig.credentialFile)
          const count = yield* Ref.get(rig.renames)
          const reading = yield* Deferred.make<void>()
          rig.gateReadComplete((file) => {
            if (file !== rig.sourceB + "/.credentials.json") return Effect.void
            return Deferred.completeWith(reading, Effect.void)
          })
          const waiting = yield* rig.importFrom(rig.sourceB).pipe(Effect.forkScoped)
          yield* Deferred.await(reading)
          yield* Effect.yieldNow
          const ended = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("300 millis"))
          yield* Deferred.completeWith(release, Effect.void)
          yield* Fiber.join(holding)
          owner.gateRename(() => Effect.void)
          rig.gateReadComplete(() => Effect.void)
          expect(Option.isSome(ended)).toBe(true)
          expect(yield* Ref.get(rig.renames)).toBe(count)
          expect((yield* rig.disk.readFileString(rig.credentialFile)) === before).toBe(true)
          expect(yield* rig.requestUses("fake-a")).toBe(true)
          yield* rig.importFrom(rig.sourceB)
          expect(yield* rig.requestUses("fake-b")).toBe(true)
        }
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
  )

  it.scopedLive("an interrupted landed replacement never leaves the old warm account serving", () =>
    Effect.gen(function* () {
      const rig = yield* namedImportCommitRig()
      const before = yield* rig.disk.readFileString(rig.credentialFile)
      const landed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.completeWith(release, Effect.void))
      rig.gateRename((file) => {
        if (file !== rig.credentialFile) return Effect.void
        return Deferred.completeWith(landed, Effect.void).pipe(
          Effect.andThen(Deferred.await(release)),
        )
      })
      const replacing = yield* rig.importFrom(rig.sourceB).pipe(Effect.forkScoped)
      yield* Deferred.await(landed)
      expect((yield* rig.disk.readFileString(rig.credentialFile)) !== before).toBe(true)
      const interrupting = yield* Fiber.interrupt(replacing).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Deferred.completeWith(release, Effect.void)
      yield* Fiber.join(interrupting)
      rig.gateRename(() => Effect.void)
      expect(yield* rig.requestUses("fake-b")).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )

  it.scopedLive("early source cancellation writes nothing and releases the named cell", () =>
    Effect.gen(function* () {
      const rig = yield* namedImportCommitRig()
      const before = yield* rig.disk.readFileString(rig.credentialFile)
      const count = yield* Ref.get(rig.renames)
      const reading = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.completeWith(release, Effect.void))
      rig.gateRead((file) => {
        if (file !== rig.sourceB + "/.credentials.json") return Effect.void
        return Deferred.completeWith(reading, Effect.void).pipe(
          Effect.andThen(Deferred.await(release)),
        )
      })
      const replacing = yield* rig.importFrom(rig.sourceB).pipe(Effect.forkScoped)
      yield* Deferred.await(reading)
      const ended = yield* Fiber.interrupt(replacing).pipe(Effect.timeoutOption("300 millis"))
      yield* Deferred.completeWith(release, Effect.void)
      rig.gateRead(() => Effect.void)
      expect(Option.isSome(ended)).toBe(true)
      expect(yield* Ref.get(rig.renames)).toBe(count)
      expect((yield* rig.disk.readFileString(rig.credentialFile)) === before).toBe(true)
      expect(yield* rig.requestUses("fake-a")).toBe(true)
      yield* rig.importFrom(rig.sourceB)
      expect(yield* rig.requestUses("fake-b")).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )

  it.scopedLive("cancellation while the actual named cell is held performs no second write", () =>
    Effect.gen(function* () {
      const rig = yield* namedImportCommitRig()
      const landed = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.completeWith(release, Effect.void))
      rig.gateRename((file) => {
        if (file !== rig.credentialFile) return Effect.void
        return Deferred.completeWith(landed, Effect.void).pipe(
          Effect.andThen(Deferred.await(release)),
        )
      })
      const holding = yield* rig.importFrom(rig.sourceB).pipe(Effect.forkScoped)
      yield* Deferred.await(landed)
      const count = yield* Ref.get(rig.renames)
      const sourceRead = yield* Deferred.make<void>()
      rig.gateReadComplete((file) => {
        if (file !== rig.sourceA + "/.credentials.json") return Effect.void
        return Deferred.completeWith(sourceRead, Effect.void)
      })
      const waiting = yield* rig.importFrom(rig.sourceA).pipe(Effect.forkScoped)
      yield* Deferred.await(sourceRead)
      yield* Effect.yieldNow
      const ended = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("300 millis"))
      yield* Deferred.completeWith(release, Effect.void)
      yield* Fiber.join(holding)
      rig.gateRename(() => Effect.void)
      rig.gateReadComplete(() => Effect.void)
      expect(Option.isSome(ended)).toBe(true)
      expect(yield* Ref.get(rig.renames)).toBe(count)
      expect(yield* rig.requestUses("fake-b")).toBe(true)
      yield* rig.importFrom(rig.sourceA)
      expect(yield* rig.requestUses("fake-a")).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )

  it.scopedLive("failed real persistence leaves the old warm cell and stored entry intact", () =>
    Effect.gen(function* () {
      const rig = yield* namedImportCommitRig()
      const before = yield* rig.disk.readFileString(rig.credentialFile)
      rig.failRename(true)
      const failed = yield* Effect.exit(rig.importFrom(rig.sourceB))
      expect(Exit.isFailure(failed)).toBe(true)
      expect((yield* rig.disk.readFileString(rig.credentialFile)) === before).toBe(true)
      expect(yield* rig.requestUses("fake-a")).toBe(true)
      rig.failRename(false)
      yield* rig.importFrom(rig.sourceB)
      expect(yield* rig.requestUses("fake-b")).toBe(true)
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )
})
