import { describe, expect, it, test } from "effect-bun-test"
import {
  makeAnthropicCredentialCache,
  type AnthropicCredentialIO,
  type AnthropicKeychainEnv,
  AnthropicPlatform,
  buildAnthropicModelDriver as buildAnthropicModelDriverLive,
  buildBillingHeaderValue as buildBillingHeaderValueEffect,
  buildKeychainTransformClient,
  type ClaudeCredentials,
  computeCch as computeCchEffect,
  computeVersionSuffix as computeVersionSuffixEffect,
  extractFirstUserMessageText,
  getModelBetas,
  getModelOverride,
  MODEL_CONFIG,
  parseOAuthResponse,
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
  Predicate,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import type * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { TestClock } from "effect/testing"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  testHostFacts,
  fakeFetchLayer,
  type FakeFetchState,
  makeFakeFetchState,
  oneGenerate,
  turnNoticesText,
} from "@gent/core/test-utils"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError"
import {
  type CredentialCacheCell,
  type CredentialFailure,
  CredentialRefreshUnavailable,
  EMPTY_CREDENTIAL_CELL,
  hostContextUpdateText,
} from "../src/providers.js"
import {
  type ExtensionHostService,
  ProviderAuthError,
  type ProviderHints,
  ProviderAuthInfo,
} from "@gent/core/extensions/api"
import { encodeExternalJson, externalWireNull } from "./helpers/external-wire.js"
import { testCatalogSource } from "./helpers/catalog-source.js"
import { createHash } from "node:crypto"
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"
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

// Synchronously run a transformPayload effect — `BunCrypto.layer` hashes
// with `node:crypto` `createHash`, which is synchronous.
const transformPayload = (payload: JsonRecord): JsonRecord =>
  Effect.runSync(
    transformPayloadEffect(payload).pipe(
      Effect.provide(Layer.merge(BunCrypto.layer, testPlatformLayer)),
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

  test("passes through non-content_block_start events", () => {
    const event = {
      type: "message_stop",
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent([])(event)
    expect(result).toBe(event)
  })

  test("passes through content_block_delta events", () => {
    const event = {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"text":' },
    } satisfies AnthropicClient.MessageStreamEvent
    const result = transformStreamEvent([])(event)
    expect(result).toBe(event)
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
// the body via `requestBodyText` which decodes that Uint8Array back to
// a string, so this matches production representation.
const jsonBody = (payload: JsonRecord) => HttpBody.jsonUnsafe(payload)
// `Effect.orDie` collapses typed errors to defects so test bodies can
// assert success without `as Effect<unknown, never, never>` casts.
const runOk = <A, E, R>(eff: Effect.Effect<A, E, R>) => Effect.scoped(eff.pipe(Effect.orDie))
// ── Tests ──
describe("keychainTransformClient — auth headers", () => {
  it.scopedLive("injects Authorization Bearer from credential service", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(validCredsIO("k1"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      expect(fakeState.captured).toHaveLength(1)
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
    }),
  )
  it.scopedLive("removes x-api-key (would otherwise conflict with OAuth Bearer)", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(validCredsIO("k1"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // Simulate the SDK's baseline by injecting x-api-key on the
      // outgoing request. The transform must strip it.
      yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          headers: { "x-api-key": "oauth-placeholder", "anthropic-version": "2023-06-01" },
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      expect(fakeState.captured[0]!.headers["x-api-key"]).toBeUndefined()
      // Preserves SDK baseline header
      expect(fakeState.captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
    }),
  )
  it.scopedLive("sets x-app, user-agent, anthropic-dangerous-direct-browser-access", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(validCredsIO("k1"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      const headers = fakeState.captured[0]!.headers
      expect(headers["x-app"]).toBe("cli")
      expect(headers["user-agent"]).toMatch(/^claude-cli\/.+ \(external, cli\)$/)
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
    }),
  )
  it.scopedLive("merges anthropic-beta with model defaults", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(validCredsIO("k1"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      // Body declares claude-opus-4-6, which has model-default betas
      // (base set + 1M-context + effort-2025-11-24 from the override).
      // Incoming "incoming-beta-1" must merge with those, not replace.
      yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          headers: { "anthropic-beta": "incoming-beta-1" },
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
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
  it.scopedLive("credential-service failure surfaces as a request-build HttpClientError", () =>
    Effect.gen(function* () {
      const creds = yield* credentialCache({
        read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
        refresh: () => Effect.fail(new ProviderAuthError({ message: "no refresh token either" })),
      })
      const fakeState: FakeClientState = {
        captured: [],
        responder: () => new Response("ok", { status: 200 }),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const exit = yield* Effect.scoped(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      ).pipe(Effect.exit)
      // The fake client never saw the request — the transform short-
      // circuited at the credential read.
      expect(fakeState.captured).toHaveLength(0)
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
  const sendOnce = (responder: (call: number) => Response | TransportFailure) =>
    Effect.gen(function* () {
      const creds = yield* credentialCache(validCredsIO("k1"))
      const fakeState: FakeClientState = { captured: [], responder }
      const wrapped = buildKeychainTransformClient(creds, TEST_ENV)(makeFakeClient(fakeState))
      const exit = yield* Effect.scoped(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      ).pipe(Effect.exit)
      return { exit, captured: fakeState.captured }
    })
  for (const status of [429, 529, 500]) {
    it.scopedLive(`a ${status} reaches the caller after one attempt`, () =>
      Effect.gen(function* () {
        const { exit, captured } = yield* sendOnce(() => new Response("busy", { status }))
        expect(captured).toHaveLength(1)
        expect(Exit.isSuccess(exit) && exit.value.status).toBe(status)
      }),
    )
  }
  it.scopedLive("a long-context 400 reaches the caller after one attempt, betas untouched", () =>
    Effect.gen(function* () {
      const body =
        '{"type":"error","error":{"message":"Extra usage is required for long context requests"}}'
      const { exit, captured } = yield* sendOnce(() => new Response(body, { status: 400 }))
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
      const creds = yield* credentialCache(togglingCredsIO("stale", "fresh"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("auth", { status: 401 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      expect(fakeState.captured).toHaveLength(2)
      expect(response.status).toBe(200)
      // Crucial: token differs across attempts — invalidate forced the
      // mapRequestEffect to re-read creds, getting the fresh token.
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer stale-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer fresh-access")
    }),
  )
  it.scopedLive("401 with the keychain unchanged → refresh with its refresh token → retry", () =>
    Effect.gen(function* () {
      // The server revoked a token whose expiry is still ahead; the keychain
      // still holds it, so only a refresh can replace it.
      const held: Array<Option.Option<ClaudeCredentials>> = []
      const creds = yield* credentialCache({
        read: Effect.succeed(makeCredsKeychain("revoked")),
        refresh: (credential) =>
          Effect.sync(() => {
            held.push(credential)
            return makeCredsKeychain("renewed")
          }),
      })
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("auth", { status: 401 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const response = yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      expect(response.status).toBe(200)
      expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer revoked-access")
      expect(fakeState.captured[1]!.headers["authorization"]).toBe("Bearer renewed-access")
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
        const creds = yield* credentialCache(togglingCredsIO("stale", "still-bad"))
        const fakeState: FakeClientState = {
          captured: [],
          // Both attempts get 401 — the second 401 is a real auth failure
          // (revoked session, missing scope) and must reach the caller.
          responder: () => new Response("auth", { status: 401 }),
        }
        const transform = buildKeychainTransformClient(creds, TEST_ENV)
        const wrapped = transform(makeFakeClient(fakeState))
        const response = yield* runOk(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        )
        // 1 initial + 1 retry = 2 attempts (no third)
        expect(fakeState.captured).toHaveLength(2)
        expect(response.status).toBe(401)
      }),
  )
  it.scopedLive("non-401 failure does not invalidate creds", () =>
    Effect.gen(function* () {
      // Fire TWO sequential requests (500 then 200) on the same creds
      // service. If a non-401 mistakenly invalidated the cache, request
      // #2 would re-read and pick up the second token. Asserting both
      // requests use the first token proves the cache survived the 500.
      const creds = yield* credentialCache(togglingCredsIO("first", "second"))
      const fakeState: FakeClientState = {
        captured: [],
        responder: respondFirstWith(
          new Response("server error", { status: 500 }),
          new Response("ok", { status: 200 }),
        ),
      }
      const transform = buildKeychainTransformClient(creds, TEST_ENV)
      const wrapped = transform(makeFakeClient(fakeState))
      const r1 = yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
      )
      const r2 = yield* runOk(
        wrapped.post("https://api.anthropic.com/v1/messages", {
          body: jsonBody({ model: "claude-opus-4-6" }),
        }),
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
// Suppress unused-warning for Layer/Ref imports kept for symmetry with
// other test files in this directory.
void Layer
void Ref

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
const COMPLETE = Option.getOrUndefined(Option.none<void>())
// `TestClock.adjust` requires a `Scope` (it manages internal sleeper
// fibers). Wrap with `Effect.scoped` so tests don't have to thread
// scope manually.
const runWithTestClock = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.scoped(eff).pipe(Effect.provide(TestClock.layer()))
// ── Tests ──
describe("Anthropic credential cache — cache hit/miss", () => {
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
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const first = yield* svc.getFresh
          callsRef.current = creds2 // source switches; cache should ignore
          const second = yield* svc.getFresh
          expect(first.accessToken).toBe("k1-access")
          expect(second.accessToken).toBe("k1-access")
        }),
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
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
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
        }),
      )
    }),
  )
  it.live("expiring-soon creds trigger refresh; refreshed creds returned", () =>
    Effect.gen(function* () {
      // Outcome assertion: the returned creds are the refreshed ones, not
      // the stale ones.
      const stale = makeCreds("stale", 30000) // 30s — inside the 60s freshness margin
      const fresh = makeCreds("fresh", FAR_FUTURE)
      const state: IOState = {
        readResult: () => Effect.succeed(stale),
        refreshResult: () => Effect.succeed(fresh),
      }
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const result = yield* svc.getFresh
          expect(result.accessToken).toBe("fresh-access")
        }),
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
      const cache = credentialCache(makeIO(state))
      const result = yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          return yield* Effect.exit(svc.getFresh)
        }),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const errOpt = Cause.findErrorOption(result.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          // The refresh's own reason reaches the caller, with what to do next.
          expect(errOpt.value.message).toContain("OAuth 401 from refresh")
          expect(errOpt.value.message).toContain("choose Claude Code in /auth")
        }
      }
    }),
  )
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
describe("Anthropic credential cache — invalidate", () => {
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
      const cache = credentialCache(makeIO(state))
      yield* runWithTestClock(
        Effect.gen(function* () {
          const svc = yield* cache
          const before = yield* svc.getFresh
          callsRef.current = creds2
          yield* svc.invalidate(before)
          const after = yield* svc.getFresh
          expect(before.accessToken).toBe("k1-access")
          expect(after.accessToken).toBe("k2-access")
        }),
      )
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
// Suppress unused-warning for Layer/Ref imports (intentional helper imports)
void Layer
void Ref

// ── oauth refresh ───────────────────────────────────────────────────────────

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

// ── request signing ─────────────────────────────────────────────────────────

/**
 * Tests for the Claude Code billing-header signing helpers — the
 * algorithm Anthropic's OAuth-billing validator checks against. The
 * placeholder `cch=c5e82` we shipped before this surface tripped the
 * validator on every request, surfacing as `InvalidKey` from the SDK.
 */

// `BunCrypto.layer` hashes synchronously, so each helper can run via
// `Effect.runSync`.
const runSync = <A>(effect: Effect.Effect<A, never, never>): A => Effect.runSync(effect)

const computeCch = (text: string): string =>
  runSync(computeCchEffect(text).pipe(Effect.provide(BunCrypto.layer)))
const computeVersionSuffix = (text: string, version: string): string =>
  runSync(computeVersionSuffixEffect(text, version).pipe(Effect.provide(BunCrypto.layer)))
const buildBillingHeaderValue = (
  messages: Parameters<typeof buildBillingHeaderValueEffect>[0],
  version: string,
  entrypoint: string,
): string =>
  runSync(
    buildBillingHeaderValueEffect(messages, version, entrypoint).pipe(
      Effect.provide(BunCrypto.layer),
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

  test("matches a fixed vector byte for byte", () => {
    const value = buildBillingHeaderValue(
      [{ role: "user", content: "Fix the flaky test in the billing module, please." }],
      "2.1.80",
      "cli",
    )
    expect(value).toBe(
      "x-anthropic-billing-header: cc_version=2.1.80.764; cc_entrypoint=cli; cch=cb258;",
    )
  })

  test("uses the entrypoint verbatim", () => {
    const value = buildBillingHeaderValue([{ role: "user", content: "hi" }], "2.1.80", "test-entry")
    expect(value).toContain("cc_entrypoint=test-entry;")
  })
})

// ── model config ────────────────────────────────────────────────────────────

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
    expect(MODEL_CONFIG.ccVersion).toBe("2.1.280")
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
})

describe("getModelOverride", () => {
  test("haiku family excludes interleaved-thinking", () => {
    const override = getModelOverride("claude-haiku-4-5")
    expect(Option.isSome(override)).toBe(true)
    if (Option.isSome(override)) {
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
    if (Option.isSome(override))
      expect(override.value.exclude).toContain("interleaved-thinking-2025-05-14")
  })
})

describe("getModelBetas", () => {
  test("includes every base beta for a generic sonnet model", () => {
    const betas = getModelBetas("claude-sonnet-4-5", Option.none())
    for (const beta of MODEL_CONFIG.baseBetas) {
      expect(betas).toContain(beta)
    }
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
 * NOT `ctx.home` (the Gent-configured home). The Claude Code credential
 * file is read from `~/.config/claude/.credentials.json` at the real OS
 * home regardless of any `GENT_HOME` override.
 *
 * This is a regression lock: an earlier refactor in W33-C4 briefly used
 * `ctx.home`, which would have redirected credential lookup to the
 * configured Gent home and broken Anthropic OAuth for any setup with a
 * non-default `GENT_HOME`.
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
 * AnthropicExtension model-driver wiring — extension-level regression
 * coverage for `buildAnthropicModelDriver` / `resolveModel`.
 *
 * The leaf-service suites cover services in isolation. Those passed even when two HIGH-severity
 * wiring bugs slipped in:
 *
 *   1. **Cache-Ref lifetime**: `resolveModel` runs once per model resolution.
 *      Allocating `Ref<CredentialCacheCell>` inside
 *      `makeOauthAnthropicLayer` gave each request a fresh empty
 *      cache — credential reuse was silently dead.
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
 * test-owned cell and applies the right keychain transforms (or
 * doesn't, on the API-key branch).
 */
const FUTURE_MS = 1_800_000_000_000
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
const buildAnthropicModelDriver = (
  ...args: Parameters<typeof buildAnthropicModelDriverLive> extends [
    infer CredentialCell,
    infer EnvApiKey,
    ...ReadonlyArray<unknown>,
  ]
    ? [CredentialCell, EnvApiKey]
    : never
) =>
  driverServices(testPlatform).pipe(
    Effect.map((services) => buildAnthropicModelDriverLive(...args, services, testCatalogSource())),
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
          >({
            _tag: "Durable",
            creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
            at: yield* Clock.currentTimeMillis,
            invalidated: false,
          })
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
const JsonRecordSchemaDriver = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type JsonRecordDriver = Schema.Schema.Type<typeof JsonRecordSchemaDriver>
const parsePayload = (body: string): JsonRecordDriver =>
  Schema.decodeSync(JsonRecordSchemaDriver)(body)
describe("buildAnthropicModelDriver — OAuth path uses the external credential cell", () => {
  it.live("OAuth resolveModel layer reads Bearer from credentialCellRef the test owns", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      // Pre-seed the cred Ref directly (test owns it). If
      // `makeOauthAnthropicLayer` regressed to allocating its own internal
      // Ref per call, the
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
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: { accessToken: "t", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
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
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: { accessToken: "first-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
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
        testCatalogSource(),
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
      yield* SynchronizedRef.set(credentialCellRef, {
        _tag: "Durable",
        creds: { accessToken: "held-access", refreshToken: "held-refresh", expiresAt: 0 },
        at: 0,
        invalidated: false,
      })
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        testCatalogSource(),
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
        testCatalogSource(),
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
        testCatalogSource(),
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
      yield* SynchronizedRef.set(credentialCellRef, {
        _tag: "Durable",
        creds: accountB,
        at: 0,
        invalidated: false,
      })
      const driver = buildAnthropicModelDriverLive(
        credentialCellRef,
        Option.none(),
        yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
        testCatalogSource(),
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
        yield* SynchronizedRef.set(credentialCellRef, {
          _tag: "Durable",
          creds: heldCreds,
          at: 0,
          invalidated: false,
        })
        const driver = buildAnthropicModelDriverLive(
          credentialCellRef,
          Option.none(),
          yield* driverServices(AnthropicPlatform.of({ platform: "linux", home, env: {} })),
          testCatalogSource(),
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
        {
          _tag: "Durable",
          creds: { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        },
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
      expect(fetchState.captured.at(-1)!.headers["x-api-key"]).toBe("sk-stored")
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
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
        {
          _tag: "Durable",
          creds: { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        },
      )
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      const model = yield* driver.resolveModel(modelName, authInfo, hints)
      const fetchState = makeFakeFetchState()
      yield* runOne(model, fetchState)
      const body = Option.flatMap(Option.fromUndefinedOr(fetchState.captured.at(-1)), (request) =>
        Option.fromUndefinedOr(request.body),
      )
      return yield* Schema.decodeEffect(SentReasoning)(Option.getOrElse(body, () => "{}"))
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

  // Anthropic answers 400 when a model outside its effort table gets one.
  it.live("a model that takes no effort gets none on either auth path", () =>
    Effect.gen(function* () {
      for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929"]) {
        expect(yield* sentOnBothPaths(model, { reasoning: "high" })).toEqual({})
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
      // Extended-thinking-only models reject adaptive thinking with a 400.
      for (const model of ["claude-opus-4-5", "claude-haiku-4-5", "claude-sonnet-4-5"]) {
        expect((yield* sentOnBothPaths(model, { reasoning: "high" })).thinking).toBeUndefined()
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
      // Thinking cannot be turned off: the lowest effort instead.
      for (const model of [
        "claude-opus-5-5",
        "claude-fable-5",
        "claude-fable-5-1",
        "claude-mythos-5",
      ]) {
        expect(yield* sentOnBothPaths(model, none)).toEqual({ output_config: { effort: "low" } })
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
      expect(yield* temperature("claude-haiku-4-5", { reasoning: "high" })).toBe(0.2)
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
  const sentFor = (
    authInfo: ProviderAuthInfo,
    options: Prompt.ProviderOptions = {},
    after: ReadonlyArray<Prompt.Message> = [],
    system?: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const credentialCellRef = yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(
        {
          _tag: "Durable",
          creds: { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        },
      )
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
      const model = yield* driver.resolveModel("claude-sonnet-4-6", authInfo)
      const state = makeFakeFetchState()
      yield* runCachingRequest(model, state, options, after, system)
      return yield* Schema.decodeEffect(CachedRequest)(
        Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)?.body)),
      )
    })

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
          // The SDK's wrap is the one the compatible drivers build.
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

  // The Claude Code path joins the blocks into the one relocated block.
  it.live("a Claude Code request keeps one relocated system block and its two markers", () =>
    Effect.gen(function* () {
      const request = yield* sentFor(makeOAuthInfo(), {}, [], [sharedPart, agentPart])
      const first = request.messages[0]?.content ?? []
      expect(first.filter(isMarked).map((block) => block.text)).toEqual([
        `${sharedPart}\n\n${agentPart}`,
      ])
      expect(markerCount(request)).toBe(2)
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

  it.live("a later step sends the thinking block back with its signature on both paths", () =>
    Effect.gen(function* () {
      for (const authInfo of [makeApiAuthInfo("sk-test"), makeOAuthInfo()]) {
        const credentialCellRef = yield* SynchronizedRef.make<
          CredentialCacheCell<ClaudeCredentials>
        >({
          _tag: "Durable",
          creds: { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
          at: yield* Clock.currentTimeMillis,
          invalidated: false,
        })
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
        const model = yield* driver.resolveModel("claude-sonnet-4-6", authInfo, {
          reasoning: "high",
        })
        const state = makeFakeFetchState()
        yield* LanguageModel.generateText({
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
        const request = yield* Schema.decodeEffect(ThinkingRequest)(
          Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)?.body)),
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
          const credentialCellRef = yield* SynchronizedRef.make<
            CredentialCacheCell<ClaudeCredentials>
          >({
            _tag: "Durable",
            creds: { accessToken: "sign-in-token", refreshToken: "r", expiresAt: FUTURE_MS },
            at: yield* Clock.currentTimeMillis,
            invalidated: false,
          })
          const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
          const model = yield* driver.resolveModel(modelName, authInfo, hints)
          const state = makeFakeFetchState()
          yield* LanguageModel.generateText({
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
          const request = Option.getOrThrow(Option.fromUndefinedOr(state.captured.at(-1)))
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
  it.live("API-key resolveModel layer sends x-api-key (no Bearer)", () =>
    Effect.gen(function* () {
      const credentialCellRef =
        yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
      const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
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
        const driver = yield* buildAnthropicModelDriver(credentialCellRef, Option.none())
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
