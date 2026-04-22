import { describe, test, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { Permission, PermissionRule } from "@gent/core/domain/permission"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { testToolContext } from "@gent/core/test-utils/extension-harness"

describe("ToolRunner", () => {
  test("runs model capability directly and returns json output", async () => {
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [EchoTool] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      MachineEngine.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "echo", input: { message: "hello" } },
          testToolContext({
            sessionId: "s",
            branchId: "b",
            toolCallId: "tc1",
            agentName: "cowork",
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("json")
    expect(result.output.value).toEqual({ echoed: "hello" })
  })

  test("returns error result when tool fails", async () => {
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [FailTool] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      MachineEngine.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "fail", input: {} },
          testToolContext({
            sessionId: "s",
            branchId: "b",
            toolCallId: "tc1",
            agentName: "cowork",
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool 'fail' failed")
  })

  test("returns structured error on invalid input", async () => {
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [StrictTool] },
          },
        ]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      MachineEngine.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "strict", input: { path: 42 } },
          testToolContext({
            sessionId: "s",
            branchId: "b",
            toolCallId: "tc1",
            agentName: "cowork",
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toContain("Tool 'strict' input failed:")
    expect(error).toContain("path")
  })

  test("returns 'Permission denied' error when tool is denied by permission rules", async () => {
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [SafeTool] },
          },
        ]),
      ),
      denyAllPermission,
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      MachineEngine.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "safe", input: {} },
          testToolContext({
            sessionId: "s",
            branchId: "b",
            toolCallId: "tc1",
            agentName: "cowork",
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("error-json")
    const error = (result.output.value as { error?: string }).error ?? ""
    expect(error).toBe("Permission denied")
  })

  test("uses the provided tool context without reconstructing it", async () => {
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
            manifest: { id: "test" },
            kind: "builtin",
            sourcePath: "test",
            contributions: { capabilities: [InspectTool] },
          },
        ]),
      ),
      Permission.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
    const layer = Layer.mergeAll(deps, runnerLayer)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc-inspect", toolName: "inspect", input: {} },
          testToolContext({
            sessionId: "session-inspect",
            branchId: "branch-inspect",
            toolCallId: "tc-inspect",
            agentName: "deepwork",
            cwd: "/runtime/cwd",
            home: "/runtime/home",
          }),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("json")
    expect(result.output.value).toEqual({
      cwd: "/runtime/cwd",
      home: "/runtime/home",
      sessionId: "session-inspect",
      branchId: "branch-inspect",
      agentName: "deepwork",
    })
  })
})
