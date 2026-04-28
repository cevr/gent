/**
 * ClaudeSdk lifecycle + cache invalidation tests.
 *
 * Validates the executor's session-management contract using a controllable
 * fake `ClaudeSdkServiceShape` plus a stub token reader — keeping the
 * tests independent of the macOS keychain so they run in CI. Pure SDK
 * message → TurnEvent mapping tests live in
 * `claude-code-executor.test.ts`.
 *
 *   1. Cache hit returns the same session for matching fingerprints and
 *      reports `created: false`.
 *   2. Cache miss (cwd / systemPrompt / codemode-tools change) tears down
 *      the previous session and rebuilds, reporting `created: true`.
 *   3. Branch + driver are part of the cache key — two branches of the
 *      same gent session, and two drivers serving the same branch, do
 *      not share remote state.
 *   4. `manager.invalidate(key)` closes the cached session.
 *   5. `manager.invalidateDriver(driverId)` closes every cached session
 *      whose key matches the driver.
 *   6. `manager.disposeAll` closes every cached session.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Stream } from "effect"
import { createClaudeCodeSessionManager } from "@gent/extensions/acp-agents/claude-code-executor"
import type { ExternalSessionKey } from "@gent/extensions/acp-agents/executor"
import type {
  ClaudeSdkServiceShape,
  ClaudeSdkSession,
} from "@gent/extensions/acp-agents/claude-sdk"
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
const stubTokenReader = () => Effect.succeed("stub-oauth-token")
const key = (
  sessionId: string,
  branchId = "branch-1",
  driverId = "acp-claude-code",
): ExternalSessionKey => ({ sessionId, branchId, driverId })
describe("ClaudeCodeSessionManager", () => {
  it.live("returns the same session for matching fingerprint", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      const a = yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT", undefined)
      const b = yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT", undefined)
      expect(a.session).toBe(b.session)
      expect(a.created).toBe(true)
      expect(b.created).toBe(false)
      expect(sessions).toHaveLength(1)
    }),
  )
  it.live("rebuilds the session when systemPrompt changes", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT-A", undefined)
      const second = yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT-B", undefined)
      expect(sessions).toHaveLength(2)
      expect(sessions[0]?.closeCalls).toBe(1)
      expect(second.created).toBe(true)
    }),
  )
  it.live("rebuilds the session when cwd changes", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(key("g1"), "/cwd-a", "PROMPT", undefined)
      yield* manager.getOrCreate(key("g1"), "/cwd-b", "PROMPT", undefined)
      expect(sessions).toHaveLength(2)
      expect(sessions[0]?.closeCalls).toBe(1)
    }),
  )
  it.live("two branches of the same gent session do not share remote state", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(key("g1", "branch-1"), "/cwd", "PROMPT", undefined)
      yield* manager.getOrCreate(key("g1", "branch-2"), "/cwd", "PROMPT", undefined)
      expect(sessions).toHaveLength(2)
      // Neither was torn down — they coexist under different cache keys.
      expect(sessions[0]?.closeCalls).toBe(0)
      expect(sessions[1]?.closeCalls).toBe(0)
    }),
  )
  it.live("two drivers serving the same branch do not share remote state", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(
        key("g1", "branch-1", "acp-claude-code"),
        "/cwd",
        "PROMPT",
        undefined,
      )
      yield* manager.getOrCreate(key("g1", "branch-1", "acp-opencode"), "/cwd", "PROMPT", undefined)
      expect(sessions).toHaveLength(2)
      expect(sessions[0]?.closeCalls).toBe(0)
      expect(sessions[1]?.closeCalls).toBe(0)
    }),
  )
  it.live("invalidate closes the cached session", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT", undefined)
      yield* manager.invalidate(key("g1"))
      expect(sessions[0]?.closeCalls).toBe(1)
    }),
  )
  it.live("invalidate is a no-op for unknown key", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.invalidate(key("does-not-exist"))
      expect(sessions).toHaveLength(0)
    }),
  )
  it.live("invalidateDriver closes every session under the given driverId", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(
        key("g1", "branch-1", "acp-claude-code"),
        "/cwd",
        "PROMPT",
        undefined,
      )
      yield* manager.getOrCreate(
        key("g1", "branch-2", "acp-claude-code"),
        "/cwd",
        "PROMPT",
        undefined,
      )
      yield* manager.getOrCreate(key("g1", "branch-1", "acp-opencode"), "/cwd", "PROMPT", undefined)
      yield* manager.invalidateDriver("acp-claude-code")
      expect(sessions[0]?.closeCalls).toBe(1)
      expect(sessions[1]?.closeCalls).toBe(1)
      // The opencode-driven session is untouched.
      expect(sessions[2]?.closeCalls).toBe(0)
    }),
  )
  it.live("disposeAll closes every cached session", () =>
    Effect.gen(function* () {
      const { sdk, sessions } = makeCountingSdk()
      const manager = createClaudeCodeSessionManager(sdk, stubTokenReader)
      yield* manager.getOrCreate(key("g1"), "/cwd", "PROMPT", undefined)
      yield* manager.getOrCreate(key("g2"), "/cwd", "PROMPT", undefined)
      yield* manager.disposeAll
      expect(sessions[0]?.closeCalls).toBe(1)
      expect(sessions[1]?.closeCalls).toBe(1)
    }),
  )
})
