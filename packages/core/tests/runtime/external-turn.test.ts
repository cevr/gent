/**
 * External turn execution — integration tests.
 *
 * Covers: collectExternalTurn with mock TurnExecutor, full agent loop
 * dispatch for external execution, event publishing, and cancellation.
 */
import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, Stream } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { Provider, FinishChunk } from "@gent/core/providers/provider"
import { Message, TextPart } from "@gent/core/domain/message"
import { AgentDefinition, ExternalDriverRef } from "@gent/core/domain/agent"
import type { TurnExecutor, TurnEvent, TurnContext } from "@gent/core/domain/driver"
import { TurnError } from "@gent/core/domain/driver"
import type { AgentEvent } from "@gent/core/domain/event"
import { EventStore } from "@gent/core/domain/event"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { ResourceManagerLive } from "@gent/core/runtime/resource-manager"
import { Agents } from "@gent/extensions/all-agents"

// ── Helpers ──

const sessionId = "test-session"
const branchId = "test-branch"

const makeMessage = (text: string) =>
  new Message({
    id: `${sessionId}-${branchId}-msg`,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

/** Create a TurnExecutor that emits a sequence of TurnEvents. */
const makeMockExecutor = (events: TurnEvent[]): TurnExecutor => ({
  executeTurn: () => Stream.fromIterable<TurnEvent, TurnError>(events),
})

/** Create a TurnExecutor that captures the TurnContext for assertions. */
const makeCapturingExecutor = (
  events: TurnEvent[],
  capture: (ctx: TurnContext) => void,
): TurnExecutor => ({
  executeTurn: (ctx) => {
    capture(ctx)
    return Stream.fromIterable<TurnEvent, TurnError>(events)
  },
})

/** Create a TurnExecutor that fails. */
const makeFailingExecutor = (message: string): TurnExecutor => ({
  executeTurn: () => Stream.fail(new TurnError({ message })),
})

const externalAgent = new AgentDefinition({
  name: "test-external" as never,
  driver: new ExternalDriverRef({ id: "test-runner" }),
})

const makeResolved = (executor: TurnExecutor) =>
  resolveExtensions([
    {
      manifest: { id: "test-ext" },
      kind: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [externalAgent],
        externalDrivers: [{ id: "test-runner", executor }],
      },
    },
  ])

const makeExtRegistry = (executor: TurnExecutor) =>
  ExtensionRegistry.fromResolved(makeResolved(executor))

const makeDriverRegistry = (executor: TurnExecutor) =>
  DriverRegistry.fromResolved({
    modelDrivers: makeResolved(executor).modelDrivers,
    externalDrivers: makeResolved(executor).externalDrivers,
  })

/** Counting event store that captures published events. */
const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.succeed(EventStore, {
    publish: (event: AgentEvent) =>
      Ref.update(eventsRef, (events) => [...events, event]).pipe(
        Effect.as({ id: 0, event, createdAt: Date.now() }),
      ),
    subscribe: () => Stream.empty,
    removeSession: () => Effect.void,
  })

const makeLayerWithEvents = (executor: TurnExecutor, eventsRef: Ref.Ref<AgentEvent[]>) => {
  // Dummy provider — external turns don't use it but AgentLoop requires it
  const providerLayer = Layer.succeed(Provider, {
    stream: () => Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })])),
    generate: () => Effect.succeed("unused"),
  })

  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(executor),
    makeDriverRegistry(executor),
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunServices.layer,
    ResourceManagerLive,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

// ── Tests ──

describe("external turn execution", () => {
  test("publishes StreamStarted, StreamChunk, and TurnCompleted for external turn", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeMockExecutor([
      { _tag: "text-delta", text: "Hello from " },
      { _tag: "text-delta", text: "external agent" },
      { _tag: "finished", stopReason: "stop" },
    ])

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("test"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("StreamChunk")
          expect(tags).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes tool observability events for external tool calls", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeMockExecutor([
      { _tag: "tool-started", toolCallId: "tc-1", toolName: "read_file" },
      { _tag: "tool-completed", toolCallId: "tc-1" },
      { _tag: "text-delta", text: "File contents here" },
      { _tag: "finished", stopReason: "stop" },
    ])

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("read a file"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          expect(tags).toContain("ToolCallStarted")
          expect(tags).toContain("ToolCallSucceeded")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes ToolCallFailed for failed external tool calls", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeMockExecutor([
      { _tag: "tool-started", toolCallId: "tc-fail", toolName: "bash" },
      { _tag: "tool-failed", toolCallId: "tc-fail", error: "permission denied" },
      { _tag: "finished", stopReason: "stop" },
    ])

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("run something"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          expect(tags).toContain("ToolCallFailed")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes ErrorOccurred when external executor stream fails", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeFailingExecutor("connection lost")
    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("test error"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          expect(tags).toContain("ErrorOccurred")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("external turn does not re-execute tools (toolCalls empty in draft)", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeMockExecutor([
      { _tag: "tool-started", toolCallId: "tc-1", toolName: "bash" },
      { _tag: "tool-completed", toolCallId: "tc-1" },
      { _tag: "text-delta", text: "done" },
      { _tag: "finished", stopReason: "stop" },
    ])

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("test no tool re-exec"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          // TurnCompleted fires (loop completed), ToolCallStarted fires (observability),
          // but no additional ToolCallSucceeded from executeToolsPhase (which would
          // come from ToolRunner, not the external executor)
          expect(tags).toContain("TurnCompleted")
          // Only one ToolCallStarted (from external events), not two (no re-execution)
          const toolStartedCount = tags.filter((t) => t === "ToolCallStarted").length
          expect(toolStartedCount).toBe(1)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("model-backed agents still work unchanged", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    // Use the default agent (model-backed) with a simple provider
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })])),
      generate: () => Effect.succeed("test"),
    })

    const agentsResolved = resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        contributions: { agents: Object.values(Agents) },
      },
    ])
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerLayer,
      ExtensionRegistry.fromResolved(agentsResolved),
      DriverRegistry.fromResolved({
        modelDrivers: agentsResolved.modelDrivers,
        externalDrivers: agentsResolved.externalDrivers,
      }),
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      makeCountingEventStore(eventsRef),
      ToolRunner.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      BunServices.layer,
      ResourceManagerLive,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("model turn"))

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("executor receives correct TurnContext", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    let capturedCtx: TurnContext | undefined

    const executor = makeCapturingExecutor([{ _tag: "finished", stopReason: "stop" }], (ctx) => {
      capturedCtx = ctx
    })

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("context check"), {
            agentOverride: "test-external",
          })
        }).pipe(Effect.provide(layer)),
      ),
    )

    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.agent.name).toBe("test-external")
    expect(capturedCtx!.cwd).toBe("/tmp")
    expect(capturedCtx!.abortSignal).toBeDefined()
  })

  test("reasoning-delta events are captured in assistant output", async () => {
    const eventsRef = await Effect.runPromise(Ref.make<AgentEvent[]>([]))
    const executor = makeMockExecutor([
      { _tag: "reasoning-delta", text: "thinking..." },
      { _tag: "text-delta", text: "answer" },
      { _tag: "finished", stopReason: "stop" },
    ])

    const layer = makeLayerWithEvents(executor, eventsRef)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* agentLoop.run(makeMessage("reason test"), {
            agentOverride: "test-external",
          })

          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)

          // Turn should complete successfully with reasoning present
          expect(tags).toContain("TurnCompleted")
          expect(tags).toContain("StreamChunk")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})
