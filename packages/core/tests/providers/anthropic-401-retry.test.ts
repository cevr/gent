/**
 * 401 retry path for the keychain fetcher.
 *
 * The credential cache TTL is 30s, so a token's last minute can fall
 * inside the cached window — the wire send then 401s on a token the
 * cache still considers fresh. The fetcher recovers by busting the
 * cache (`loader.invalidate()`) and retrying once with the next
 * `loader.load()` reading fresh from keychain or forcing a refresh.
 *
 * Two-callback `AnthropicCredentialLoader` shape: `load` + `invalidate`
 * are independent, so the fetcher composes the cache-bust without
 * threading a `forceRefresh` flag through every layer.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test"
import {
  createAnthropicKeychainFetch,
  type AnthropicCredentialLoader,
  type ClaudeCredentials,
} from "@gent/extensions/anthropic/oauth"

// Effect's FetchHttpClient.Fetch is a Context.Reference whose
// defaultValue captures `globalThis.fetch` once and memoizes it on
// the Reference instance for the lifetime of the process. Per-test
// global swaps won't take effect after the first read.
//
// Workaround: install a stable dispatcher up front that forwards to
// a mutable target. Tests reassign `currentMock` per-case; the
// dispatcher itself stays installed for the process. Critical: the
// default forward is `realFetch` (not a 500 stub), so the dispatcher
// is a transparent passthrough for any other test file that ends up
// calling `fetch` after this file ran. Returning a 500 here leaks
// failures into unrelated suites (e.g. codemode proxy tests that
// fetch a real local HTTP server).
const realFetch = globalThis.fetch
let currentMock: typeof globalThis.fetch = realFetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  currentMock(input, init)) as typeof fetch

afterEach(() => {
  currentMock = realFetch
})

const validCreds: ClaudeCredentials = {
  accessToken: "stale-access",
  refreshToken: "refresh-x",
  expiresAt: Date.now() + 60 * 60 * 1000,
}

const freshCreds: ClaudeCredentials = {
  accessToken: "fresh-access",
  refreshToken: "refresh-x",
  expiresAt: Date.now() + 60 * 60 * 1000,
}

interface MockLoaderState {
  loadCalls: number
  invalidateCalls: number
  current: ClaudeCredentials
}

const makeLoader = (
  state: MockLoaderState,
  onInvalidate: () => void,
): AnthropicCredentialLoader => ({
  load: async () => {
    state.loadCalls += 1
    return state.current
  },
  invalidate: () => {
    state.invalidateCalls += 1
    onInvalidate()
  },
})

interface FetchMockState {
  calls: Array<{ url: string; auth: string | undefined }>
  responder: (call: number) => Response
}

const installFetchMock = (state: FetchMockState): void => {
  const urlOf = (input: RequestInfo | URL): string => {
    if (typeof input === "string") return input
    if (input instanceof URL) return input.toString()
    return input.url
  }
  currentMock = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    state.calls.push({ url: urlOf(input), auth: headers.get("authorization") ?? undefined })
    return Promise.resolve(state.responder(state.calls.length - 1))
  }) as typeof fetch
}

describe("createAnthropicKeychainFetch — 401 retry", () => {
  let loaderState: MockLoaderState
  let fetchState: FetchMockState

  beforeEach(() => {
    loaderState = { loadCalls: 0, invalidateCalls: 0, current: validCreds }
    fetchState = { calls: [], responder: () => new Response("ok", { status: 200 }) }
  })

  test("retries once with fresh creds when first attempt 401s", async () => {
    fetchState.responder = (call) =>
      call === 0
        ? new Response("unauthorized", { status: 401 })
        : new Response("ok", { status: 200 })
    installFetchMock(fetchState)

    const loader = makeLoader(loaderState, () => {
      // Simulate the runtime-boundary cache flushing then the next
      // load() returning a freshly-refreshed token.
      loaderState.current = freshCreds
    })
    const fetcher = createAnthropicKeychainFetch(loader)

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    })

    expect(response.status).toBe(200)
    // Two wire calls: one with stale creds (got 401), one with fresh.
    expect(fetchState.calls).toHaveLength(2)
    expect(fetchState.calls[0]!.auth).toContain("stale-access")
    expect(fetchState.calls[1]!.auth).toContain("fresh-access")
    // Cache bust happened exactly once + load() ran twice (initial +
    // post-invalidate).
    expect(loaderState.invalidateCalls).toBe(1)
    expect(loaderState.loadCalls).toBe(2)
  })

  test("does not retry when first attempt succeeds", async () => {
    fetchState.responder = () => new Response("ok", { status: 200 })
    installFetchMock(fetchState)

    const loader = makeLoader(loaderState, () => {
      loaderState.current = freshCreds
    })
    const fetcher = createAnthropicKeychainFetch(loader)

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    })

    expect(response.status).toBe(200)
    expect(fetchState.calls).toHaveLength(1)
    expect(loaderState.invalidateCalls).toBe(0)
    expect(loaderState.loadCalls).toBe(1)
  })

  test("surfaces the second 401 to the caller (real auth failure, not stale token)", async () => {
    // After cache-bust + re-load + retry, a second 401 means the
    // refreshed token is also rejected — caller needs to see it
    // (revoked session, scope change), not get an infinite loop.
    fetchState.responder = () => new Response("unauthorized", { status: 401 })
    installFetchMock(fetchState)

    const loader = makeLoader(loaderState, () => {
      loaderState.current = freshCreds
    })
    const fetcher = createAnthropicKeychainFetch(loader)

    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    })

    expect(response.status).toBe(401)
    // Exactly two attempts — no third try after the second 401.
    expect(fetchState.calls).toHaveLength(2)
    expect(loaderState.invalidateCalls).toBe(1)
  })
})
