import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Layer, Schema } from "effect"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { tool } from "@gent/core/extensions/api"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../src/runtime/approval-service"
import { Permission, PermissionRule } from "@gent/core/domain/permission"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import type { ToolCallStarted } from "../../src/domain/event"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids"
import { AgentName } from "@gent/core/domain/agent"

class ToolProfileToken extends Context.Service<
  ToolProfileToken,
  {
    readonly read: () => Effect.Effect<string>
  }
>()("@gent/core/tests/runtime/tool-runner.test/ToolProfileToken") {}

class ToolRunnerTestError extends Schema.TaggedErrorClass<ToolRunnerTestError>()(
  "@gent/core/tests/runtime/tool-runner.test/ToolRunnerTestError",
  { message: Schema.String },
) {}

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
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ echoed: "hello" })
    }),
  )
  it.live("returns error result when tool fails", () =>
    Effect.gen(function* () {
      const FailTool = tool({
        id: "fail",
        description: "Fails on purpose",
        params: Schema.Struct({}),
        execute: () => Effect.fail(new ToolRunnerTestError({ message: "boom" })),
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
      expect(result.isFailure).toBe(true)
      const error =
        (
          result.result as {
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
      expect(result.isFailure).toBe(true)
      const error =
        (
          result.result as {
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
      expect(result.isFailure).toBe(true)
      const error =
        (
          result.result as {
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
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        cwd: "/runtime/cwd",
        home: "/runtime/home",
        sessionId: SessionId.make("session-inspect"),
        branchId: BranchId.make("branch-inspect"),
        agentName: AgentName.make("deepwork"),
      })
    }),
  )
  it.live("provides the selected capability context while executing the tool", () =>
    Effect.gen(function* () {
      const ContextTool = tool({
        id: "context_tool",
        description: "Reads profile-scoped context",
        params: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            const token = yield* ToolProfileToken
            const value = yield* token.read()
            return { value }
          }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [ContextTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const capabilityContext = Context.make(ToolProfileToken, {
        read: () => Effect.succeed("selected-profile"),
      }) as Context.Context<never>
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc-context"), toolName: "context_tool", input: {} },
          testToolContext({
            sessionId: SessionId.make("session-context"),
            branchId: BranchId.make("branch-context"),
            toolCallId: ToolCallId.make("tc-context"),
            agentName: AgentName.make("cowork"),
            capabilityContext,
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ value: "selected-profile" })
    }),
  )
  it.live("re-raises interaction pending instead of converting it to a tool result", () =>
    Effect.gen(function* () {
      const PendingTool = tool({
        id: "pending",
        description: "Requests interaction",
        params: Schema.Struct({}),
        execute: (_, ctx) =>
          Effect.fail(
            new InteractionPendingError({
              requestId: InteractionRequestId.make("req-pending"),
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            }),
          ),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [PendingTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const eventTags: Array<string> = []
      const events: Array<ToolCallStarted> = []
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const registry = yield* ExtensionRegistry
        return yield* Effect.flip(
          runner.run(
            { toolCallId: ToolCallId.make("tc-pending"), toolName: "pending", input: {} },
            testToolContext({
              sessionId: SessionId.make("session-pending"),
              branchId: BranchId.make("branch-pending"),
              toolCallId: ToolCallId.make("tc-pending"),
              agentName: AgentName.make("cowork"),
            }),
            {
              registry,
              publishEvent: (event) =>
                Effect.sync(() => {
                  eventTags.push(event._tag)
                  if (event._tag === "ToolCallStarted") events.push(event)
                }),
            },
          ),
        )
      }).pipe(Effect.provide(layer))
      expect(result).toBeInstanceOf(InteractionPendingError)
      expect(result.requestId).toBe(InteractionRequestId.make("req-pending"))
      expect(result.sessionId).toBe(SessionId.make("session-pending"))
      expect(result.branchId).toBe(BranchId.make("branch-pending"))
      expect(eventTags).toEqual(["ToolCallStarted"])
      expect(events).toEqual([
        expect.objectContaining({
          _tag: "ToolCallStarted",
          sessionId: SessionId.make("session-pending"),
          branchId: BranchId.make("branch-pending"),
          toolCallId: ToolCallId.make("tc-pending"),
          toolName: "pending",
          input: {},
        }),
      ])
    }),
  )
})
