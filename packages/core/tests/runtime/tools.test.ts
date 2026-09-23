import { describe, expect, it } from "effect-bun-test"
import { Context, Effect, Exit, Layer, Option, Predicate, Schema } from "effect"
import { BunServices } from "@effect/platform-bun"
import { InteractionPendingError } from "../../src/domain/interaction"
import {
  ApprovalService,
  ExtensionRegistry,
  provideCurrentCapabilityContext,
  provideCurrentHostCtx,
  resolveExtensions,
} from "../../src/runtime/extension-host"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  getToolId,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import {
  compileToolPolicy,
  executeToolCalls,
  type ResolvedToolCapability,
  ToolRunner,
  makeTurnInterruption,
  neverInterrupted,
} from "../../src/runtime/tools"
import { RuntimeEnvironment } from "../../src/runtime/config"
import { type AgentEvent, EventPublisher, type ToolCallStarted } from "../../src/domain/event"
import * as Prompt from "effect/unstable/ai/Prompt"
import { createRpcHarness, testToolContext } from "../../src/test-utils/index"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids"
import { test } from "bun:test"
import {
  LanguageModelLayers,
  textStep,
  toolCallStep,
  waitFor,
} from "../../src/test-utils/language-model"
import { messageSingleText } from "../../src/domain/message"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"

// ── tool-runner.test ────────────────────────────────────────────────────────

class ToolProfileToken extends Context.Service<
  ToolProfileToken,
  {
    readonly read: Effect.Effect<string>
  }
>()("@gent/core/tests/runtime/tools.test/ToolProfileToken") {}

interface ToolReadTokenApi {
  readonly read: Effect.Effect<string>
}

class ToolReadToken extends Context.Service<ToolReadToken, ToolReadTokenApi>()(
  "@gent/core/tests/runtime/tools.test/ToolReadToken",
) {}

class ToolWriteToken extends Context.Service<
  ToolWriteToken,
  {
    readonly write: Effect.Effect<string>
  }
>()("@gent/core/tests/runtime/tools.test/ToolWriteToken") {}

class ToolRunnerTestError extends Schema.TaggedError<ToolRunnerTestError>()(
  "@gent/core/tests/runtime/tools.test/ToolRunnerTestError",
  { message: Schema.String },
) {}

const ErrorResult = Schema.Struct({ error: Schema.String })
const errorFromResult = (result: Prompt.ToolResultPart): string =>
  Schema.decodeUnknownSync(ErrorResult)(result.result).error

describe("tool execution", () => {
  const test = it.live.layer(BunServices.layer)

  test("runs model capability directly and returns json output", () =>
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc1")
        return yield* runner
          .run({ toolCallId, toolName: "echo", input: { message: "hello" } })
          .pipe(
            provideCurrentHostCtx(
              testToolContext({
                sessionId: SessionId.make("s"),
                branchId: BranchId.make("b"),
                toolCallId,
                agentName: AgentName.make("cowork"),
              }),
            ),
          )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ echoed: "hello" })
    }))

  test("executes the captured implementation after the registry replaces it", () =>
    Effect.gen(function* () {
      const makeReplacementTool = (value: string) =>
        tool({
          id: "replaceable",
          description: "Replacement probe",
          params: Schema.Struct({}),
          output: Schema.Struct({ value: Schema.String }),
          execute: () => Effect.succeed({ value }),
        })
      const first = makeReplacementTool("A")
      const replacement = makeReplacementTool("B")
      const sessionId = SessionId.make("replacement-session")
      const branchId = BranchId.make("replacement-branch")

      // A registry whose resolution changes mid-test, standing in for a
      // profile refresh. `getResolved` is a thunk, so swapping the cell is
      // enough -- the point is that a captured entry keeps running the
      // implementation it captured, not whatever the registry holds now.
      const resolvedFor = (capability: typeof first) =>
        resolveExtensions([
          {
            manifest: { id: ExtensionId.make("replaceable-owner") },
            scope: "builtin",
            sourcePath: "test",
            contributions: { tools: [capability] },
          },
        ])
      let current = resolvedFor(first)
      const registryLayer = Layer.succeed(
        ExtensionRegistry,
        ExtensionRegistry.of({
          getResolved: () => current,
        }),
      )

      const deps = Layer.mergeAll(
        registryLayer,
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)

      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const captured = yield* runner.capture({ toolName: "replaceable" })
        current = resolvedFor(replacement)

        const run = (toolCallId: string, entry: Option.Option<ResolvedToolCapability>) =>
          runner
            .runBound(
              { toolCallId: ToolCallId.make(toolCallId), toolName: "replaceable", input: {} },
              entry,
            )
            .pipe(
              provideCurrentHostCtx(
                testToolContext({
                  sessionId,
                  branchId,
                  toolCallId: ToolCallId.make(toolCallId),
                  agentName: AgentName.make("cowork"),
                }),
              ),
            )

        const oldTurn = yield* run("replacement-old", captured)
        const currentEntry = yield* runner.capture({ toolName: "replaceable" })
        const currentTurn = yield* run("replacement-current", currentEntry)
        const hiddenTurn = yield* run("replacement-hidden", Option.none<ResolvedToolCapability>())
        const hostEntry = yield* Effect.fromOption(currentEntry)
        const hiddenOuterTurn = yield* executeToolCalls({
          interruption: Effect.never,
          assistantMessageId: MessageId.make("outer-message"),
          sessionId,
          branchId,
          currentTurnAgent: AgentName.make("cowork"),
          toolCalls: [
            Prompt.toolCallPart({
              id: "outer-hidden",
              name: "replaceable",
              params: {},
              providerExecuted: false,
            }),
          ],
          toolBindings: new Map(),
          hostToolBindings: new Map([["replaceable", hostEntry]]),
        }).pipe(provideCurrentHostCtx(testToolContext({ sessionId, branchId })))
        return { oldTurn, currentTurn, hiddenTurn, hiddenOuterTurn }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))

      expect(result.oldTurn.result).toEqual({ value: "A" })
      expect(result.currentTurn.result).toEqual({ value: "B" })
      expect(result.hiddenTurn.isFailure).toBe(true)
      expect(result.hiddenTurn.result).toEqual({ error: "Unknown tool: replaceable" })
      expect(result.hiddenOuterTurn).toMatchObject([
        {
          name: "replaceable",
          isFailure: true,
          result: { error: "Unknown tool: replaceable" },
        },
      ])
    }))

  test("provides host authority through ExtensionContext service", () =>
    Effect.gen(function* () {
      const Output = Schema.Struct({
        sessionId: Schema.String,
        branchId: Schema.String,
        toolCallId: Schema.String,
        hasInteraction: Schema.Boolean,
        hasSessionSend: Schema.Boolean,
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
              hasInteraction: Predicate.isFunction(ctx.Interaction.approve),
              hasSessionSend: Predicate.isFunction(ctx.Session.send),
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-probe")
        const ctx = testToolContext({
          sessionId: SessionId.make("s"),
          branchId: BranchId.make("b"),
          toolCallId,
          agentName: AgentName.make("cowork"),
        })
        return yield* runner
          .run({ toolCallId, toolName: "probe", input: {} })
          .pipe(provideCurrentHostCtx(ctx))
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))

      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        sessionId: "s",
        branchId: "b",
        toolCallId: "tc-probe",
        hasInteraction: true,
        hasSessionSend: true,
      })
    }))
  test("returns error result when tool fails", () =>
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc1")
        return yield* runner.run({ toolCallId, toolName: "fail", input: {} }).pipe(
          provideCurrentHostCtx(
            testToolContext({
              sessionId: SessionId.make("s"),
              branchId: BranchId.make("b"),
              toolCallId,
              agentName: AgentName.make("cowork"),
            }),
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(true)
      const error = errorFromResult(result)
      expect(error).toContain("Tool 'fail' failed")
    }))
  test("returns structured error on invalid input", () =>
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc1")
        return yield* runner.run({ toolCallId, toolName: "strict", input: { path: 42 } }).pipe(
          provideCurrentHostCtx(
            testToolContext({
              sessionId: SessionId.make("s"),
              branchId: BranchId.make("b"),
              toolCallId,
              agentName: AgentName.make("cowork"),
            }),
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(true)
      const error = errorFromResult(result)
      expect(error).toContain("Tool 'strict' input failed:")
      expect(error).toContain("path")
    }))
  test("uses the provided tool context without reconstructing it", () =>
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
              agentName: Option.getOrNull(Option.fromUndefinedOr(ctx.agentName)),
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
        EventPublisher.Test(),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-inspect")
        return yield* runner.run({ toolCallId, toolName: "inspect", input: {} }).pipe(
          provideCurrentHostCtx(
            testToolContext({
              sessionId: SessionId.make("session-inspect"),
              branchId: BranchId.make("branch-inspect"),
              toolCallId,
              agentName: AgentName.make("deepwork"),
              cwd: "/runtime/cwd",
              home: "/runtime/home",
            }),
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        cwd: "/runtime/cwd",
        home: "/runtime/home",
        sessionId: SessionId.make("session-inspect"),
        branchId: BranchId.make("branch-inspect"),
        agentName: AgentName.make("deepwork"),
      })
    }))
  test("provides the selected capability context while executing the tool", () =>
    Effect.gen(function* () {
      const ContextTool = tool({
        id: "context_tool",
        description: "Reads profile-scoped context",
        params: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: () =>
          Effect.gen(function* () {
            const token = yield* ToolProfileToken
            const value = yield* token.read
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const capabilityContext = Context.make(ToolProfileToken, {
        read: Effect.succeed("selected-profile"),
      })
      let erasedCapabilityContext: Context.Context<never> = Context.empty()
      if (Context.isContext(capabilityContext)) erasedCapabilityContext = capabilityContext
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-context")
        return yield* runner.run({ toolCallId, toolName: "context_tool", input: {} }).pipe(
          provideCurrentHostCtx(
            testToolContext({
              sessionId: SessionId.make("session-context"),
              branchId: BranchId.make("branch-context"),
              toolCallId,
              agentName: AgentName.make("cowork"),
            }),
          ),
          provideCurrentCapabilityContext(erasedCapabilityContext),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ value: "selected-profile" })
    }))
  test("read tools execute with ordinary profile Effect services", () =>
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
              readValue: yield* readToken.read,
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
        Layer.succeed(ToolWriteToken, ToolWriteToken.of({ write: Effect.succeed("outer-write") })),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const capabilityContext = Context.empty().pipe(
        Context.add(ToolReadToken, { read: Effect.succeed("read-ok") }),
        Context.add(ToolWriteToken, { write: Effect.succeed("write-leak") }),
      )
      let erasedCapabilityContext: Context.Context<never> = Context.empty()
      if (Context.isContext(capabilityContext)) erasedCapabilityContext = capabilityContext
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-read-context")
        return yield* runner.run({ toolCallId, toolName: "read_context_tool", input: {} }).pipe(
          provideCurrentHostCtx(
            testToolContext({
              sessionId: SessionId.make("session-read-context"),
              branchId: BranchId.make("branch-read-context"),
              toolCallId,
              agentName: AgentName.make("cowork"),
            }),
          ),
          provideCurrentCapabilityContext(erasedCapabilityContext),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({ readValue: "read-ok", writeUnavailable: false })
    }))
  test("readonly tools receive ExtensionContext with denied write facets", () =>
    Effect.gen(function* () {
      const ReadContextTool = tool({
        id: "read_extension_context",
        readonly: true,
        description: "Reads the extension context facade",
        params: Schema.Struct({}),
        output: Schema.Struct({
          sessionId: Schema.String,
          followUpDenied: Schema.Boolean,
          interactionDenied: Schema.Boolean,
        }),
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const followUpExit = yield* Effect.exit(
              ctx.Session.send({ delivery: "queue", sourceId: "read-tool", content: "nope" }),
            )
            const interactionExit = yield* Effect.exit(
              ctx.Interaction.present({ content: "nope", title: "read tool" }),
            )
            return {
              sessionId: ctx.sessionId,
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
        EventPublisher.Test(),
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-read-extension-context")
        return yield* runner
          .run({ toolCallId, toolName: "read_extension_context", input: {} })
          .pipe(
            provideCurrentHostCtx(
              testToolContext({
                sessionId: SessionId.make("session-read-extension-context"),
                branchId: BranchId.make("branch-read-extension-context"),
                toolCallId,
                agentName: AgentName.make("cowork"),
              }),
            ),
          )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result.isFailure).toBe(false)
      expect(result.result).toEqual({
        sessionId: "session-read-extension-context",
        followUpDenied: true,
        interactionDenied: true,
      })
    }))
  test("re-raises interaction pending instead of converting it to a tool result", () =>
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
      const eventTags: Array<string> = []
      const events: Array<ToolCallStarted> = []
      const eventPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: () => Effect.die("append not exercised in ToolRunner tests"),
          deliver: () => Effect.void,
          publish: (event: AgentEvent) =>
            Effect.sync(() => {
              eventTags.push(event._tag)
              if (event._tag === "ToolCallStarted") events.push(event)
            }),
        }),
      )
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
        eventPublisherLayer,
        ApprovalService.Test(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp" }),
      )
      const runnerLayer = ToolRunner.Live.pipe(Layer.provide(deps))
      const layer = Layer.mergeAll(deps, runnerLayer)
      const result = yield* Effect.gen(function* () {
        const runner = yield* ToolRunner
        const toolCallId = ToolCallId.make("tc-pending")
        return yield* Effect.flip(
          runner.run({ toolCallId, toolName: "pending", input: {} }).pipe(
            provideCurrentHostCtx(
              testToolContext({
                sessionId: SessionId.make("session-pending"),
                branchId: BranchId.make("branch-pending"),
                toolCallId,
                agentName: AgentName.make("cowork"),
              }),
            ),
          ),
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
    }))
})

// ── turn-interruption.test ──────────────────────────────────────────────────

describe("turn interruption", () => {
  it.live("a turn is not interrupted before anything interrupts it", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      expect(yield* turn.interrupted).toBe(false)
    }),
  )

  it.live("interrupting the running turn is visible to work that asks", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      expect(yield* turn.interrupted).toBe(true)
    }),
  )

  it.live("the next turn begins uninterrupted", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      yield* turn.beginTurn
      expect(yield* turn.interrupted).toBe(false)
    }),
  )

  it.live("interrupting twice leaves the turn interrupted", () =>
    Effect.gen(function* () {
      const turn = yield* makeTurnInterruption
      yield* turn.interrupt
      yield* turn.interrupt
      expect(yield* turn.interrupted).toBe(true)
    }),
  )

  it.live("branch work with no turn behind it is never interrupted", () =>
    Effect.gen(function* () {
      expect(yield* neverInterrupted.interrupted).toBe(false)
    }),
  )
})

// ── ../extensions/compile-tool-policy.test ──────────────────────────────────

describe("compileToolPolicy", () => {
  const makeTool = (name: string): ToolCapability =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      output: Schema.Null,
      // oxlint-disable-next-line effect/noNullish -- Tool fixture intentionally exercises Schema.Null output.
      execute: () => Effect.succeed(null),
    })

  const makeInteractiveTool = (name: string): ToolCapability =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      output: Schema.Null,
      interactive: true,
      // oxlint-disable-next-line effect/noNullish -- Tool fixture intentionally exercises Schema.Null output.
      execute: () => Effect.succeed(null),
    })

  const allTools = [
    makeTool("read"),
    makeTool("grep"),
    makeTool("glob"),
    makeTool("write"),
    makeTool("edit"),
    makeTool("bash"),
    makeTool("delegate"),
    makeTool("ask_user"),
    makeTool("webfetch"),
    makeTool("websearch"),
    makeTool("lookup"),
  ]

  const names = (tools: ReadonlyArray<ToolCapability>) =>
    tools.map((t) => String(getToolId(t))).sort()

  test("model selection leaves admitted host tools available", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const result = compileToolPolicy(allTools, agent, {}, [{ toolPolicy: { modelSet: ["read"] } }])
    expect(names(result.tools)).toEqual(names(allTools))
    expect(names(result.modelTools)).toEqual(["read"])
    expect(result.modelTools[0]).toBe(allTools[0])
  })

  test("model selection cannot restore unknown, denied, or non-interactive tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), deniedTools: ["bash"] })
    const result = compileToolPolicy(
      [...allTools, makeInteractiveTool("question")],
      agent,
      { interactive: false },
      [{ toolPolicy: { modelSet: ["read", "read", "bash", "question", "missing"] } }],
    )
    expect(names(result.modelTools)).toEqual(["read"])
  })

  test("the last explicit model selection wins and an empty set advertises no tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const result = compileToolPolicy(allTools, agent, {}, [
      { toolPolicy: { modelSet: ["read"] } },
      { toolPolicy: { modelSet: [] } },
      { toolPolicy: { include: ["bash"] } },
    ])
    expect(result.modelTools).toEqual([])
    expect(names(result.tools)).toEqual(names(allTools))
  })

  test("a cell name has no special allowance without an extension policy", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), allowedTools: ["read"] })
    const tools = [makeTool("cell"), ...allTools]
    const direct = compileToolPolicy(tools, agent, {}, [])
    expect(names(direct.modelTools)).toEqual(["read"])
    const selected = compileToolPolicy(tools, agent, {}, [
      { toolPolicy: { include: ["cell"], modelSet: ["cell"] } },
    ])
    expect(names(selected.modelTools)).toEqual(["cell"])
    expect(names(selected.tools)).toEqual(["cell", "read"])
  })

  test("no allow-list → all tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(names(tools)).toEqual(names(allTools))
  })

  test("allowedTools restricts to exact set", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["bash", "read"],
    })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(names(tools)).toEqual(["bash", "read"])
  })

  test("allowedTools: [] means no tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), allowedTools: [] })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(tools).toEqual([])
  })

  test("extension projection include adds tools when they are allowed", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["read", "grep", "lookup"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).toContain("bash")
    expect(names(tools)).toContain("read")
  })

  test("denied tools cannot be re-added by extension projection include", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      deniedTools: ["bash"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).not.toContain("bash")
  })

  test("extension prompt sections collected", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [
      { promptSections: [{ id: "ext-a", content: "Section A", priority: 90 }] },
      { promptSections: [{ id: "ext-b", content: "Section B", priority: 91 }] },
    ]
    const { promptSections } = compileToolPolicy(allTools, agent, {}, projections)
    expect(promptSections).toHaveLength(2)
    expect(promptSections.map((s) => s.id)).toEqual(["ext-a", "ext-b"])
  })

  test("interactive tools filtered when context.interactive is false", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const nonInteractiveTool = makeTool("read")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy(
      [interactiveTool, nonInteractiveTool],
      agent,
      { interactive: false },
      [],
    )
    expect(names(tools)).toEqual(["read"])
    expect(names(tools)).not.toContain("ask_user")
  })

  test("interactive tools remain available when the run is interactive", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy([interactiveTool], agent, {}, [])
    expect(names(tools)).toContain("ask_user")
  })
})

describe("extension model surface over RPC", () => {
  for (const selected of [false, true]) {
    let name = "advertises direct tools without a special case for the cell name"
    if (selected) name = "runs an extension-selected tool with exact admitted bindings"
    it.scopedLive(name, () =>
      Effect.gen(function* () {
        let observedHostTools: ReadonlyArray<string> = []
        const extension = defineExtension({
          id: "test/model-surface",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              AgentDefinition.make({ name: AgentName.make("main"), deniedTools: ["blocked"] }),
            )
            for (const name of ["bridge", "cell", "blocked"]) {
              yield* host.register(
                "tool",
                tool({
                  id: name,
                  description: `Run ${name}`,
                  params: Schema.Struct({ value: Schema.String }),
                  output: Schema.String,
                  execute: ({ value }) => Effect.succeed(`${name}:${value}`),
                }),
              )
            }
            if (selected) {
              yield* host.on("turnProjection", () =>
                Effect.succeed({
                  toolPolicy: { modelSet: ["bridge", "blocked", "missing"] },
                }),
              )
            }
            yield* host.on("systemPrompt", (input) =>
              Effect.sync(() => {
                observedHostTools = input.hostTools?.map(getToolId).sort() ?? []
                return input.basePrompt
              }),
            )
          }),
        })
        const call = toolCallStep("bridge", { value: "kept" })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...call,
            assertOptions: (options) => {
              let expected = ["bridge", "cell"]
              if (selected) expected = ["bridge"]
              expect(
                options.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
              ).toEqual(expected)
            },
          },
          textStep("finished"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [],
          extensionInputs: [extension],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "Use the bridge." })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (messages) =>
            messages.some(
              (message) =>
                message.role === "assistant" && messageSingleText(message.parts) === "finished",
            ),
          3000,
          "bridge reply",
        )
        expect(
          messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result"),
        ).toMatchObject([{ name: "bridge", isFailure: false, result: "bridge:kept" }])
        expect(observedHostTools).toEqual(["bridge", "cell"])
        yield* controls.assertDone
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    )
  }
})
