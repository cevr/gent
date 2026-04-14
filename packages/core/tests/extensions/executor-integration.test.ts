/**
 * Executor integration tests — tool execution with mocked services,
 * and actor lifecycle through ExtensionStateRuntime.
 */

import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExecutorUiModel } from "@gent/core/extensions/executor/actor"
import { type ExecutorMcpToolResult } from "@gent/core/extensions/executor/domain"
import { ExecutorMcpBridge } from "@gent/core/extensions/executor/mcp-bridge"
import { ExecuteTool, ResumeTool } from "@gent/core/extensions/executor/tools"

// ── Helpers ──

const readySnapshot: ExecutorUiModel = {
  status: "ready",
  mode: "local",
  baseUrl: "http://127.0.0.1:4788",
}

const notReadySnapshot: ExecutorUiModel = {
  status: "idle",
}

const makeToolCtx = (snapshot: ExecutorUiModel | undefined) =>
  testToolContext({
    extension: {
      send: () => Effect.void,
      ask: () => Effect.die("not wired"),
      getUiSnapshots: () => Effect.succeed([]),
      getUiSnapshot: <T>(_id: string) => Effect.succeed(snapshot as T | undefined),
    },
  })

const successResult: ExecutorMcpToolResult = {
  text: "Hello from Executor",
  structuredContent: { answer: 42 },
  isError: false,
}

const errorResult: ExecutorMcpToolResult = {
  text: "Tool not found: nonexistent",
  structuredContent: null,
  isError: true,
}

const waitingResult: ExecutorMcpToolResult = {
  text: "Waiting for approval",
  structuredContent: null,
  isError: false,
  executionId: "exec-abc-123",
}

// ── Tool tests ──

describe("Executor tools", () => {
  test("execute calls MCP bridge and returns result text", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: (_baseUrl, _code) => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const result = await Effect.runPromise(
      ExecuteTool.execute({ code: "tools.search({ query: 'api' })" }, ctx).pipe(
        Effect.provide(bridgeLayer),
      ),
    )

    expect(result.text).toBe("Hello from Executor")
    expect(result.structuredContent).toEqual({ answer: 42 })
  })

  test("execute Effect.fails when MCP returns isError: true", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: () => Effect.succeed(errorResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const exit = await Effect.runPromiseExit(
      ExecuteTool.execute({ code: "bad()" }, ctx).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("execute fails when actor not Ready", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: () => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(notReadySnapshot)

    const exit = await Effect.runPromiseExit(
      ExecuteTool.execute({ code: "x" }, ctx).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("execute returns executionId when waiting_for_interaction", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: () => Effect.succeed(waitingResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const result = await Effect.runPromise(
      ExecuteTool.execute({ code: "api.call()" }, ctx).pipe(Effect.provide(bridgeLayer)),
    )

    expect(result.executionId).toBe("exec-abc-123")
    expect(result.text).toBe("Waiting for approval")
  })

  test("resume calls MCP bridge with parsed content", async () => {
    const captured: { executionId: string; action: string; content?: Record<string, unknown> }[] =
      []
    const bridgeLayer = ExecutorMcpBridge.Test({
      resume: (_baseUrl, executionId, action, content) => {
        captured.push({ executionId, action, content })
        return Effect.succeed(successResult)
      },
    })
    const ctx = makeToolCtx(readySnapshot)

    await Effect.runPromise(
      ResumeTool.execute(
        {
          executionId: "exec-1",
          action: "accept" as "accept" | "decline" | "cancel",
          content: '{"approved": true}',
        },
        ctx,
      ).pipe(Effect.provide(bridgeLayer)),
    )

    expect(captured).toHaveLength(1)
    expect(captured[0]!.executionId).toBe("exec-1")
    expect(captured[0]!.action).toBe("accept")
    expect(captured[0]!.content).toEqual({ approved: true })
  })

  test("resume fails with invalid JSON content", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      resume: () => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const exit = await Effect.runPromiseExit(
      ResumeTool.execute(
        {
          executionId: "exec-1",
          action: "accept" as "accept" | "decline" | "cancel",
          content: "not valid json{{{",
        },
        ctx,
      ).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("resume fails when actor not Ready", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      resume: () => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(notReadySnapshot)

    const exit = await Effect.runPromiseExit(
      ResumeTool.execute(
        {
          executionId: "exec-1",
          action: "decline" as "accept" | "decline" | "cancel",
        },
        ctx,
      ).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })
})
