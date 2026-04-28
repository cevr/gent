import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Schema } from "effect"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../src/runtime/approval-service"
import { Permission, PermissionRule } from "@gent/core/domain/permission"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import { BranchId, ExtensionId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { AgentName } from "@gent/core/domain/agent"
describe("ToolRunner", () => {
  it.live("runs model capability directly and returns json output", () =>
    Effect.gen(function* () {
      const EchoTool = tool({
        id: "echo",
        description: "Echo input",
        params: Schema.Struct({ message: Schema.String }),
        execute: ({ message }) => Effect.succeed({ echoed: message }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [EchoTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ExtensionRuntime.Test(),
        ActorEngine.Live,
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc1"), toolName: "echo", input: { message: "hello" } },
          testToolContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            toolCallId: ToolCallId.make("tc1"),
            agentName: AgentName.make("cowork"),
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.output.type).toBe("json")
      expect(result.output.value).toEqual({ echoed: "hello" })
    }),
  )
  it.live("returns error result when tool fails", () =>
    Effect.gen(function* () {
      const FailTool = tool({
        id: "fail",
        description: "Fails on purpose",
        params: Schema.Struct({}),
        execute: () => Effect.fail(new Error("boom")),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [FailTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ExtensionRuntime.Test(),
        ActorEngine.Live,
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc1"), toolName: "fail", input: {} },
          testToolContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            toolCallId: ToolCallId.make("tc1"),
            agentName: AgentName.make("cowork"),
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.output.type).toBe("error-json")
      const error =
        (
          result.output.value as {
            error?: string
          }
        ).error ?? ""
      expect(error).toContain("Tool 'fail' failed")
    }),
  )
  it.live("returns structured error on invalid input", () =>
    Effect.gen(function* () {
      const StrictTool = tool({
        id: "strict",
        description: "Requires specific params",
        params: Schema.Struct({ path: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [StrictTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ExtensionRuntime.Test(),
        ActorEngine.Live,
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc1"), toolName: "strict", input: { path: 42 } },
          testToolContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            toolCallId: ToolCallId.make("tc1"),
            agentName: AgentName.make("cowork"),
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.output.type).toBe("error-json")
      const error =
        (
          result.output.value as {
            error?: string
          }
        ).error ?? ""
      expect(error).toContain("Tool 'strict' input failed:")
      expect(error).toContain("path")
    }),
  )
  it.live("returns 'Permission denied' error when tool is denied by permission rules", () =>
    Effect.gen(function* () {
      const SafeTool = tool({
        id: "safe",
        description: "A safe tool",
        params: Schema.Struct({}),
        execute: () => Effect.succeed({ ok: true }),
      })
      const denyAllPermission = Permission.Live(
        [new PermissionRule({ tool: "*", action: "deny" })],
        "allow",
      )
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [SafeTool] },
            },
          ]),
        ),
        denyAllPermission,
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ExtensionRuntime.Test(),
        ActorEngine.Live,
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc1"), toolName: "safe", input: {} },
          testToolContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            toolCallId: ToolCallId.make("tc1"),
            agentName: AgentName.make("cowork"),
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.output.type).toBe("error-json")
      const error =
        (
          result.output.value as {
            error?: string
          }
        ).error ?? ""
      expect(error).toBe("Permission denied")
    }),
  )
  it.live("uses the provided tool context without reconstructing it", () =>
    Effect.gen(function* () {
      const InspectTool = tool({
        id: "inspect",
        description: "Reads the provided execution context",
        params: Schema.Struct({}),
        execute: (_, ctx) =>
          Effect.succeed({
            cwd: ctx.cwd,
            home: ctx.home,
            sessionId: ctx.sessionId,
            branchId: ctx.branchId,
            agentName: ctx.agentName ?? null,
          }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [InspectTool] },
            },
          ]),
        ),
        Permission.Test(),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc-inspect"), toolName: "inspect", input: {} },
          testToolContext({
            sessionId: SessionId.make("session-inspect"),
            branchId: BranchId.make("branch-inspect"),
            toolCallId: ToolCallId.make("tc-inspect"),
            agentName: AgentName.make("deepwork"),
            cwd: "/runtime/cwd",
            home: "/runtime/home",
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.output.type).toBe("json")
      expect(result.output.value).toEqual({
        cwd: "/runtime/cwd",
        home: "/runtime/home",
        sessionId: SessionId.make("session-inspect"),
        branchId: BranchId.make("branch-inspect"),
        agentName: AgentName.make("deepwork"),
      })
    }),
  )
})
