import { describe, it, expect } from "effect-bun-test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { AgentName } from "@gent/core-internal/domain/agent"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import { dateFromMillis } from "@gent/core-internal/domain/message"
import { ProviderId } from "@gent/core-internal/domain/model"
import { emptyQueueSnapshot, type GentRpcError } from "@gent/sdk"
import {
  AppBootstrapError,
  resolveInitialState,
  resolveStartupAuthState,
  type InitialState,
} from "../src/app-bootstrap"
import { createMockClient } from "./render-harness-boundary"

const expectAppBootstrapFailure = (
  effect: Effect.Effect<unknown, AppBootstrapError | GentRpcError>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return yield* Effect.die("expected app bootstrap failure")
    const reason = exit.cause.reasons.find(Cause.isFailReason)
    if (reason === undefined || !Schema.is(AppBootstrapError)(reason.error)) {
      return yield* Effect.die("expected AppBootstrapError")
    }
    return reason.error
  })

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
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
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
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
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
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
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
          activeBranchId: BranchId.make("branch-a"),
          name: "Session A",
          createdAt: dateFromMillis(0),
          updatedAt: dateFromMillis(0),
          cwd: "/tmp",
          reasoningLevel: undefined,
          parentSessionId: undefined,
          parentBranchId: undefined,
        },
        branches: [
          {
            id: BranchId.make("branch-a"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(0),
          },
          {
            id: BranchId.make("branch-b"),
            sessionId: SessionId.make("session-a"),
            createdAt: dateFromMillis(1),
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

describe("resolveInitialState", () => {
  it.live("fails with typed bootstrap error when headless prompt is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.none(),
          continue_: false,
          headless: true,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("headless-missing-prompt")
    }),
  )

  it.live("fails with typed bootstrap error when requested session is missing", () =>
    Effect.gen(function* () {
      const error = yield* expectAppBootstrapFailure(
        resolveInitialState({
          client: createMockClient(),
          cwd: "/tmp",
          session: Option.some("missing-session"),
          continue_: false,
          headless: false,
          prompt: Option.none(),
          promptArg: Option.none(),
        }),
      )
      expect(error.reason).toBe("session-not-found")
      expect(error.sessionId).toBe(SessionId.make("missing-session"))
    }),
  )
})
