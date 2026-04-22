import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AgentName } from "@gent/core/domain/agent"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { resolveStartupAuthState, type InitialState } from "../src/app-bootstrap"
import { createMockClient } from "./render-harness"

describe("resolveStartupAuthState", () => {
  test("uses the session snapshot agent for interactive startup", async () => {
    const calls: Array<{ agentName?: AgentName; sessionId?: string }> = []
    const client = createMockClient({
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId: SessionId.of("session-a"),
            branchId: BranchId.of("branch-a"),
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              _tag: "Idle" as const,
              agent: "deepwork" as AgentName,
              queue: { steering: [], followUp: [] },
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
        id: SessionId.of("session-a"),
        branchId: BranchId.of("branch-a"),
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
            sessionId: SessionId.of("session-a"),
            branchId: BranchId.of("branch-a"),
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              _tag: "Idle" as const,
              agent: "cowork" as AgentName,
              queue: { steering: [], followUp: [] },
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
        id: SessionId.of("session-a"),
        branchId: BranchId.of("branch-a"),
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
        id: SessionId.of("session-a"),
        branchId: BranchId.of("branch-a"),
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
          id: BranchId.of("branch-a"),
          sessionId: SessionId.of("session-a"),
          createdAt: 0,
        },
        {
          id: BranchId.of("branch-b"),
          sessionId: SessionId.of("session-a"),
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
