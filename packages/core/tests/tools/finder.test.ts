import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FinderTool } from "@gent/core/tools/finder"
import { Agents, AgentRunnerService } from "@gent/core/domain/agent"
import type { ToolContext } from "@gent/core/domain/tool"
import type { SessionId } from "@gent/core/domain/ids"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const mockRunnerSuccess = Layer.succeed(AgentRunnerService, {
  run: (params) =>
    Effect.succeed({
      _tag: "success" as const,
      text: `response from ${params.agent.name}`,
      sessionId: "child-session" as SessionId,
      agentName: params.agent.name,
    }),
})

const mockRunnerError = Layer.succeed(AgentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
    }),
})

const mockRunnerErrorWithSession = Layer.succeed(AgentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
      sessionId: "error-session" as SessionId,
    }),
})

const TestExtRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

const platformLayer = Layer.mergeAll(BunServices.layer, runtimePlatformLayer, TestExtRegistry)

describe("FinderTool", () => {
  it.live("success → { found: true, response }", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    return FinderTool.execute({ query: "find auth module" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(true)
        expect(result.response).toContain("response from")
      }),
      Effect.provide(layer),
    )
  })

  it.live("error → { found: false, error }", () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(false)
        expect(result.error).toBe("runner failed")
      }),
      Effect.provide(layer),
    )
  })

  it.live("appends session ref to response", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.response).toContain("\n\nFull session: session://child-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("error path includes session ref when sessionId present", () => {
    const layer = Layer.mergeAll(mockRunnerErrorWithSession, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.found).toBe(false)
        expect(result.error).toContain("session://error-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("error path omits session ref when sessionId absent", () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    return FinderTool.execute({ query: "find something" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.error).toBe("runner failed")
        expect(result.error).not.toContain("session://")
      }),
      Effect.provide(layer),
    )
  })
})
