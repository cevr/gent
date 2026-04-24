import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { emptyQueueSnapshot } from "@gent/sdk"
import { resolveStartupAuthState, type InitialState } from "../src/app-bootstrap"
import { createMockClient } from "./render-harness"

describe("resolveStartupAuthState", () => {
  test("uses the session snapshot agent for interactive startup", async () => {
    const calls: Array<{ agentName?: AgentName; sessionId?: string }> = []
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
              agent: "deepwork" as AgentName,
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

    const auth = await Effect.runPromise(
      resolveStartupAuthState({
        client,
        state,
        requestedAgent: "cowork",
      }),
    )

    expect(auth.initialAgent).toBe("deepwork")
    expect(auth.missingProviders).toEqual(["openai"])
    expect(calls).toEqual([{ agentName: "deepwork", sessionId: "session-a" }])
  })

  test("uses the requested agent for headless auth checks", async () => {
    const calls: Array<{ agentName?: AgentName; sessionId?: string }> = []
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
              agent: "cowork" as AgentName,
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

    const auth = await Effect.runPromise(
      resolveStartupAuthState({
        client,
        state,
        requestedAgent: "deepwork",
      }),
    )

    expect(auth.initialAgent).toBeUndefined()
    expect(calls).toEqual([{ agentName: "deepwork", sessionId: "session-a" }])
  })

  test("falls back to the default agent when a fresh session has no runtime agent yet", async () => {
    const calls: Array<{ agentName?: AgentName; sessionId?: string }> = []
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

    const auth = await Effect.runPromise(
      resolveStartupAuthState({
        client,
        state,
      }),
    )

    expect(auth.initialAgent).toBe("cowork")
    expect(calls).toEqual([{ agentName: "cowork", sessionId: "session-a" }])
  })

  test("skips pre-auth gating while the user is choosing a branch", async () => {
    const calls: Array<{ agentName?: AgentName; sessionId?: string }> = []
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

    const auth = await Effect.runPromise(
      resolveStartupAuthState({
        client,
        state,
      }),
    )

    expect(auth.initialAgent).toBeUndefined()
    expect(auth.missingProviders).toEqual([])
    expect(calls).toEqual([])
  })
})
