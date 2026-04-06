import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { HandoffTool } from "@gent/core/extensions/handoff-tool"
import { Agents, AgentRunnerService } from "@gent/core/domain/agent"
import type { ToolContext } from "@gent/core/domain/tool"
import type { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

const makeCtx = (approvalService: { present: ToolContext["approve"] }): ToolContext => ({
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
  toolCallId: "test-call" as ToolCallId,
  approve: approvalService.present,
  cwd: "/tmp",
  home: "/tmp",
  extensions: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
  },
})

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
    const layer = Layer.mergeAll(
      mockRunnerSuccess,
      platformLayer,
      ApprovalService.Test([{ approved: true }]),
    )
    return Effect.gen(function* () {
      const approval = yield* ApprovalService
      const ctx = makeCtx({
        present: (params) =>
          approval.present(params, {
            sessionId: "test-session" as SessionId,
            branchId: "test-branch" as BranchId,
          }),
      })

      const result = yield* HandoffTool.execute(
        {
          context: "Current task: implement auth. Key files: src/auth.ts",
          reason: "context window filling up",
        },
        ctx,
      )

      expect(result.handoff).toBe(true)
      expect(result.summary).toContain("implement auth")
      expect(result.parentSessionId).toBe("test-session")
    }).pipe(Effect.provide(layer))
  })

  it.live("returns handoff rejected when user declines", () => {
    const layer = Layer.mergeAll(
      mockRunnerSuccess,
      platformLayer,
      ApprovalService.Test([{ approved: false }]),
    )
    return Effect.gen(function* () {
      const approval = yield* ApprovalService
      const ctx = makeCtx({
        present: (params) =>
          approval.present(params, {
            sessionId: "test-session" as SessionId,
            branchId: "test-branch" as BranchId,
          }),
      })

      const result = yield* HandoffTool.execute(
        {
          context: "Current task: implement auth",
        },
        ctx,
      )

      expect(result.handoff).toBe(false)
      expect(result.reason).toBe("User rejected handoff")
    }).pipe(Effect.provide(layer))
  })
})
