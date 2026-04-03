import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { HandoffTool } from "@gent/core/tools/handoff"
import { Agents, AgentRunnerService } from "@gent/core/domain/agent"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
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

describe("HandoffTool", () => {
  it.live("returns handoff confirmed when user accepts", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["confirm"]))
    return HandoffTool.execute(
      {
        context: "Current task: implement auth. Key files: src/auth.ts",
        reason: "context window filling up",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(true)
        expect(result.summary).toContain("implement auth")
        expect(result.parentSessionId).toBe("test-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("returns handoff rejected when user declines", () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["reject"]))
    return HandoffTool.execute(
      {
        context: "Current task: implement auth",
      },
      ctx,
    ).pipe(
      Effect.map((result) => {
        expect(result.handoff).toBe(false)
        expect(result.reason).toBe("User rejected handoff")
      }),
      Effect.provide(layer),
    )
  })
})
