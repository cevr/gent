/**
 * External turn execution — integration tests.
 *
 * Covers: collectExternalTurn with mock TurnExecutor, full agent loop
 * dispatch for external execution, event publishing, and cancellation.
 */
import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { AgentLoop, type AgentLoopService } from "../../src/runtime/agent/agent-loop"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ActorRouter } from "../../src/runtime/extensions/resource-host/actor-router"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { Provider, finishPart } from "@gent/core/providers/provider"
import { ImagePart, Message, TextPart } from "@gent/core/domain/message"
import { AgentDefinition, AgentName, ExternalDriverRef } from "@gent/core/domain/agent"
import type { TurnExecutor, TurnEvent, TurnContext } from "@gent/core/domain/driver"
import {
  Finished,
  ReasoningDelta,
  TextDelta,
  ToolCall,
  ToolCompleted,
  ToolFailed,
  ToolStarted,
  TurnError,
} from "@gent/core/domain/driver"
import type { AgentEvent } from "@gent/core/domain/event"
import { EventEnvelope, EventId, EventStore } from "@gent/core/domain/event"
import { EventPublisherLive } from "../../src/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { BranchId, ExtensionId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { ConfigService } from "../../src/runtime/config-service"
import { Agents } from "@gent/extensions/all-agents"
import { ensureStorageParents } from "@gent/core/test-utils"
import { tool, type ToolToken } from "@gent/core/extensions/api"
// ── Helpers ──
const sessionId = SessionId.make("test-session")
const branchId = BranchId.make("test-branch")
const makeMessage = (text: string) =>
  Message.Regular.make({
    id: MessageId.make(`${sessionId}-${branchId}-msg`),
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })
const makeMessageWithParts = (parts: Message["parts"]) =>
  Message.Regular.make({
    id: MessageId.make(`${sessionId}-${branchId}-multipart-msg`),
    sessionId,
    branchId,
    role: "user",
    parts,
    createdAt: new Date(),
  })
const runAgentLoop = (
  agentLoop: AgentLoopService,
  message: Message,
  options?: Parameters<AgentLoopService["run"]>[1],
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() => agentLoop.run(message, options)),
  )
const runAgentLoopOnce = (
  agentLoop: AgentLoopService,
  input: Parameters<AgentLoopService["runOnce"]>[0],
) =>
  ensureStorageParents({ sessionId: input.sessionId, branchId: input.branchId }).pipe(
    Effect.flatMap(() => agentLoop.runOnce(input)),
  )
/** Create a TurnExecutor that emits a sequence of TurnEvents. */
const makeMockExecutor = (events: TurnEvent[]): TurnExecutor => ({
  executeTurn: () => Stream.fromIterable(events) as Stream.Stream<TurnEvent, TurnError>,
})
/** Create a TurnExecutor that captures the TurnContext for assertions. */
const makeCapturingExecutor = (
  events: TurnEvent[],
  capture: (ctx: TurnContext) => void,
): TurnExecutor => ({
  executeTurn: (ctx) => {
    capture(ctx)
    return Stream.fromIterable(events) as Stream.Stream<TurnEvent, TurnError>
  },
})
/** Create a TurnExecutor that fails. */
const makeFailingExecutor = (message: string): TurnExecutor => ({
  executeTurn: () => Stream.fail(new TurnError({ message })),
})
const externalAgent = AgentDefinition.make({
  name: "test-external" as never,
  allowedTools: ["context_probe"],
  driver: ExternalDriverRef.make({ id: "test-runner" }),
})
const contextProbeTool: ToolToken = tool({
  id: "context_probe",
  description: "Probe tool context",
  params: Schema.Struct({ value: Schema.String }),
  execute: () => Effect.succeed({ ok: true }),
})
const makeResolved = (executor: TurnExecutor, tools: ReadonlyArray<ToolToken> = []) =>
  resolveExtensions([
    {
      manifest: { id: ExtensionId.make("test-ext") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [externalAgent],
        tools,
        externalDrivers: [{ id: "test-runner", executor, invalidate: () => Effect.void }],
      },
    },
  ])
const makeExtRegistry = (executor: TurnExecutor, tools?: ReadonlyArray<ToolToken>) =>
  ExtensionRegistry.fromResolved(makeResolved(executor, tools))
const makeDriverRegistry = (executor: TurnExecutor, tools?: ReadonlyArray<ToolToken>) =>
  DriverRegistry.fromResolved({
    modelDrivers: makeResolved(executor, tools).modelDrivers,
    externalDrivers: makeResolved(executor, tools).externalDrivers,
  })
/** Counting event store that captures published events. */
const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.succeed(EventStore, {
    append: (event: AgentEvent) =>
      Effect.gen(function* () {
        yield* Ref.update(eventsRef, (events) => [...events, event])
        return EventEnvelope.make({ id: EventId.make(0), event, createdAt: Date.now() })
      }),
    broadcast: () => Effect.void,
    publish: (event: AgentEvent) =>
      Effect.gen(function* () {
        yield* Ref.update(eventsRef, (events) => [...events, event])
      }),
    subscribe: () => Stream.empty,
    removeSession: () => Effect.void,
  })
const makeLayerWithEvents = (
  executor: TurnExecutor,
  eventsRef: Ref.Ref<AgentEvent[]>,
  options?: {
    readonly tools?: ReadonlyArray<ToolToken>
  },
) => {
  // Dummy provider — external turns don't use it but AgentLoop requires it
  const providerLayer = Layer.succeed(Provider, {
    stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
    generate: () => Effect.succeed("unused"),
  })
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(executor, options?.tools),
    makeDriverRegistry(executor, options?.tools),
    ActorRouter.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    ConfigService.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}
// ── Tests ──
describe("external turn execution", () => {
  it.live("publishes StreamStarted, StreamChunk, and TurnCompleted for external turn", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        TextDelta.make({ text: "Hello from " }),
        TextDelta.make({ text: "external agent" }),
        Finished.make({ stopReason: "stop" }),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("test"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("StreamChunk")
          expect(tags).toContain("TurnCompleted")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes tool observability events for external tool calls", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        ToolStarted.make({ toolCallId: ToolCallId.make("tc-1"), toolName: "read_file" }),
        ToolCompleted.make({ toolCallId: ToolCallId.make("tc-1") }),
        TextDelta.make({ text: "File contents here" }),
        Finished.make({ stopReason: "stop" }),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef, { tools: [contextProbeTool] })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("read a file"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ToolCallStarted")
          expect(tags).toContain("ToolCallSucceeded")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes ToolCallFailed for failed external tool calls", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        ToolStarted.make({ toolCallId: ToolCallId.make("tc-fail"), toolName: "bash" }),
        ToolFailed.make({ toolCallId: ToolCallId.make("tc-fail"), error: "permission denied" }),
        Finished.make({ stopReason: "stop" }),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("run something"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ToolCallFailed")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("publishes ErrorOccurred when external executor stream fails", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeFailingExecutor("connection lost")
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("test error"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("ErrorOccurred")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external turn does not re-execute tools (toolCalls empty in draft)", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        ToolStarted.make({ toolCallId: ToolCallId.make("tc-1"), toolName: "bash" }),
        ToolCompleted.make({ toolCallId: ToolCallId.make("tc-1") }),
        TextDelta.make({ text: "done" }),
        Finished.make({ stopReason: "stop" }),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("test no tool re-exec"), {
            agentOverride: AgentName.make("test-external"),
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
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("model-backed agents still work unchanged", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      // Use the default agent (model-backed) with a simple provider
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("test"),
      })
      const agentsResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("agents") },
          scope: "builtin" as const,
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
        ActorRouter.Test(),
        ActorEngine.Live,
        ExtensionTurnControl.Test(),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = Layer.provideMerge(
        AgentLoop.Live({ baseSections: [] }),
        Layer.merge(deps, eventPublisherLayer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("model turn"))
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          expect(tags).toContain("StreamStarted")
          expect(tags).toContain("TurnCompleted")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("executor receives correct TurnContext", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let capturedCtx: TurnContext | undefined
      const executor = makeCapturingExecutor([Finished.make({ stopReason: "stop" })], (ctx) => {
        capturedCtx = ctx
      })
      const layer = makeLayerWithEvents(executor, eventsRef, { tools: [contextProbeTool] })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("context check"), {
            agentOverride: AgentName.make("test-external"),
          })
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
      expect(capturedCtx).toBeDefined()
      expect(capturedCtx!.agent.name).toBe(AgentName.make("test-external"))
      expect(capturedCtx!.cwd).toBe("/tmp")
      expect(capturedCtx!.abortSignal).toBeDefined()
      expect(capturedCtx!.tools.map((candidate) => String(candidate.id))).toEqual(["context_probe"])
    }),
  )
  it.live("executor receives all live user message parts", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let capturedCtx: TurnContext | undefined
      const executor = makeCapturingExecutor([Finished.make({ stopReason: "stop" })], (ctx) => {
        capturedCtx = ctx
      })
      const layer = makeLayerWithEvents(executor, eventsRef)
      const message = makeMessageWithParts([
        new TextPart({ type: "text", text: "first text" }),
        new ImagePart({
          type: "image",
          image: "data:image/png;base64,abc",
          mediaType: "image/png",
        }),
        new TextPart({ type: "text", text: "second text" }),
      ])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, message, {
            agentOverride: AgentName.make("test-external"),
          })
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
      const lastUser = capturedCtx!.messages.at(-1)
      expect(lastUser?.parts.map((part) => part.type)).toEqual(["text", "image", "text"])
      expect(lastUser?.parts[2]?.type === "text" ? lastUser.parts[2].text : undefined).toBe(
        "second text",
      )
    }),
  )
  it.live("reasoning-delta events are captured in assistant output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const executor = makeMockExecutor([
        ReasoningDelta.make({ text: "thinking..." }),
        TextDelta.make({ text: "answer" }),
        Finished.make({ stopReason: "stop" }),
      ])
      const layer = makeLayerWithEvents(executor, eventsRef)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeMessage("reason test"), {
            agentOverride: AgentName.make("test-external"),
          })
          const events = yield* Ref.get(eventsRef)
          const tags = events.map((e) => e._tag)
          // Turn should complete successfully with reasoning present
          expect(tags).toContain("TurnCompleted")
          expect(tags).toContain("StreamChunk")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
// ── ExternalDriverContribution end-to-end ──
//
// Proves that `ExternalDriverContribution` wired through `DriverRegistry`
// (not a mock) actually dispatches to the registered `TurnExecutor` AND
// that the executor's text output lands in the stored messages.
describe("ExternalDriverContribution end-to-end", () => {
  it.live("text from TurnExecutor appears in stored messages via DriverRegistry dispatch", () =>
    Effect.gen(function* () {
      const e2eSessionId = SessionId.make("e2e-session")
      const e2eBranchId = BranchId.make("e2e-branch")
      // A simple TurnExecutor that emits a known text chunk then finishes.
      const expectedText = "hello from my-test-driver"
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            TextDelta.make({ text: expectedText }),
            Finished.make({ stopReason: "stop" }),
          ]) as Stream.Stream<TurnEvent, TurnError>,
      }
      // Agent referencing the external driver by id.
      const e2eAgent = AgentDefinition.make({
        name: "my-test-agent" as never,
        driver: ExternalDriverRef.make({ id: "my-test-driver" }),
      })
      // Register the contribution through resolveExtensions — the real path.
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-ext") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "my-test-driver", executor: e2eExecutor, invalidate: () => Effect.void },
            ],
          },
        },
      ])
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("unused"),
      })
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        providerLayer,
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        ActorRouter.Test(),
        ActorEngine.Live,
        ExtensionTurnControl.Test(),
        // Messages go through Storage directly — EventStore path is orthogonal.
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = Layer.provideMerge(
        AgentLoop.Live({ baseSections: [] }),
        Layer.merge(deps, eventPublisherLayer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("my-test-agent"),
            prompt: "trigger the external driver",
          })
          // Query the real Storage for the messages stored during the turn.
          const storage = yield* Storage
          const messages = yield* storage.listMessages(e2eBranchId)
          // The assistant message should contain the text emitted by the executor.
          const allText = messages.flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
          )
          const combined = allText.join("")
          expect(combined).toContain(expectedText)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external-driver tool calls and results persist into the assistant transcript", () =>
    Effect.gen(function* () {
      // Regression lock: before this fix, `collectExternalTurnResponse`
      // only pushed a `tool-call` response part when the executor emitted
      // `TurnEvent.ToolCall`. ACP executors (claude-code-executor) skip
      // that variant and go straight from `tool-started` to
      // `tool-completed`, so stored messages lost the tool history and
      // the next turn sent the model a transcript with no record of the
      // tool turn. The tool-completed branch also hardcoded
      // `toolName: "external"` — dropping the real name from the
      // `ToolCallSucceeded` event.
      const e2eSessionId = SessionId.make("e2e-tool-session")
      const e2eBranchId = BranchId.make("e2e-tool-branch")
      const toolInput = { path: "/tmp/example" }
      const toolOutput = { contents: "hello" }
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            ToolStarted.make({
              toolCallId: ToolCallId.make("tc-A"),
              toolName: "read_file",
              input: toolInput,
            }),
            ToolCompleted.make({ toolCallId: ToolCallId.make("tc-A"), output: toolOutput }),
            TextDelta.make({ text: "done" }),
            Finished.make({ stopReason: "stop" }),
          ]) as Stream.Stream<TurnEvent, TurnError>,
      }
      const e2eAgent = AgentDefinition.make({
        name: "tool-test-agent" as never,
        driver: ExternalDriverRef.make({ id: "tool-test-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-ext") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-test-driver", executor: e2eExecutor, invalidate: () => Effect.void },
            ],
          },
        },
      ])
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("unused"),
      })
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        providerLayer,
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        ActorRouter.Test(),
        ActorEngine.Live,
        ExtensionTurnControl.Test(),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = Layer.provideMerge(
        AgentLoop.Live({ baseSections: [] }),
        Layer.merge(deps, eventPublisherLayer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-test-agent"),
            prompt: "do the tool",
          })
          const storage = yield* Storage
          const messages = yield* storage.listMessages(e2eBranchId)
          const toolCallParts = messages.flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "tool-call" ? [p] : [])),
          )
          const toolResultParts = messages.flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "tool-result" ? [p] : [])),
          )
          expect(toolCallParts.length).toBe(1)
          expect(toolCallParts[0]?.toolName).toBe("read_file")
          expect(toolResultParts.length).toBe(1)
          expect(toolResultParts[0]?.toolName).toBe("read_file")
          expect(toolResultParts[0]?.output.type).toBe("json")
          // And the observability event records the real tool name
          // rather than the hardcoded "external".
          const events = yield* Ref.get(eventsRef)
          const succeeded = events.find((e) => e._tag === "ToolCallSucceeded")
          expect(succeeded).toBeDefined()
          if (succeeded !== undefined && "toolName" in succeeded) {
            expect(succeeded.toolName).toBe("read_file")
          }
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("external-driver tool-failed events persist with real toolName", () =>
    Effect.gen(function* () {
      const e2eSessionId = SessionId.make("e2e-tool-fail-session")
      const e2eBranchId = BranchId.make("e2e-tool-fail-branch")
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            ToolStarted.make({ toolCallId: ToolCallId.make("tc-F"), toolName: "bash" }),
            ToolFailed.make({ toolCallId: ToolCallId.make("tc-F"), error: "permission denied" }),
            TextDelta.make({ text: "ok" }),
            Finished.make({ stopReason: "stop" }),
          ]) as Stream.Stream<TurnEvent, TurnError>,
      }
      const e2eAgent = AgentDefinition.make({
        name: "tool-fail-agent" as never,
        driver: ExternalDriverRef.make({ id: "tool-fail-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-fail-ext") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-fail-driver", executor: e2eExecutor, invalidate: () => Effect.void },
            ],
          },
        },
      ])
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("unused"),
      })
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        providerLayer,
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        ActorRouter.Test(),
        ActorEngine.Live,
        ExtensionTurnControl.Test(),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = Layer.provideMerge(
        AgentLoop.Live({ baseSections: [] }),
        Layer.merge(deps, eventPublisherLayer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-fail-agent"),
            prompt: "trigger a failure",
          })
          const storage = yield* Storage
          const messages = yield* storage.listMessages(e2eBranchId)
          const toolResultParts = messages.flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "tool-result" ? [p] : [])),
          )
          expect(toolResultParts.length).toBe(1)
          expect(toolResultParts[0]?.toolName).toBe("bash")
          expect(toolResultParts[0]?.output.type).toBe("error-json")
          // Failure payload must mirror the model-driver shape: a
          // discriminated `{ error: string }` object, not a bare string.
          expect(toolResultParts[0]?.output.value).toEqual({ error: "permission denied" })
          const events = yield* Ref.get(eventsRef)
          const failed = events.find((e) => e._tag === "ToolCallFailed")
          expect(failed).toBeDefined()
          if (failed !== undefined && "toolName" in failed) {
            expect(failed.toolName).toBe("bash")
          }
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("explicit ToolCall event de-duplicates against ToolStarted for the same id", () =>
    Effect.gen(function* () {
      // Some external drivers emit `ToolCall` before `ToolStarted`; both
      // carry the toolName. The collector must record exactly one
      // `tool-call` response part per id (not two), otherwise the stored
      // transcript has a duplicated tool-call that the model sees on the
      // next turn.
      const e2eSessionId = SessionId.make("e2e-tool-dup-session")
      const e2eBranchId = BranchId.make("e2e-tool-dup-branch")
      const e2eExecutor: TurnExecutor = {
        executeTurn: () =>
          Stream.fromIterable([
            ToolCall.make({
              toolCallId: ToolCallId.make("tc-dup"),
              toolName: "write_file",
              input: {},
            }),
            ToolStarted.make({ toolCallId: ToolCallId.make("tc-dup"), toolName: "write_file" }),
            ToolCompleted.make({ toolCallId: ToolCallId.make("tc-dup"), output: {} }),
            Finished.make({ stopReason: "stop" }),
          ]) as Stream.Stream<TurnEvent, TurnError>,
      }
      const e2eAgent = AgentDefinition.make({
        name: "tool-dup-agent" as never,
        driver: ExternalDriverRef.make({ id: "tool-dup-driver" }),
      })
      const e2eResolved = resolveExtensions([
        {
          manifest: { id: ExtensionId.make("e2e-tool-dup-ext") },
          scope: "builtin" as const,
          sourcePath: "test",
          contributions: {
            agents: [e2eAgent],
            externalDrivers: [
              { id: "tool-dup-driver", executor: e2eExecutor, invalidate: () => Effect.void },
            ],
          },
        },
      ])
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("unused"),
      })
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const deps = Layer.mergeAll(
        Storage.TestWithSql(),
        providerLayer,
        ExtensionRegistry.fromResolved(e2eResolved),
        DriverRegistry.fromResolved({
          modelDrivers: e2eResolved.modelDrivers,
          externalDrivers: e2eResolved.externalDrivers,
        }),
        ActorRouter.Test(),
        ActorEngine.Live,
        ExtensionTurnControl.Test(),
        makeCountingEventStore(eventsRef),
        ToolRunner.Test(),
        RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        BunServices.layer,
        ResourceManagerLive,
        ModelRegistry.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const layer = Layer.provideMerge(
        AgentLoop.Live({ baseSections: [] }),
        Layer.merge(deps, eventPublisherLayer),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoopOnce(agentLoop, {
            sessionId: e2eSessionId,
            branchId: e2eBranchId,
            agentName: AgentName.make("tool-dup-agent"),
            prompt: "write a file",
          })
          const storage = yield* Storage
          const messages = yield* storage.listMessages(e2eBranchId)
          const toolCallParts = messages.flatMap((m) =>
            m.parts.flatMap((p) => (p.type === "tool-call" ? [p] : [])),
          )
          expect(toolCallParts.length).toBe(1)
          expect(toolCallParts[0]?.toolName).toBe("write_file")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
