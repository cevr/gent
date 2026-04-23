/**
 * Executor integration tests — tool execution with mocked services,
 * and actor lifecycle through MachineEngine.
 */

import { describe, test, expect } from "bun:test"
import { it } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { waitFor } from "@gent/core/test-utils/fixtures"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { ExecutorUiModel } from "@gent/extensions/executor/actor"
import { executorActor } from "@gent/extensions/executor/actor"
import {
  type ExecutorMcpToolResult,
  type ResolvedExecutorSettings,
  ExecutorSettingsDefaults,
  EXECUTOR_EXTENSION_ID,
} from "@gent/extensions/executor/domain"
import { ExecutorMcpBridge } from "@gent/extensions/executor/mcp-bridge"
import { ExecutorSidecar } from "@gent/extensions/executor/sidecar"
import { ExecutorProtocol } from "@gent/extensions/executor/protocol"
import { ExecuteTool, ResumeTool } from "@gent/extensions/executor/tools"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SessionStarted } from "@gent/core/domain/event"
import { defineResource } from "@gent/core/domain/contribution"
import { makeActorRuntimeLayer } from "./helpers/actor-runtime-layer"

// ── Tool test helpers ──

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
      ask: () => Effect.succeed(snapshot as never),
      query: () => Effect.die("not wired"),
      mutate: () => Effect.die("not wired"),
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

// ── Actor lifecycle helpers ──

const sessionId = SessionId.make("test-session")
const branchId = BranchId.make("test-branch")

const mockEndpoint = {
  mode: "local" as const,
  baseUrl: "http://127.0.0.1:4788",
  ownedByGent: true,
  scope: { id: "scope-1", name: "test", dir: "/test" },
}

const mockInspection = {
  instructions: "Use tools.search to discover APIs",
  tools: [{ name: "execute" }],
}

const makeExecutorExtension = (overrides?: {
  sidecar?: Parameters<typeof ExecutorSidecar.Test>[0]
  bridge?: Parameters<typeof ExecutorMcpBridge.Test>[0]
  settings?: Partial<ResolvedExecutorSettings>
}): { extension: LoadedExtension; layer: Layer.Layer<never> } => {
  const settings: ResolvedExecutorSettings = {
    ...ExecutorSettingsDefaults,
    ...overrides?.settings,
  }

  const sidecarLayer = ExecutorSidecar.Test({
    resolveEndpoint: () => Effect.succeed(mockEndpoint),
    resolveSettings: () => Effect.succeed(settings),
    ...overrides?.sidecar,
  })

  const bridgeLayer = ExecutorMcpBridge.Test({
    inspect: () => Effect.succeed(mockInspection),
    ...overrides?.bridge,
  })

  const extension: LoadedExtension = {
    manifest: { id: EXECUTOR_EXTENSION_ID },
    scope: "builtin",
    sourcePath: "builtin",
    contributions: {
      resources: [
        defineResource({
          scope: "process",
          layer: Layer.merge(sidecarLayer, bridgeLayer) as Layer.Layer<never>,
          machine: executorActor,
        }),
      ],
    },
  }

  return { extension, layer: Layer.merge(sidecarLayer, bridgeLayer) as Layer.Layer<never> }
}

const waitForExecutorStatus = (
  runtime: typeof MachineEngine.Type,
  status: ExecutorUiModel["status"],
) =>
  waitFor(
    runtime
      .execute(sessionId, ExecutorProtocol.GetSnapshot.make(), branchId)
      .pipe(Effect.catchEager(() => Effect.succeed(undefined as ExecutorUiModel | undefined))),
    (snap) => (snap as ExecutorUiModel | undefined)?.status === status,
    3_000,
    `executor status = ${status}`,
  ).pipe(Effect.catchEager(() => Effect.succeed(undefined as never)))

// ── Tool tests ──

describe("Executor tools", () => {
  test("execute calls MCP bridge and returns result text", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: (_baseUrl, _code) => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const result = await Effect.runPromise(
      ExecuteTool.effect({ code: "tools.search({ query: 'api' })" }, ctx).pipe(
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
      ExecuteTool.effect({ code: "bad()" }, ctx).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("execute fails when actor not Ready", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: () => Effect.succeed(successResult),
    })
    const ctx = makeToolCtx(notReadySnapshot)

    const exit = await Effect.runPromiseExit(
      ExecuteTool.effect({ code: "x" }, ctx).pipe(Effect.provide(bridgeLayer)),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("execute returns executionId when waiting_for_interaction", async () => {
    const bridgeLayer = ExecutorMcpBridge.Test({
      execute: () => Effect.succeed(waitingResult),
    })
    const ctx = makeToolCtx(readySnapshot)

    const result = await Effect.runPromise(
      ExecuteTool.effect({ code: "api.call()" }, ctx).pipe(Effect.provide(bridgeLayer)),
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
      ResumeTool.effect(
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
      ResumeTool.effect(
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
      ResumeTool.effect(
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

// ── Actor lifecycle ──

describe("Executor actor lifecycle", () => {
  it.live(
    "autoStart=true → Idle → Connecting → Ready",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "ready")

        const model = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(model.status).toBe("ready")
        expect(model.baseUrl).toBe("http://127.0.0.1:4788")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    "autoStart=false → stays Idle",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: false } })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        // autoStart=false means no Connect is sent — actor stays Idle.
        yield* waitForExecutorStatus(runtime, "idle")

        const model = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(model.status).toBe("idle")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    "sidecar failure → Connecting → Error",
    () => {
      const { extension } = makeExecutorExtension({
        sidecar: {
          resolveEndpoint: () => Effect.fail(new Error("port exhausted") as never),
          resolveSettings: () => Effect.succeed(ExecutorSettingsDefaults),
        },
      })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "error")

        const model = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(model.status).toBe("error")
        expect(model.errorMessage).toBeDefined()
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    "/executor-start command → Connecting → Ready",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: false } })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "idle")

        // Verify idle
        const beforeModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(beforeModel.status).toBe("idle")

        // Send Connect command
        yield* runtime.send(sessionId, ExecutorProtocol.Connect.make({ cwd: "/test" }), branchId)

        yield* waitForExecutorStatus(runtime, "ready")

        const afterModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(afterModel.status).toBe("ready")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    "/executor-stop from Ready → Idle",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "ready")

        // Verify ready
        const beforeModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(beforeModel.status).toBe("ready")

        // Send disconnect
        yield* runtime.send(sessionId, ExecutorProtocol.Disconnect.make(), branchId)

        yield* waitForExecutorStatus(runtime, "idle")

        const afterModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(afterModel.status).toBe("idle")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    "/executor-start from Error → Connecting → Ready (retry)",
    () => {
      let callCount = 0
      const { extension } = makeExecutorExtension({
        settings: { autoStart: true },
        sidecar: {
          resolveEndpoint: () => {
            callCount++
            if (callCount === 1) return Effect.fail(new Error("first try fails") as never)
            return Effect.succeed(mockEndpoint)
          },
          resolveSettings: () => Effect.succeed(ExecutorSettingsDefaults),
        },
      })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine

        // First init → autoStart → failure → Error
        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "error")

        const midModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(midModel.status).toBe("error")

        // Retry via command — second call succeeds
        yield* runtime.send(sessionId, ExecutorProtocol.Connect.make({ cwd: "/test" }), branchId)

        yield* waitForExecutorStatus(runtime, "ready")

        const afterModel = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(afterModel.status).toBe("ready")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension] })))
    },
    { timeout: 10_000 },
  )

  it.live(
    ".spawn() internal transitions persist via durability",
    () => {
      const { extension } = makeExecutorExtension({ settings: { autoStart: true } })
      return Effect.gen(function* () {
        const runtime = yield* MachineEngine
        const storage = yield* Storage

        yield* runtime.publish(SessionStarted.make({ sessionId, branchId }), {
          sessionId,
          branchId,
        })

        yield* waitForExecutorStatus(runtime, "ready")

        // Actor should be Ready (onInit → Connect → .spawn → Connected)
        const model = (yield* runtime.execute(
          sessionId,
          ExecutorProtocol.GetSnapshot.make(),
          branchId,
        )) as ExecutorUiModel
        expect(model.status).toBe("ready")

        // Storage should have the Ready state persisted
        const loaded = yield* storage.loadExtensionState({
          sessionId,
          extensionId: EXECUTOR_EXTENSION_ID,
        })
        expect(loaded).toBeDefined()
        expect(loaded!.version).toBeGreaterThanOrEqual(2)
        const parsed = JSON.parse(loaded!.stateJson) as { _tag: string }
        expect(parsed._tag).toBe("Ready")
      }).pipe(Effect.provide(makeActorRuntimeLayer({ extensions: [extension], withStorage: true })))
    },
    { timeout: 10_000 },
  )
})
