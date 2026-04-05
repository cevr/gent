import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { defineTool } from "@gent/core/domain/tool"
import { Permission, PermissionRule } from "@gent/core/domain/permission"

describe("ToolRunner", () => {
  test("returns error result when tool fails", async () => {
    const FailTool = defineTool({
      name: "fail",
      concurrency: "parallel",
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
            setup: { tools: [FailTool] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
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
      concurrency: "parallel",
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
            setup: { tools: [StrictTool] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
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
      concurrency: "parallel",
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
            setup: { tools: [SafeTool] },
          },
        ]),
      ),
      denyAllPermission,
      ApprovalService.Test(),
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
