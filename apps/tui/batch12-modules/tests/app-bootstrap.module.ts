import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { ProviderId } from "@gent/core/domain/model"
import { emptyQueueSnapshot } from "@gent/sdk"
import { resolveStartupAuthState, type InitialState } from "../../src/app-bootstrap"
import { createMockClient } from "../../src/../tests/render-harness"
describe("resolveStartupAuthState", () => {
  it.live("uses the session snapshot agent for interactive startup", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: AgentName.make("deepwork"),
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([
              {
                provider: "openai",
                hasKey: false,
                required: true,
                source: "none" as const,
                authType: undefined,
              },
            ])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: 0,
          updatedAt: 0,
          cwd: "/tmp",
          reasoningLevel: undefined,
          parentSessionId: undefined,
          parentBranchId: undefined,
        },
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
        requestedAgent: AgentName.make("cowork"),
      })
      expect(auth.initialAgent).toBe(AgentName.make("deepwork"))
      expect(auth.missingProviders).toEqual([ProviderId.make("openai")])
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("uses the requested agent for headless auth checks", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: AgentName.make("cowork"),
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
      })
      const state: InitialState = {
        _tag: "headless",
        session: {
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: 0,
          updatedAt: 0,
          cwd: "/tmp",
          reasoningLevel: undefined,
          parentSessionId: undefined,
          parentBranchId: undefined,
        },
        prompt: "hi",
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
        requestedAgent: AgentName.make("deepwork"),
      })
      expect(auth.initialAgent).toBeUndefined()
      expect(calls).toEqual([
        { agentName: AgentName.make("deepwork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("falls back to the default agent when a fresh session has no runtime agent yet", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        session: {
          getSnapshot: () =>
            Effect.succeed({
              sessionId: SessionId.make("session-a"),
              branchId: BranchId.make("branch-a"),
              messages: [],
              lastEventId: null,
              reasoningLevel: undefined,
              runtime: {
                _tag: "Idle" as const,
                agent: undefined,
                queue: emptyQueueSnapshot(),
              },
              metrics: {
                turns: 0,
                tokens: 0,
                toolCalls: 0,
                retries: 0,
                durationMs: 0,
                costUsd: 0,
                lastInputTokens: 0,
              },
            }),
        },
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) => {
            calls.push(input)
            return Effect.succeed([])
          },
        },
      })
      const state: InitialState = {
        _tag: "session",
        session: {
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: 0,
          updatedAt: 0,
          cwd: "/tmp",
          reasoningLevel: undefined,
          parentSessionId: undefined,
          parentBranchId: undefined,
        },
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBe(AgentName.make("cowork"))
      expect(calls).toEqual([
        { agentName: AgentName.make("cowork"), sessionId: SessionId.make("session-a") },
      ])
    }),
  )
  it.live("skips pre-auth gating while the user is choosing a branch", () =>
    Effect.gen(function* () {
      const calls: Array<{
        agentName?: AgentName
        sessionId?: string
      }> = []
      const client = createMockClient({
        auth: {
          listProviders: (input: { agentName?: AgentName; sessionId?: string }) =>
            Effect.sync(() => {
              calls.push(input)
              return []
            }),
        },
      })
      const state: InitialState = {
        _tag: "branchPicker",
        session: {
          id: SessionId.make("session-a"),
          branchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: 0,
          updatedAt: 0,
          cwd: "/tmp",
          reasoningLevel: undefined,
          parentSessionId: undefined,
          parentBranchId: undefined,
        },
        branches: [
          {
            id: BranchId.make("branch-a"),
            sessionId: SessionId.make("session-a"),
            createdAt: 0,
          },
          {
            id: BranchId.make("branch-b"),
            sessionId: SessionId.make("session-a"),
            createdAt: 1,
          },
        ],
      }
      const auth = yield* resolveStartupAuthState({
        client,
        state,
      })
      expect(auth.initialAgent).toBeUndefined()
      expect(auth.missingProviders).toEqual([])
      expect(calls).toEqual([])
    }),
  )
})
