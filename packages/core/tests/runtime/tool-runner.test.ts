import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { InteractionPendingError } from "@gent/core-internal/domain/interaction-request"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { tool, ExtensionContext } from "@gent/core/extensions/api"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ApprovalService } from "../../src/runtime/approval-service"
import { Permission, PermissionRule } from "@gent/core-internal/domain/permission"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import type { ToolCallStarted } from "../../src/domain/event"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { AgentName } from "@gent/core-internal/domain/agent"

class ToolProfileToken extends Context.Service<
  ToolProfileToken,
  {
    readonly read: () => Effect.Effect<string>
  }
>()("@gent/core/tests/runtime/tool-runner.test/ToolProfileToken") {}

interface ToolReadTokenShape {
  readonly read: () => Effect.Effect<string>
}

class ToolReadToken extends Context.Service<ToolReadToken, ToolReadTokenShape>()(
  "@gent/core/tests/runtime/tool-runner.test/ToolReadToken",
) {}

class ToolWriteToken extends Context.Service<
  ToolWriteToken,
  {
    readonly write: () => Effect.Effect<string>
  }
>()("@gent/core/tests/runtime/tool-runner.test/ToolWriteToken") {}

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
        output: Schema.Struct({ echoed: Schema.String }),
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
  it.live("provides host authority through ExtensionContext service", () =>
    Effect.gen(function* () {
      const Output = Schema.Struct({
        sessionId: Schema.String,
        branchId: Schema.String,
        toolCallId: Schema.String,
        hasAgentRun: Schema.Boolean,
        hasSessionDelete: Schema.Boolean,
        hasInteraction: Schema.Boolean,
        hasProcessRun: Schema.Boolean,
      })
      const ProbeTool = tool({
        id: "probe",
        description: "Probe extension context service facets",
        params: Schema.Struct({}),
        output: Output,
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            return {
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              toolCallId: ctx.toolCallId ?? "",
              hasAgentRun: typeof ctx.Agent.run === "function",
              hasSessionDelete: typeof ctx.Session.deleteSession === "function",
              hasInteraction: typeof ctx.Interaction.approve === "function",
              hasProcessRun: typeof ctx.Process.run === "function",
            }
          }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: {
                tools: [ProbeTool],
              },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const ctx = testToolContext({
          sessionId: SessionId.make("s"),
          branchId: BranchId.make("b"),
          toolCallId: ToolCallId.make("tc-probe"),
          agentName: AgentName.make("cowork"),
        })
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc-probe"), toolName: "probe", input: {} },
          ctx,
        )
      }).pipe(Effect.provide(layer))

      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        sessionId: "s",
        branchId: "b",
        toolCallId: "tc-probe",
        hasAgentRun: true,
        hasSessionDelete: true,
        hasInteraction: true,
        hasProcessRun: true,
      })
    }),
  )
  it.live("returns error result when tool fails", () =>
    Effect.gen(function* () {
      const FailTool = tool({
        id: "fail",
        description: "Fails on purpose",
        params: Schema.Struct({}),
        output: Schema.Never,
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
        output: Schema.Struct({ ok: Schema.Boolean }),
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
  it.live("returns structured error when a transformed result violates the output schema", () =>
    Effect.gen(function* () {
      const StrictOutputTool = tool({
        id: "strict_output",
        description: "Requires structured output",
        params: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.succeed({ ok: true }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("tool-owner") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [StrictOutputTool] },
            },
            {
              manifest: { id: ExtensionId.make("result-transformer") },
              scope: "builtin",
              sourcePath: "test",
              contributions: {
                reactions: {
                  toolResult: () => Effect.succeed({ ok: "bad" }),
                },
              },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: ToolCallId.make("tc-output"), toolName: "strict_output", input: {} },
          testToolContext({
            sessionId: SessionId.make("s"),
            branchId: BranchId.make("b"),
            toolCallId: ToolCallId.make("tc-output"),
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
      expect(error).toContain("Tool 'strict_output' failed:")
      expect(error).toContain("ok")
    }),
  )
  it.live("returns 'Permission denied' error when tool is denied by permission rules", () =>
    Effect.gen(function* () {
      const SafeTool = tool({
        id: "safe",
        description: "A safe tool",
        params: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
        output: Schema.Struct({
          cwd: Schema.String,
          home: Schema.String,
          sessionId: Schema.String,
          branchId: Schema.String,
          agentName: Schema.NullOr(Schema.String),
        }),
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            return {
              cwd: ctx.cwd,
              home: ctx.home,
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
              agentName: ctx.agentName ?? null,
            }
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
        output: Schema.Struct({ value: Schema.String }),
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
  it.live("read tools execute with ordinary profile Effect services", () =>
    Effect.gen(function* () {
      const ReadContextTool = tool({
        id: "read_context_tool",
        readonly: true,
        description: "Reads profile-scoped context",
        params: Schema.Struct({}),
        output: Schema.Struct({
          readValue: Schema.String,
          writeUnavailable: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const readToken = yield* ToolReadToken
            const writeToken = yield* Effect.serviceOption(ToolWriteToken)
            return {
              readValue: yield* readToken.read(),
              writeUnavailable: writeToken._tag === "None",
            }
          }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [ReadContextTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        Layer.succeed(ToolWriteToken, { write: () => Effect.succeed("outer-write") }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const capabilityContext = Context.empty().pipe(
        Context.add(ToolReadToken, { read: () => Effect.succeed("read-ok") }),
        Context.add(ToolWriteToken, { write: () => Effect.succeed("write-leak") }),
      ) as Context.Context<never>
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          {
            toolCallId: ToolCallId.make("tc-read-context"),
            toolName: "read_context_tool",
            input: {},
          },
          testToolContext({
            sessionId: SessionId.make("session-read-context"),
            branchId: BranchId.make("branch-read-context"),
            toolCallId: ToolCallId.make("tc-read-context"),
            agentName: AgentName.make("cowork"),
            capabilityContext,
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ readValue: "read-ok", writeUnavailable: false })
    }),
  )
  it.live("readonly tools receive ExtensionContext with denied write facets", () =>
    Effect.gen(function* () {
      const ReadContextTool = tool({
        id: "read_extension_context",
        readonly: true,
        description: "Reads the extension context facade",
        params: Schema.Struct({}),
        output: Schema.Struct({
          sessionId: Schema.String,
          parentEnvEmpty: Schema.Boolean,
          processDenied: Schema.Boolean,
          followUpDenied: Schema.Boolean,
          interactionDenied: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const processExit = yield* Effect.exit(ctx.Process.run("echo", ["hi"]))
            const followUpExit = yield* Effect.exit(
              ctx.Session.queueFollowUp({ sourceId: "read-tool", content: "nope" }),
            )
            const interactionExit = yield* Effect.exit(
              ctx.Interaction.present({ content: "nope", title: "read tool" }),
            )
            return {
              sessionId: ctx.sessionId,
              parentEnvEmpty: Object.keys(ctx.Process.parentEnv).length === 0,
              processDenied: Exit.isFailure(processExit),
              followUpDenied: Exit.isFailure(followUpExit),
              interactionDenied: Exit.isFailure(interactionExit),
            }
          }),
      })
      const deps = Layer.mergeAll(
        ExtensionRegistry.fromResolved(
          resolveExtensions([
            {
              manifest: { id: ExtensionId.make("test") },
              scope: "builtin",
              sourcePath: "test",
              contributions: { tools: [ReadContextTool] },
            },
          ]),
        ),
        Permission.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          {
            toolCallId: ToolCallId.make("tc-read-extension-context"),
            toolName: "read_extension_context",
            input: {},
          },
          testToolContext({
            sessionId: SessionId.make("session-read-extension-context"),
            branchId: BranchId.make("branch-read-extension-context"),
            toolCallId: ToolCallId.make("tc-read-extension-context"),
            agentName: AgentName.make("cowork"),
          }),
        )
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        sessionId: "session-read-extension-context",
        parentEnvEmpty: true,
        processDenied: true,
        followUpDenied: true,
        interactionDenied: true,
      })
    }),
  )
  it.live("re-raises interaction pending instead of converting it to a tool result", () =>
    Effect.gen(function* () {
      const PendingTool = tool({
        id: "pending",
        description: "Requests interaction",
        params: Schema.Struct({}),
        output: Schema.Never,
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            return yield* new InteractionPendingError({
              requestId: InteractionRequestId.make("req-pending"),
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
          }),
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
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
