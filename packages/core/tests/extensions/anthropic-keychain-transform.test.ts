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
import { describe, test, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { buildKeychainTransformClient } from "@gent/extensions/anthropic/keychain-transform"
import { initAnthropicKeychainEnv } from "@gent/extensions/anthropic/oauth"
import type {
  AnthropicCredentialServiceShape,
  AnthropicCredentialIO,
} from "@gent/extensions/anthropic/credential-service"
import { AnthropicCredentialService } from "@gent/extensions/anthropic/credential-service"
import type { ClaudeCredentials } from "@gent/extensions/anthropic/oauth"
import { ProviderAuthError } from "@gent/core/extensions/api"

// ── Helpers ──

// Real Clock here (no TestClock), so expiresAt must be a real future
// Unix-millis timestamp. 10h from real now is comfortably outside the
// 60s freshness margin.
const makeCreds = (label: string): ClaudeCredentials => ({
  accessToken: `${label}-access`,
  refreshToken: `${label}-refresh`,
  expiresAt: Date.now() + 10 * 60 * 60 * 1000,
})

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

interface FakeClientState {
  captured: Array<CapturedRequest>
  responder: (call: number) => Response
}

const makeFakeClient = (state: FakeClientState): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    const headersObj: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headersObj[key] = value
    }
    let bodyText: string | undefined
    if (request.body._tag === "Uint8Array") {
      bodyText = new TextDecoder().decode(request.body.body)
    } else if (request.body._tag === "Raw" && typeof request.body.body === "string") {
      bodyText = request.body.body
    }
    state.captured.push({
      url: request.url,
      method: request.method,
      headers: headersObj,
      body: bodyText,
    })
    const response = state.responder(state.captured.length - 1)
    return Effect.succeed(HttpClientResponse.fromWeb(request, response))
  })

// Capture the credential-service "instance" by running its layer once
// and grabbing the service from context. The transform takes this
// instance directly (closure-based, not yielded from R).
const buildCreds = async (io: AnthropicCredentialIO): Promise<AnthropicCredentialServiceShape> => {
  const layer = AnthropicCredentialService.layerFromIO(io)
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* AnthropicCredentialService
      }).pipe(Effect.provide(layer)),
    ),
  )
}

const validCredsIO = (label: string): AnthropicCredentialIO => ({
  read: Effect.succeed(makeCreds(label)),
  refresh: Effect.fail(new ProviderAuthError({ message: "should not be called" })),
})

// `HttpBody.jsonUnsafe` mirrors how the Anthropic SDK serializes
// outgoing JSON bodies (via `text` → Uint8Array). The transform reads
// the body via `requestBodyText` which decodes that Uint8Array back to
// a string, so this matches production representation.
const jsonBody = (payload: Record<string, unknown>) => HttpBody.jsonUnsafe(payload)

// `Effect.orDie` collapses typed errors to defects so test bodies can
// assert success without `as Effect<unknown, never, never>` casts.
const runOk = <A, E>(eff: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(eff.pipe(Effect.orDie)))

// ── Tests ──

describe("keychainTransformClient — auth headers (Commit 2a)", () => {
  // Reset module env to defaults before each test that touches headers
  // sensitive to env (UA, betas).
  const resetEnv = () => initAnthropicKeychainEnv({})

  test("injects Authorization Bearer from credential service", async () => {
    resetEnv()
    const creds = await buildCreds(validCredsIO("k1"))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildKeychainTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.anthropic.com/v1/messages", {
        body: jsonBody({ model: "claude-opus-4-6" }),
      }),
    )

    expect(fakeState.captured).toHaveLength(1)
    expect(fakeState.captured[0]!.headers["authorization"]).toBe("Bearer k1-access")
  })

  test("removes x-api-key (would otherwise conflict with OAuth Bearer)", async () => {
    resetEnv()
    const creds = await buildCreds(validCredsIO("k1"))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildKeychainTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    // Simulate the SDK's baseline by injecting x-api-key on the
    // outgoing request. The transform must strip it.
    await runOk(
      wrapped.post("https://api.anthropic.com/v1/messages", {
        headers: { "x-api-key": "oauth-placeholder", "anthropic-version": "2023-06-01" },
        body: jsonBody({ model: "claude-opus-4-6" }),
      }),
    )

    expect(fakeState.captured[0]!.headers["x-api-key"]).toBeUndefined()
    // Preserves SDK baseline header
    expect(fakeState.captured[0]!.headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("sets x-app, user-agent, anthropic-dangerous-direct-browser-access", async () => {
    resetEnv()
    const creds = await buildCreds(validCredsIO("k1"))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildKeychainTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    await runOk(
      wrapped.post("https://api.anthropic.com/v1/messages", {
        body: jsonBody({ model: "claude-opus-4-6" }),
      }),
    )

    const headers = fakeState.captured[0]!.headers
    expect(headers["x-app"]).toBe("cli")
    expect(headers["user-agent"]).toMatch(/^claude-cli\/.+ \(external, cli\)$/)
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
  })

  test("merges anthropic-beta with model defaults", async () => {
    resetEnv()
    const creds = await buildCreds(validCredsIO("k1"))
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildKeychainTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    // Body declares claude-opus-4-6, which has model-default betas
    // (base set + 1M-context + effort-2025-11-24 from the override).
    // Incoming "incoming-beta-1" must merge with those, not replace.
    await runOk(
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
  })

  test("credential-service failure surfaces as HttpClientError (transport)", async () => {
    resetEnv()
    const creds = await buildCreds({
      read: Effect.fail(new ProviderAuthError({ message: "no keychain entry" })),
      refresh: Effect.fail(new ProviderAuthError({ message: "no refresh token either" })),
    })
    const fakeState: FakeClientState = {
      captured: [],
      responder: () => new Response("ok", { status: 200 }),
    }
    const transform = buildKeychainTransformClient(creds)
    const wrapped = transform(makeFakeClient(fakeState))

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          wrapped.post("https://api.anthropic.com/v1/messages", {
            body: jsonBody({ model: "claude-opus-4-6" }),
          }),
        ),
      ),
    )

    // The fake client never saw the request — the transform short-
    // circuited at the credential read.
    expect(fakeState.captured).toHaveLength(0)
    expect(exit._tag).toBe("Failure")
  })
})

// Suppress unused-warning for Layer/Ref imports kept for symmetry with
// other test files in this directory.
void Layer
void Ref
