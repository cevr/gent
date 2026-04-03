import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { AgentName } from "@gent/core/domain/agent"
import type { BranchId, SessionId } from "@gent/core/domain/ids"
import { resolveStartupAuthState, type InitialState } from "../src/app-bootstrap"
import { createMockClient } from "./render-harness"

describe("resolveStartupAuthState", () => {
  test("uses the session snapshot agent for interactive startup", async () => {
    const calls: Array<{ agentName?: AgentName }> = []
    const client = createMockClient({
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId: "session-a" as SessionId,
            branchId: "branch-a" as BranchId,
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              phase: "idle" as const,
              status: "idle" as const,
              agent: "deepwork" as AgentName,
              queue: { steering: [], followUp: [] },
            },
          }),
      },
      auth: {
        listProviders: (input: { agentName?: AgentName }) => {
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
        id: "session-a" as SessionId,
        branchId: "branch-a" as BranchId,
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
    expect(calls).toEqual([{ agentName: "deepwork" }])
  })

  test("uses the requested agent for headless auth checks", async () => {
    const calls: Array<{ agentName?: AgentName }> = []
    const client = createMockClient({
      session: {
        getSnapshot: () =>
          Effect.succeed({
            sessionId: "session-a" as SessionId,
            branchId: "branch-a" as BranchId,
            messages: [],
            lastEventId: null,
            reasoningLevel: undefined,
            runtime: {
              phase: "idle" as const,
              status: "idle" as const,
              agent: "cowork" as AgentName,
              queue: { steering: [], followUp: [] },
            },
          }),
      },
      auth: {
        listProviders: (input: { agentName?: AgentName }) => {
          calls.push(input)
          return Effect.succeed([])
        },
      },
    })

    const state: InitialState = {
      _tag: "headless",
      session: {
        id: "session-a" as SessionId,
        branchId: "branch-a" as BranchId,
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
    expect(calls).toEqual([{ agentName: "deepwork" }])
  })
})
