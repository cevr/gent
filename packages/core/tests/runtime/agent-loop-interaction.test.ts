import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import {
  Provider,
  ToolCallChunk,
  FinishChunk,
  TextChunk,
  type StreamChunk,
} from "@gent/core/providers/provider"
import { Message, TextPart } from "@gent/core/domain/message"
import { Agents } from "@gent/core/domain/agent"
import { defineTool, type AnyToolDefinition, type ToolContext } from "@gent/core/domain/tool"
import { EventStore } from "@gent/core/domain/event"
import { Permission } from "@gent/core/domain/permission"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore } from "@gent/core/test-utils"
import { BunServices } from "@effect/platform-bun"
import type { BranchId, SessionId, ToolCallId } from "@gent/core/domain/ids"

// ============================================================================
// Test fixtures
// ============================================================================

const sessionId = "s-interaction" as SessionId
const branchId = "b-interaction" as BranchId

const makeMessage = (text: string) =>
  new Message({
    id: `msg-${text}`,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const makeExtRegistry = (tools: AnyToolDefinition[] = []) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "test-agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        setup: { agents: Object.values(Agents), tools },
      },
    ]),
  )

/**
 * Tool that triggers InteractionPendingError on first call,
 * then succeeds on subsequent calls (simulating cold resumption).
 */
const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
  defineTool({
    name: "interaction-tool",
    action: "interact" as const,
    description: "Tool that triggers an interaction",
    concurrency: "serial",
    params: Schema.Struct({ value: Schema.String }),
    execute: (params: { value: string }, ctx: ToolContext) =>
      Effect.gen(function* () {
        const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
        if (count === 0) {
          // First call: trigger interaction pending
          return yield* Effect.fail(
            new InteractionPendingError("req-test-1", "prompt", ctx.sessionId, ctx.branchId),
          )
        }
        // Subsequent calls: interaction resolved, succeed
        yield* Deferred.succeed(resolution, void 0)
        return { resolved: true, value: params.value }
      }),
  })

const providerWithToolCall = (toolName: string): Layer.Layer<Provider> =>
  Layer.succeed(Provider, {
    stream: () =>
      Effect.succeed(
        Stream.fromIterable([
          new ToolCallChunk({
            toolCallId: "tc-1" as ToolCallId,
            toolName,
            input: { value: "test" },
          }),
          new FinishChunk({ finishReason: "tool_calls" }),
          // Second turn after tool result — just text
          new TextChunk({ text: "done" }),
          new FinishChunk({ finishReason: "stop" }),
        ] satisfies StreamChunk[]),
      ),
    generate: () => Effect.succeed("test"),
  })

// ============================================================================
// Tests
// ============================================================================

describe("Cold interaction lifecycle", () => {
  test("tool triggers InteractionPendingError → machine parks in WaitingForInteraction", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const tool = makeInteractionTool(callCount, resolution)

    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerWithToolCall(tool.name),
      makeExtRegistry([tool]),
      ExtensionStateRuntime.Test(),
      HandoffHandler.Test(),
      Permission.Live([], "allow"),
      BunServices.layer,
      recorderLayer,
      eventStoreLayer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const loopLayer = Layer.provideMerge(AgentLoop.Live({ baseSections: [] }), deps)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          // Submit message — will stream, get tool call, execute tool, hit InteractionPendingError
          const fiber = yield* Effect.forkChild(agentLoop.run(makeMessage("trigger interaction")))

          // Wait for the machine to park in WaitingForInteraction
          yield* Effect.sleep("200 millis")

          const state = yield* agentLoop.getState({ sessionId, branchId })
          expect(state.phase).toBe("waiting-for-interaction")
          expect(state.status).toBe("running")

          // Tool was called exactly once (the first call that threw)
          expect(Ref.getUnsafe(callCount)).toBe(1)

          // Verify events were published
          const calls = yield* recorder.getCalls()
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "publish")
            .map((c) => (c.args as { _tag: string })._tag)
          expect(eventTags).toContain("ToolCallStarted")

          // Now respond — store resolution + wake machine
          yield* agentLoop.respondInteraction({ sessionId, branchId, requestId: "req-test-1" })

          // Wait for the tool to be called again and resolve
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))

          // Tool was called a second time (resumed)
          expect(Ref.getUnsafe(callCount)).toBe(2)

          // Wait for turn to complete
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(loopLayer)),
      ),
    )
  })

  test("interrupt during WaitingForInteraction → finalizes turn", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const tool = makeInteractionTool(callCount, resolution)

    const baseDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerWithToolCall(tool.name),
      makeExtRegistry([tool]),
      ExtensionStateRuntime.Test(),
      EventStore.Test(),
      HandoffHandler.Test(),
      Permission.Live([], "allow"),
      BunServices.layer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const loopLayer = Layer.provideMerge(AgentLoop.Live({ baseSections: [] }), deps)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          // Submit and wait for WaitingForInteraction
          const fiber = yield* Effect.forkChild(agentLoop.run(makeMessage("interrupt test")))
          yield* Effect.sleep("200 millis")

          const stateBefore = yield* agentLoop.getState({ sessionId, branchId })
          expect(stateBefore.phase).toBe("waiting-for-interaction")

          // Interrupt
          yield* agentLoop.steer({
            _tag: "Interrupt",
            sessionId,
            branchId,
          })

          // Wait for turn to complete (should finalize without re-running tool)
          yield* Fiber.join(fiber)

          const stateAfter = yield* agentLoop.getState({ sessionId, branchId })
          expect(stateAfter.phase).toBe("idle")

          // Tool was called only once (no resume after interrupt)
          expect(Ref.getUnsafe(callCount)).toBe(1)
        }).pipe(Effect.provide(loopLayer)),
      ),
    )
  })

  test("respondInteraction is no-op when machine not in WaitingForInteraction", async () => {
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      Layer.succeed(Provider, {
        stream: () =>
          Effect.succeed(
            Stream.fromIterable([
              new TextChunk({ text: "hello" }),
              new FinishChunk({ finishReason: "stop" }),
            ]),
          ),
        generate: () => Effect.succeed("test"),
      }),
      makeExtRegistry(),
      ExtensionStateRuntime.Test(),
      EventStore.Test(),
      HandoffHandler.Test(),
      ToolRunner.Test(),
      BunServices.layer,
    )
    const loopLayer = Layer.provideMerge(AgentLoop.Live({ baseSections: [] }), deps)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          // Complete a normal turn
          yield* agentLoop.run(makeMessage("no interaction"))

          // respondInteraction should be a no-op (machine is Idle)
          yield* agentLoop.respondInteraction({
            sessionId,
            branchId,
            requestId: "nonexistent",
          })

          const state = yield* agentLoop.getState({ sessionId, branchId })
          expect(state.phase).toBe("idle")
        }).pipe(Effect.provide(loopLayer)),
      ),
    )
  })
})
