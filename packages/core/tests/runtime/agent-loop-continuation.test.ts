import { describe, test, expect } from "bun:test"
import { Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import type { Provider } from "@gent/core/providers/provider"
import { Message, TextPart } from "@gent/core/domain/message"
import { Agents } from "@gent/core/domain/agent"
import { type AnyToolDefinition, defineTool } from "@gent/core/domain/tool"
import { HandoffHandler } from "@gent/core/domain/interaction-handlers"
import {
  BaseEventStore,
  EventStore,
  type AgentEvent,
  type EventEnvelope,
} from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { createSequenceProvider, toolCallStep, textStep } from "@gent/core/debug/provider"
import { BunServices } from "@effect/platform-bun"
import type { MessageId, SessionId, BranchId } from "@gent/core/domain/ids"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "@gent/core/runtime/agent/agent-loop.utils"

const sessionId = "cont-test-session" as SessionId
const branchId = "cont-test-branch" as BranchId

const makeMessage = (text: string) =>
  new Message({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}` as MessageId,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const echoTool = defineTool({
  name: "echo",
  description: "Echoes input",
  params: Schema.Struct({ text: Schema.String }),
  handler: ({ params }) => Effect.succeed({ text: params.text }),
})

const makeExtRegistry = (tools: AnyToolDefinition[] = [echoTool]) =>
  ExtensionRegistry.fromResolved(
    resolveExtensions([
      {
        manifest: { id: "agents" },
        kind: "builtin" as const,
        sourcePath: "test",
        setup: { agents: Object.values(Agents) },
      },
      ...(tools.length > 0
        ? [
            {
              manifest: { id: "tools" },
              kind: "builtin" as const,
              sourcePath: "test",
              setup: { tools },
            },
          ]
        : []),
    ]),
  )

const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.merge(
    Layer.succeed(EventStore, {
      publish: (event: AgentEvent) =>
        Ref.update(eventsRef, (events) => [...events, event]).pipe(
          Effect.as({ id: 0, event, createdAt: Date.now() } as EventEnvelope),
        ),
      subscribe: () => Stream.empty,
      removeSession: () => Effect.void,
    }),
    Layer.succeed(BaseEventStore, {
      publish: (event: AgentEvent) =>
        Ref.update(eventsRef, (events) => [...events, event]).pipe(
          Effect.as({ id: 0, event, createdAt: Date.now() } as EventEnvelope),
        ),
      subscribe: () => Stream.empty,
      removeSession: () => Effect.void,
    }),
  )

const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyToolDefinition[] = [echoTool],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools),
    ExtensionStateRuntime.Test(),
    EventStore.Test(),
    HandoffHandler.Test(),
    ToolRunner.Test(),
    BunServices.layer,
  )
  return Layer.provideMerge(AgentLoop.Live({ baseSections: [] }), deps)
}

const makeLayerWithEvents = (
  providerLayer: Layer.Layer<Provider>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: AnyToolDefinition[] = [echoTool],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools),
    ExtensionStateRuntime.Test(),
    makeCountingEventStore(eventsRef),
    HandoffHandler.Test(),
    ToolRunner.Test(),
    BunServices.layer,
  )
  return Layer.provideMerge(AgentLoop.Live({ baseSections: [] }), deps)
}

describe("Agent loop tool continuation", () => {
  test("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeMessage("test auto-continue"))

        // Should have consumed both steps without external trigger
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))

  test("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        textStep("Just text, no tools."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeMessage("text only"))

        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))

  test("multi-hop: tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeMessage("multi-hop"))

        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))

  test("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop

        yield* agentLoop.run(makeMessage("turn-events"))

        // Verify all 3 steps consumed
        expect(yield* controls.callCount).toBe(3)

        // TurnCompleted should fire once (one turn, multiple steps)
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("interrupt during tool execution stops continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop

        // Start the turn in background
        const fiber = yield* Effect.forkChild(agentLoop.run(makeMessage("interrupt test")))

        // Wait for the continuation stream call to start (step 2)
        yield* controls.waitForCall(1)

        // Interrupt before step 2 emits
        yield* agentLoop.steer({
          _tag: "Interrupt",
          sessionId,
          branchId,
        })

        // Now emit step 2 (will be interrupted)
        yield* controls.emitAll(1)

        yield* Fiber.join(fiber)

        // Both calls started, but turn was interrupted
        expect(yield* controls.callCount).toBe(2)

        // Verify interrupt via TurnCompleted
        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0] as { interrupted?: boolean }
        expect(tc.interrupted).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  // ── Structural guard ──────────────────────────────────────────────────
  // If ToolsFinished ever routes to Finalizing without an interrupt,
  // this test breaks — the second stream call never happens.

  test("GUARD: ToolsFinished without interrupt MUST route to Resolving, not Finalizing", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached — Resolving was entered."),
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeMessage("structural guard"))

        // If ToolsFinished → Finalizing (the old bug), step 2 is never consumed
        // and agentLoop.run would return after step 1 with only 1 call.
        // The continuation path (ToolsFinished → Resolving) consumes step 2.
        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()

        // TurnCompleted fires once — the loop stayed in one turn
        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("GUARD: multi-hop persists distinct assistant + tool-result messages per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* createSequenceProvider([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const msg = makeMessage("multi-hop persistence")

        yield* agentLoop.run(msg)

        // Step 1: assistant + tool-result messages exist
        const a1 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1).toBeDefined()
        expect(t1).toBeDefined()
        expect(a1!.role).toBe("assistant")
        expect(t1!.role).toBe("tool")

        // Step 2: separate assistant + tool-result messages exist
        const a2 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2).toBeDefined()
        expect(t2).toBeDefined()
        expect(a2!.role).toBe("assistant")
        expect(t2!.role).toBe("tool")

        // Step 3 (text-only): assistant exists, no tool-result
        const a3 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3).toBeDefined()
        expect(a3!.role).toBe("assistant")
        expect(t3).toBeUndefined()

        // All IDs are distinct
        expect(new Set([a1!.id, a2!.id, a3!.id]).size).toBe(3)
        expect(new Set([t1!.id, t2!.id]).size).toBe(2)
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))
})
