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
import { describe, it, expect } from "bun:test"
import {
  freshEnoughForUse,
  parseOAuthResponse,
  PRIMARY_CLAUDE_SERVICE,
  updateCredentialBlob,
} from "@gent/extensions/anthropic/oauth"

describe("parseOAuthResponse", () => {
  it("parses a well-formed Anthropic refresh response", () => {
    const raw = JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    })
    const now = 1_700_000_000_000
    const creds = parseOAuthResponse(raw, "old-refresh", now)
    expect(creds).toBeDefined()
    expect(creds?.accessToken).toBe("new-access")
    expect(creds?.refreshToken).toBe("new-refresh")
    expect(creds?.expiresAt).toBe(now + 3600 * 1000)
  })

  it("falls back to the caller's refresh token when the response omits one", () => {
    const raw = JSON.stringify({ access_token: "new-access", expires_in: 3600 })
    const creds = parseOAuthResponse(raw, "old-refresh", 0)
    expect(creds?.refreshToken).toBe("old-refresh")
  })

  it("defaults expires_in to 36 000s (10h) when missing", () => {
    const raw = JSON.stringify({ access_token: "new-access" })
    const now = 1_700_000_000_000
    const creds = parseOAuthResponse(raw, "old-refresh", now)
    expect(creds?.expiresAt).toBe(now + 36_000 * 1000)
  })

  it("returns undefined for non-JSON input", () => {
    expect(parseOAuthResponse("not json", "x", 0)).toBeUndefined()
  })

  it("returns undefined when access_token is missing", () => {
    const raw = JSON.stringify({ refresh_token: "x", expires_in: 3600 })
    expect(parseOAuthResponse(raw, "old-refresh", 0)).toBeUndefined()
  })

  it("returns undefined when the body is not an object", () => {
    expect(parseOAuthResponse(JSON.stringify("oops"), "x", 0)).toBeUndefined()
    expect(parseOAuthResponse(JSON.stringify(null), "x", 0)).toBeUndefined()
  })
})

describe("updateCredentialBlob", () => {
  it("rewrites the wrapped `claudeAiOauth` payload preserving sibling fields", () => {
    const existing = JSON.stringify({
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
    expect(next).toBeDefined()
    const parsed = JSON.parse(next ?? "{}") as {
      claudeAiOauth: {
        accessToken: string
        refreshToken: string
        expiresAt: number
        subscriptionType: string
      }
      mcpOAuth: { something: string }
    }
    expect(parsed.claudeAiOauth.accessToken).toBe("new-access")
    expect(parsed.claudeAiOauth.refreshToken).toBe("new-refresh")
    expect(parsed.claudeAiOauth.expiresAt).toBe(9_999)
    expect(parsed.claudeAiOauth.subscriptionType).toBe("max")
    expect(parsed.mcpOAuth.something).toBe("preserve-me")
  })

  it("rewrites a flat payload (no `claudeAiOauth` wrapper)", () => {
    const existing = JSON.stringify({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
    })
    const next = updateCredentialBlob(existing, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 1_234,
    })
    expect(next).toBeDefined()
    const parsed = JSON.parse(next ?? "{}") as {
      accessToken: string
      refreshToken: string
      expiresAt: number
    }
    expect(parsed.accessToken).toBe("new-access")
    expect(parsed.refreshToken).toBe("new-refresh")
    expect(parsed.expiresAt).toBe(1_234)
  })

  it("returns undefined for non-JSON input", () => {
    const next = updateCredentialBlob("not json", {
      accessToken: "x",
      refreshToken: "y",
      expiresAt: 0,
    })
    expect(next).toBeUndefined()
  })
})

describe("PRIMARY_CLAUDE_SERVICE", () => {
  // Counsel K2 — the primary service name was hard-coded inside the
  // module. Exposing it as a named export forces every caller that
  // assumes "the default account" to spell it out, so a future
  // multi-account picker UI can audit-grep all the places that need
  // updating.
  it("is the canonical Claude Code keychain service name", () => {
    expect(PRIMARY_CLAUDE_SERVICE).toBe("Claude Code-credentials")
  })
})

describe("freshEnoughForUse", () => {
  // Counsel HIGH #1 — the gate that decides "use these creds vs.
  // refresh first" must allow at least a 60s safety margin so a token
  // that's about to expire isn't sent on the wire mid-refresh. Note:
  // this only tests the *threshold*, not the integration. The full
  // regression ("refresh returns fresh creds → caller uses them in
  // memory even when write-back failed") is verified at the call
  // sites (runtime-boundary, claude-code-auth, anthropic/index)
  // through code review — none of them re-read keychain after
  // refresh anymore.
  const now = 1_700_000_000_000

  it("returns true when expiry is more than 60s away", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now + 61_000 }, now),
    ).toBe(true)
  })

  it("returns false at exactly the 60s threshold (strict >)", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now + 60_000 }, now),
    ).toBe(false)
  })

  it("returns false when expiry is in the past", () => {
    expect(
      freshEnoughForUse({ accessToken: "a", refreshToken: "r", expiresAt: now - 1 }, now),
    ).toBe(false)
  })
})
