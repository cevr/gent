import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { tool } from "@gent/core/domain/contribution"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { defineTool } from "@gent/core/domain/tool"
import { Permission, PermissionRule } from "@gent/core/domain/permission"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { WorkflowRuntime } from "@gent/core/runtime/extensions/workflow-runtime"

describe("ToolRunner", () => {
  test("returns error result when tool fails", async () => {
    const FailTool = defineTool({
      name: "fail",
      description: "Fails on purpose",
      params: Schema.Struct({}),
      execute: () => Effect.fail(new Error("boom")),
    })

    const deps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [tool(FailTool)] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      WorkflowRuntime.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "fail", input: {} },
          { sessionId: "s", branchId: "b", toolCallId: "tc1", agentName: "cowork" },
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool 'fail' failed")
  })

  test("returns structured error on invalid input", async () => {
    const StrictTool = defineTool({
      name: "strict",
      description: "Requires specific params",
      params: Schema.Struct({ path: Schema.String }),
      execute: () => Effect.succeed({ ok: true }),
    })

    const deps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [tool(StrictTool)] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      WorkflowRuntime.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "strict", input: { path: 42 } },
          { sessionId: "s", branchId: "b", toolCallId: "tc1", agentName: "cowork" },
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool 'strict' input failed:")
    expect(error).toContain("path")
  })

  test("returns 'Permission denied' error when tool is denied by permission rules", async () => {
    const SafeTool = defineTool({
      name: "safe",
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [tool(SafeTool)] },
          },
        ]),
      ),
      denyAllPermission,
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      WorkflowRuntime.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "safe", input: {} },
          { sessionId: "s", branchId: "b", toolCallId: "tc1", agentName: "cowork" },
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toBe("Permission denied")
  })
})
