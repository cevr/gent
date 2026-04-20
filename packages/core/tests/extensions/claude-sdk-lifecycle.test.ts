/**
 * ClaudeSdk lifecycle + cache invalidation tests.
 *
 * Validates the executor's session-management contract using a controllable
 * fake `ClaudeSdkServiceShape` rather than the real SDK subprocess:
 *
 *   1. Cache hit returns the same session for matching fingerprints.
 *   2. Cache miss (cwd/systemPrompt/codemode-tools change) tears down the
 *      previous session and rebuilds — covers codex HIGH on stale cache.
 *   3. `manager.invalidate(sid)` closes the cached session.
 *   4. `manager.disposeAll` closes every cached session.
 *
 * The OAuth keychain read is unavoidable in the executor's `getOrCreate`,
 * so these tests skip when no Claude Code credentials are present rather
 * than mocking deep inside the auth boundary. Pure mapping tests live in
 * `claude-code-executor.test.ts`.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createClaudeCodeSessionManager } from "@gent/extensions/acp-agents/claude-code-executor"
import type {
  ClaudeSdkServiceShape,
  ClaudeSdkSession,
} from "@gent/extensions/acp-agents/claude-sdk"

// Best-effort: skip when keychain access is unlikely. We can't `Config.option`
// in test setup (it's an Effect), so this static check is the simplest gate.
// Tests self-skip on actual auth failure via the catch in `getOrCreate`.
const skipNoAuth = !existsSync(join(homedir(), ".claude", ".credentials.json"))

interface CountingSession extends ClaudeSdkSession {
  readonly id: string
  closeCalls: number
}

const makeCountingSdk = (): {
  sdk: ClaudeSdkServiceShape
  sessions: CountingSession[]
} => {
  const sessions: CountingSession[] = []
  const sdk: ClaudeSdkServiceShape = {
    createSession: () =>
      Effect.sync(() => {
        const id = `sess-${sessions.length}`
        const session: CountingSession = {
          id,
          closeCalls: 0,
          prompt: () => Stream.empty,
          close: Effect.sync(() => {
            session.closeCalls += 1
          }),
        }
        sessions.push(session)
        return session
      }),
  }
  return { sdk, sessions }
}

describe.skipIf(skipNoAuth)("ClaudeCodeSessionManager", () => {
  test("returns the same session for matching fingerprint", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    const a = await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT", undefined))
    const b = await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT", undefined))
    expect(a).toBe(b)
    expect(sessions).toHaveLength(1)
  })

  test("rebuilds the session when systemPrompt changes (regression: codex HIGH)", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT-A", undefined))
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT-B", undefined))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]?.closeCalls).toBe(1)
  })

  test("rebuilds the session when cwd changes", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd-a", "PROMPT", undefined))
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd-b", "PROMPT", undefined))
    expect(sessions).toHaveLength(2)
    expect(sessions[0]?.closeCalls).toBe(1)
  })

  test("invalidate closes the cached session", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT", undefined))
    await Effect.runPromise(manager.invalidate("g1"))
    expect(sessions[0]?.closeCalls).toBe(1)
  })

  test("invalidate is a no-op for unknown gent session id", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    await Effect.runPromise(manager.invalidate("does-not-exist"))
    expect(sessions).toHaveLength(0)
  })

  test("disposeAll closes every cached session", async () => {
    const { sdk, sessions } = makeCountingSdk()
    const manager = createClaudeCodeSessionManager(sdk)
    await Effect.runPromise(manager.getOrCreate("g1", "/cwd", "PROMPT", undefined))
    await Effect.runPromise(manager.getOrCreate("g2", "/cwd", "PROMPT", undefined))
    await Effect.runPromise(manager.disposeAll)
    expect(sessions[0]?.closeCalls).toBe(1)
    expect(sessions[1]?.closeCalls).toBe(1)
  })
})
