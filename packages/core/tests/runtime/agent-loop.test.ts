import { describe, expect, test } from "bun:test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentLoop } from "@gent/core/runtime/agent/agent-loop"
import { ResourceManagerLive } from "@gent/core/runtime/resource-manager"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import {
  Provider,
  ProviderError,
  FinishChunk,
  TextChunk,
  ToolCallChunk,
  type StreamChunk,
} from "@gent/core/providers/provider"
import { Branch, Message, Session, TextPart, ToolResultPart } from "@gent/core/domain/message"
import { Agents } from "@gent/extensions/all-agents"
import { type ToolContext } from "@gent/core/domain/tool"
import { tool, type AnyCapabilityContribution } from "@gent/core/extensions/api"
import { Permission } from "@gent/core/domain/permission"
import { EventStore, type AgentEvent, type EventEnvelope } from "@gent/core/domain/event"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore } from "@gent/core/test-utils"
import { toolCallStep, textStep } from "@gent/core/debug/provider"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "@gent/core/runtime/agent/agent-loop.utils"
import {
  buildLoopCheckpointRecord,
  type AgentLoopCheckpointRecord,
} from "@gent/core/runtime/agent/agent-loop.checkpoint"
import {
  appendFollowUpQueueState,
  buildRunningState,
  emptyLoopQueueState,
  type LoopState,
} from "@gent/core/runtime/agent/agent-loop.state"
import { EventStoreLive } from "@gent/core/runtime/event-store-live"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"

// ============================================================================
// Shared helpers
// ============================================================================

const makeExtRegistry = (tools: AnyCapabilityContribution[] = []) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        capabilities: tools,
      },
    },
  ])
  return Layer.merge(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
  )
}

const makeMessage = (sessionId: string, branchId: string, text: string) =>
  new Message({
    id: `${sessionId}-${branchId}-${text}`,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyCapabilityContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools),
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

const makeRecordingLayer = (providerLayer: Layer.Layer<Provider>) => {
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(),
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    recorderLayer,
    eventStoreLayer,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

/** Scripted provider: returns chunks from an array, one response per stream() call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<StreamChunk>>,
): Layer.Layer<Provider> => {
  let index = 0
  return Layer.succeed(Provider, {
    stream: () =>
      Effect.succeed(
        Stream.fromIterable(responses[index++] ?? [new FinishChunk({ finishReason: "stop" })]),
      ),
    generate: () => Effect.succeed("test response"),
  })
}

const makeLiveToolLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyCapabilityContribution[] = [],
) => {
  const extRegistry = makeExtRegistry(tools)
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    extRegistry,
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ResourceManagerLive,
  )
  const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

const makeCountingEventStore = (eventsRef: Ref.Ref<AgentEvent[]>) =>
  Layer.succeed(EventStore, {
    publish: (event: AgentEvent) =>
      Ref.update(eventsRef, (events) => [...events, event]).pipe(
        Effect.as({ id: 0, event, createdAt: Date.now() } as EventEnvelope),
      ),
    subscribe: () => Stream.empty,
    removeSession: () => Effect.void,
  })

const makeLayerWithEvents = (
  providerLayer: Layer.Layer<Provider>,
  eventsRef: Ref.Ref<AgentEvent[]>,
  tools: AnyCapabilityContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools),
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

/** Poll `getState` until the phase matches, with a short sleep between attempts. */
const waitForPhase = (
  agentLoop: AgentLoop,
  params: { sessionId: string; branchId: string },
  phase: string,
  attempts = 50,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const state = yield* agentLoop.getState(params)
      if (state.phase === phase) return state
      yield* Effect.sleep("1 millis")
    }
    throw new Error(`Timed out waiting for phase "${phase}"`)
  })

// ============================================================================
// streaming
// ============================================================================

describe("streaming", () => {
  test("concurrent sessions run independently", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "hello")
          const messageB = makeMessage("s2", "b2", "world")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          const finishedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedB._tag).toBe("Some")

          const statusA = fiberA.pollUnsafe()
          expect(statusA).toBeUndefined()

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("same session/branch serializes loop creation", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const delayedStorage = Layer.effect(
      Storage,
      Effect.gen(function* () {
        const storage = yield* Storage
        return {
          ...storage,
          getLatestEvent: (input) => storage.getLatestEvent(input).pipe(Effect.delay("5 millis")),
        }
      }),
    )

    const baseStorageLayer = Storage.TestWithSql()
    const slowStorage = Layer.provideMerge(delayedStorage, baseStorageLayer)

    const deps = Layer.mergeAll(
      slowStorage,
      providerLayer,
      makeExtRegistry(),
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      EventStore.Memory,
      ToolRunner.Test(),
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

          const fiberA = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "first")))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(agentLoop.run(makeMessage("s1", "b1", "second")))
          const queuedB = yield* Fiber.join(fiberB).pipe(Effect.timeoutOption("200 millis"))

          expect(queuedB._tag).toBe("Some")
          expect(calls).toBe(1)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiberA)

          expect(calls).toBe(2)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("interrupt scoped to session/branch", async () => {
    const gateA = await Effect.runPromise(Deferred.make<void>())
    const gateB = await Effect.runPromise(Deferred.make<void>())
    const startedA = await Effect.runPromise(Deferred.make<void>())
    const startedB = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        const gate = calls === 1 ? gateA : gateB
        const started = calls === 1 ? startedA : startedB
        return Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(gate)
              return new FinishChunk({ finishReason: "stop" })
            }),
          ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
        )
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")

          const fiberA = yield* Effect.forkChild(agentLoop.run(messageA))
          const fiberB = yield* Effect.forkChild(agentLoop.run(messageB))

          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* agentLoop.steer({ _tag: "Interrupt", sessionId: "s1", branchId: "b1" })

          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")

          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()

          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("batches queued messages into one follow-up", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const storage = yield* Storage

          const first = makeMessage("s1", "b1", "first")
          const second = makeMessage("s1", "b1", "second")
          const third = makeMessage("s1", "b1", "third")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(second)
          yield* agentLoop.run(third)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          const messages = yield* storage.listMessages("b1")
          const userTexts = messages
            .filter((message) => message.role === "user")
            .map((message) =>
              message.parts
                .filter((part): part is TextPart => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            )

          expect(userTexts).toEqual(["first", "second\nthird"])
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("publishes StreamStarted and TurnCompleted events", async () => {
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })])),
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeRecordingLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          yield* agentLoop.run(makeMessage("s1", "b1", "inspect me"))

          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "publish")
            .map((call) => (call.args as { _tag?: string } | undefined)?._tag)
            .filter((tag): tag is string => tag !== undefined)

          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("interjection runs before queued follow-up with scoped agent override", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerCalls: Array<{ model: string; latestUserText: string }> = []
    let streamCount = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: (request) => {
        const latestUserText = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")
          ?.parts.filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n")

        providerCalls.push({
          model: request.model,
          latestUserText: latestUserText ?? "",
        })

        streamCount += 1
        if (streamCount === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queued)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
            agent: "deepwork",
          })

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)

          expect(providerCalls.length).toBe(3)
          expect(providerCalls[0]!.latestUserText).toBe("first")
          expect(providerCalls[1]!.latestUserText).toBe("steer now")
          expect(providerCalls[2]!.latestUserText).toBe("queued")
          expect(providerCalls[1]!.model).not.toBe(providerCalls[0]!.model)
          expect(providerCalls[2]!.model).toBe(providerCalls[0]!.model)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("getQueue reads without draining", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    let calls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: () => {
        calls += 1
        if (calls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return new FinishChunk({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => new FinishChunk({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queuedA = makeMessage("s1", "b1", "queued a")
          const queuedB = makeMessage("s1", "b1", "queued b")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queuedA)
          yield* agentLoop.run(queuedB)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
          })

          const snapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ kind: "steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ kind: "follow-up", content: "queued a\nqueued b" }),
          ])

          const secondSnapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(secondSnapshot).toEqual(snapshot)

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("flushes queued follow-ups after provider failure", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerCalls: string[] = []
    let streamCalls = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: ({ messages }) => {
        const latestUserText =
          messages
            .slice()
            .reverse()
            .flatMap((message) => message.parts)
            .find((part): part is TextPart => part.type === "text")?.text ?? ""

        providerCalls.push(latestUserText)
        streamCalls += 1

        if (streamCalls === 1) {
          return Effect.succeed(
            Stream.fromEffect(
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(gate)
                return undefined
              }),
            ).pipe(
              Stream.flatMap(() =>
                Stream.fail(new ProviderError({ message: "provider exploded", model: "test" })),
              ),
            ),
          )
        }

        return Effect.succeed(Stream.fromIterable([new FinishChunk({ finishReason: "stop" })]))
      },
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")

          const fiber = yield* Effect.forkChild(agentLoop.run(first))
          yield* Deferred.await(firstStarted)
          yield* agentLoop.run(queued)

          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ kind: "follow-up", content: "queued after failure" }),
          ])

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)

          expect(providerCalls).toEqual(["first", "queued after failure"])

          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotAfterFailure).toEqual({ steering: [], followUp: [] })
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("runOnce publishes machine inspection events", async () => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const extRegistry = makeExtRegistry()
    const toolDeps = Layer.mergeAll(
      extRegistry,
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      MachineEngine.Test(),
    )
    const toolRunnerLayer = ToolRunner.Live.pipe(Layer.provide(toolDeps))
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      Provider.Debug({ retries: false }),
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      BunServices.layer,
      ResourceManagerLive,
      recorderLayer,
      eventStoreLayer,
      toolDeps,
      toolRunnerLayer,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const loopLayer = AgentLoop.Live({ baseSections: [] }).pipe(
      Layer.provide(Layer.merge(deps, eventPublisherLayer)),
    )
    const layer = Layer.mergeAll(deps, eventPublisherLayer, loopLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const loop = yield* AgentLoop
        const recorder = yield* SequenceRecorder

        const now = new Date()
        const session = new Session({
          id: "inspection-session",
          name: "Inspection",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "inspection-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "inspect",
        })

        yield* Effect.yieldNow

        const calls = yield* recorder.getCalls()
        const tags = calls
          .filter((call) => call.service === "EventStore" && call.method === "publish")
          .map((call) => (call.args as { _tag: string } | undefined)?._tag)

        expect(tags.includes("MachineInspected")).toBe(true)
        expect(tags.includes("TurnCompleted")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })
})

// ============================================================================
// concurrency
// ============================================================================

describe("concurrency", () => {
  test("serial tool calls do not overlap", async () => {
    const events: string[] = []
    let running = 0
    let maxRunning = 0

    const makeSerialTool = (name: string) =>
      tool({
        id: name,
        // All instances of "serial tool" share one resource lock — same
        // behavior as the old `concurrency: "serial"` flag for one tool.
        resources: ["test-serial"],
        description: `Serial tool ${name}`,
        params: Schema.Struct({}),
        execute: () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              running += 1
              maxRunning = Math.max(maxRunning, running)
              events.push(`start:${name}`)
            })

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  setTimeout(resolve, 1)
                }),
            )

            yield* Effect.sync(() => {
              events.push(`end:${name}`)
              running -= 1
            })

            return { ok: true }
          }),
      })

    const toolA = makeSerialTool("serial-a")
    const toolB = makeSerialTool("serial-b")

    const layer = makeLiveToolLayer(
      scriptedProvider([
        [
          new ToolCallChunk({ toolCallId: "tc-1", toolName: "serial-a", input: {} }),
          new ToolCallChunk({ toolCallId: "tc-2", toolName: "serial-b", input: {} }),
          new FinishChunk({ finishReason: "tool_calls" }),
        ],
        [new FinishChunk({ finishReason: "stop" })],
      ]),
      [toolA, toolB],
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const loop = yield* AgentLoop

        const now = new Date()
        const session = new Session({
          id: "serial-session",
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: "serial-branch",
          sessionId: session.id,
          createdAt: now,
        })

        yield* storage.createSession(session)
        yield* storage.createBranch(branch)

        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: "cowork",
          prompt: "run serial tools",
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(maxRunning).toBe(1)
    expect(events.length).toBe(4)
    expect(events[0]?.startsWith("start:")).toBe(true)
    expect(events[1]?.startsWith("end:")).toBe(true)
    expect(events[2]?.startsWith("start:")).toBe(true)
    expect(events[3]?.startsWith("end:")).toBe(true)
    expect(events[0]?.slice("start:".length)).toBe(events[1]?.slice("end:".length))
    expect(events[2]?.slice("start:".length)).toBe(events[3]?.slice("end:".length))
  })
})

// ============================================================================
// continuation
// ============================================================================

describe("continuation", () => {
  const contSessionId = SessionId.of("cont-test-session")
  const contBranchId = BranchId.of("cont-test-branch")

  const makeContMessage = (text: string) =>
    new Message({
      id: MessageId.of(`msg-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      sessionId: contSessionId,
      branchId: contBranchId,
      role: "user",
      parts: [new TextPart({ type: "text", text })],
      createdAt: new Date(),
    })

  const echoTool = tool({
    id: "echo",
    description: "Echoes input",
    params: Schema.Struct({ text: Schema.String }),
    execute: (_params) => Effect.succeed({ text: _params.text }),
  })

  test("tool call auto-continues to next LLM call", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "hello" }),
        textStep("Done with tools."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeContMessage("test auto-continue"))

        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))

  test("text-only response does not trigger continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        textStep("Just text, no tools."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeContMessage("text only"))

        expect(yield* controls.callCount).toBe(1)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))

  test("multi-hop tool calls chain until text response", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        toolCallStep("echo", { text: "step 3" }),
        textStep("Finally done."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeContMessage("multi-hop"))

        expect(yield* controls.callCount).toBe(4)
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))

  test("TurnCompleted fires once per turn, not per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Done."),
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop

        yield* agentLoop.run(makeContMessage("turn-events"))

        expect(yield* controls.callCount).toBe(3)

        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))

  test("interrupt during tool execution stops continuation", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("Continuation response."), gated: true },
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop

        const fiber = yield* Effect.forkChild(agentLoop.run(makeContMessage("interrupt test")))

        yield* controls.waitForCall(1)

        yield* agentLoop.steer({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })

        yield* controls.emitAll(1)

        yield* Fiber.join(fiber)

        expect(yield* controls.callCount).toBe(2)

        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")
        expect(turnCompleted.length).toBe(1)
        const tc = turnCompleted[0] as { interrupted?: boolean }
        expect(tc.interrupted).toBe(true)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))

  test("GUARD: ToolsFinished without interrupt routes to Resolving", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "tool" }),
        textStep("Continuation reached."),
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        yield* agentLoop.run(makeContMessage("structural guard"))

        expect(yield* controls.callCount).toBe(2)
        yield* controls.assertDone()

        const events = yield* Ref.get(eventsRef)
        expect(events.filter((e) => e._tag === "TurnCompleted").length).toBe(1)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))

  test("GUARD: multi-hop persists distinct messages per step", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        toolCallStep("echo", { text: "step 2" }),
        textStep("Final answer."),
      ])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const msg = makeContMessage("multi-hop persistence")

        yield* agentLoop.run(msg)

        const a1 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 1))
        const t1 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 1))
        expect(a1).toBeDefined()
        expect(t1).toBeDefined()
        expect(a1!.role).toBe("assistant")
        expect(t1!.role).toBe("tool")

        const a2 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 2))
        const t2 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 2))
        expect(a2).toBeDefined()
        expect(t2).toBeDefined()
        expect(a2!.role).toBe("assistant")
        expect(t2!.role).toBe("tool")

        const a3 = yield* storage.getMessage(assistantMessageIdForTurn(msg.id, 3))
        const t3 = yield* storage.getMessage(toolResultMessageIdForTurn(msg.id, 3))
        expect(a3).toBeDefined()
        expect(a3!.role).toBe("assistant")
        expect(t3).toBeUndefined()

        expect(new Set([a1!.id, a2!.id, a3!.id]).size).toBe(3)
        expect(new Set([t1!.id, t2!.id]).size).toBe(2)
      }).pipe(Effect.provide(makeLayer(providerLayer, [echoTool])))
    }).pipe(Effect.runPromise))

  test("queued follow-up executes normally after interrupt", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        toolCallStep("echo", { text: "step 1" }),
        { ...textStep("gated response"), gated: true },
        textStep("follow-up response"),
      ])

      const eventsRef = yield* Ref.make<AgentEvent[]>([])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop

        const first = makeContMessage("first message")
        const followUp = makeContMessage("follow-up after interrupt")

        // Start first turn — tool call auto-continues to gated step
        yield* Effect.forkChild(agentLoop.run(first))

        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)

        // Queue a follow-up while step 1 is gated
        yield* agentLoop.run(followUp)

        // Interrupt the current turn
        yield* agentLoop.steer({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })

        // Let the machine process the interrupt (sets interruptedRef + signals stream)
        yield* Effect.sleep("1 millis")

        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)

        // Wait for the follow-up to complete
        yield* waitForPhase(
          agentLoop,
          { sessionId: contSessionId, branchId: contBranchId },
          "idle",
          200,
        )

        const events = yield* Ref.get(eventsRef)
        const turnCompleted = events.filter((e) => e._tag === "TurnCompleted")

        // Both turns should have completed
        expect(turnCompleted.length).toBe(2)
        const interruptedTurns = turnCompleted.filter(
          (e) => (e as { interrupted?: boolean }).interrupted === true,
        )
        // First turn was interrupted, second (follow-up) was not
        expect(interruptedTurns.length).toBe(1)
        // Follow-up used the third provider step
        expect(yield* controls.callCount).toBe(3)
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef, [echoTool])))
    }).pipe(Effect.runPromise))
})

// ============================================================================
// interaction
// ============================================================================

describe("interaction", () => {
  const intSessionId = SessionId.of("s-interaction")
  const intBranchId = BranchId.of("b-interaction")

  const makeIntMessage = (text: string) =>
    new Message({
      id: `msg-${text}`,
      sessionId: intSessionId,
      branchId: intBranchId,
      role: "user",
      parts: [new TextPart({ type: "text", text })],
      createdAt: new Date(),
    })

  const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
    tool({
      id: "interaction-tool",
      description: "Tool that triggers an interaction",
      resources: ["interaction-tool"],
      params: Schema.Struct({ value: Schema.String }),
      execute: (params: { value: string }, ctx: ToolContext) =>
        Effect.gen(function* () {
          const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
          if (count === 0) {
            return yield* new InteractionPendingError({
              requestId: "req-test-1",
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
          }
          yield* Deferred.succeed(resolution, void 0)
          return { resolved: true, value: params.value }
        }),
    })

  // Stateful provider: first stream() returns a tool call (triggers interaction),
  // subsequent stream() calls return text only (completes the turn).
  // Without this, the loop re-streams the same tool call 199 times until maxTurnSteps.
  const makeInteractionProviderLayer = () => {
    let streamCall = 0
    return Layer.succeed(Provider, {
      stream: () => {
        const call = streamCall++
        if (call === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              new ToolCallChunk({
                toolCallId: ToolCallId.of("tc-1"),
                toolName: "interaction-tool",
                input: { value: "test" },
              }),
              new FinishChunk({ finishReason: "tool_calls" }),
            ] satisfies StreamChunk[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            new TextChunk({ text: "done" }),
            new FinishChunk({ finishReason: "stop" }),
          ] satisfies StreamChunk[]),
        )
      },
      generate: () => Effect.succeed("test"),
    })
  }

  const makeInteractionRecordingLayer = (
    tools: AnyCapabilityContribution[],
    providerLayer?: Layer.Layer<Provider>,
  ) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerLayer ?? makeInteractionProviderLayer(),
      makeExtRegistry(tools),
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      ApprovalService.Test(),
      Permission.Live([], "allow"),
      BunServices.layer,
      ResourceManagerLive,
      recorderLayer,
      eventStoreLayer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )
  }

  test("tool triggers InteractionPendingError and machine parks", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const tool = makeInteractionTool(callCount, resolution)

    const layer = makeInteractionRecordingLayer([tool])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          const fiber = yield* Effect.forkChild(
            agentLoop.run(makeIntMessage("trigger interaction")),
          )

          const state = yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "waiting-for-interaction",
          )
          expect(state.status).toBe("running")
          expect(Ref.getUnsafe(callCount)).toBe(1)

          const calls = yield* recorder.getCalls()
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "publish")
            .map((c) => (c.args as { _tag: string })._tag)
          expect(eventTags).toContain("ToolCallStarted")

          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-test-1",
          })

          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)

          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("interrupt during WaitingForInteraction finalizes turn", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const tool = makeInteractionTool(callCount, resolution)

    const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const fiber = yield* Effect.forkChild(agentLoop.run(makeIntMessage("interrupt test")))

          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "waiting-for-interaction",
          )

          yield* agentLoop.steer({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
          })

          yield* Fiber.join(fiber)

          const stateAfter = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(stateAfter.phase).toBe("idle")
          expect(Ref.getUnsafe(callCount)).toBe(1)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("respondInteraction is no-op when not in WaitingForInteraction", async () => {
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
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      EventStore.Memory,
      ToolRunner.Test(),
      BunServices.layer,
      ResourceManagerLive,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    const loopLayer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, eventPublisherLayer),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          yield* agentLoop.run(makeIntMessage("no interaction"))

          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "nonexistent",
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state.phase).toBe("idle")
        }).pipe(Effect.provide(loopLayer)),
      ),
    )
  })

  test("GUARD: interaction resume executes tool without new LLM call", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const tool = makeInteractionTool(callCount, resolution)

    const providerCallsRef = Ref.makeUnsafe(0)
    let streamCallIndex = 0
    const separateCallProvider = Layer.succeed(Provider, {
      stream: () =>
        Effect.gen(function* () {
          yield* Ref.update(providerCallsRef, (n) => n + 1)
          const idx = streamCallIndex++
          if (idx === 0) {
            return Stream.fromIterable([
              new ToolCallChunk({
                toolCallId: ToolCallId.of("tc-guard"),
                toolName: tool.id,
                input: { value: "guard-test" },
              }),
              new FinishChunk({ finishReason: "tool_calls" }),
            ] satisfies StreamChunk[])
          }
          return Stream.fromIterable([
            new TextChunk({ text: "interaction resolved" }),
            new FinishChunk({ finishReason: "stop" }),
          ] satisfies StreamChunk[])
        }),
      generate: () => Effect.succeed("test"),
    })

    const layer = makeLiveToolLayer(separateCallProvider, [tool])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const fiber = yield* Effect.forkChild(agentLoop.run(makeIntMessage("guard interaction")))

          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "waiting-for-interaction",
          )
          expect(Ref.getUnsafe(providerCallsRef)).toBe(1)

          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-test-1",
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)

          yield* Fiber.join(fiber)

          expect(Ref.getUnsafe(providerCallsRef)).toBe(2)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })
})

// ============================================================================
// recovery
// ============================================================================

describe("recovery", () => {
  const idempotentTestTool = tool({
    id: "test-idempotent",
    description: "Test idempotent tool",
    idempotent: true,
    params: Schema.Unknown,
    execute: () => Effect.succeed({ ok: true }),
  })

  const createSessionState = () => {
    const sessionId = SessionId.of("session-loop-recovery")
    const branchId = BranchId.of("branch-loop-recovery")
    const message = new Message({
      id: MessageId.of("message-loop-recovery"),
      sessionId,
      branchId,
      role: "user",
      parts: [new TextPart({ type: "text", text: "Recover this turn" })],
      createdAt: new Date(),
    })

    return {
      sessionId,
      branchId,
      session: {
        id: sessionId,
        name: "Loop Recovery",
        cwd: process.cwd(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      branch: new Branch({
        id: branchId,
        sessionId,
        createdAt: new Date(),
      }),
      message,
    }
  }

  const makeRecoveryLayer = (params: {
    dbPath: string
    providerChunks?: ReadonlyArray<StreamChunk>
    providerCalls?: Ref.Ref<number>
  }) => {
    const storageLayer = Storage.LiveWithSql(params.dbPath).pipe(
      Layer.provide(BunFileSystem.layer),
      Layer.provide(BunServices.layer),
    )
    const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
    const recoveryResolved = resolveExtensions([
      {
        manifest: { id: "test-recovery" },
        kind: "builtin",
        sourcePath: "test",
        contributions: {
          agents: Object.values(Agents),
          capabilities: [tool(idempotentTestTool)],
        },
      },
    ])
    const extensionLayer = Layer.merge(
      ExtensionRegistry.fromResolved(recoveryResolved),
      DriverRegistry.fromResolved({
        modelDrivers: recoveryResolved.modelDrivers,
        externalDrivers: recoveryResolved.externalDrivers,
      }),
    )
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Ref.update(params.providerCalls ?? Ref.makeUnsafe(0), (count) => count + 1).pipe(
          Effect.as(
            Stream.fromIterable(
              params.providerChunks ?? [
                new TextChunk({ text: "recovered assistant" }),
                new FinishChunk({ finishReason: "stop" }),
              ],
            ),
          ),
        ),
      generate: () => Effect.succeed("generated"),
    })
    const toolRunnerLayer = Layer.succeed(ToolRunner, {
      run: (input) =>
        Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            output: { type: "json", value: { ok: true } },
          }),
        ),
    })
    const base = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      extensionLayer,
      MachineEngine.Test(),
      ExtensionTurnControl.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      providerLayer,
      toolRunnerLayer,
      ApprovalService.Test(),
      ResourceManagerLive,
    )
    const eventPublisherLayer = Layer.provide(EventPublisherLive, base)

    return Layer.mergeAll(
      base,
      eventPublisherLayer,
      Layer.provide(
        AgentLoop.Live({
          baseSections: [{ id: "base", content: "System prompt", priority: 0 }],
        }),
        Layer.merge(base, eventPublisherLayer),
      ),
    )
  }

  const waitFor = <A>(
    effect: Effect.Effect<A>,
    predicate: (value: A) => boolean,
    attempts = 50,
  ): Effect.Effect<A> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const value = yield* effect
        if (predicate(value)) return value
        yield* Effect.sleep("1 millis")
      }
      throw new Error("timed out waiting for recovery")
    })

  const seedCheckpoint = (params: {
    state: LoopState
    queue?: ReturnType<typeof emptyLoopQueueState>
    checkpointRecord?: AgentLoopCheckpointRecord
  }) =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const cs = yield* CheckpointStorage
      const { session, branch, message } = createSessionState()

      yield* storage.createSession(session)
      yield* storage.createBranch(branch)
      yield* storage.createMessageIfAbsent(message)

      const record =
        params.checkpointRecord ??
        (yield* buildLoopCheckpointRecord({
          sessionId: session.id,
          branchId: branch.id,
          state: params.state,
          queue: params.queue ?? emptyLoopQueueState(),
        }))
      yield* cs.upsert(record)

      return { session, branch, message }
    })

  test("recovers from Running checkpoint and completes the turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-running-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const running = buildRunningState({ currentAgent: "cowork" }, { message })

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({ state: running, queue: emptyLoopQueueState() })
            const agentLoop = yield* AgentLoop

            const state = yield* waitFor(
              agentLoop.getState({
                sessionId: running.message.sessionId,
                branchId: running.message.branchId,
              }),
              (s) => s.phase === "idle",
            )

            expect(state.phase).toBe("idle")
            expect(yield* Ref.get(providerCalls)).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("recovers from Idle with queued follow-up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-idle-queue-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const queuedMessage = new Message({
        id: MessageId.of("queued-msg"),
        sessionId: message.sessionId,
        branchId: message.branchId,
        role: "user",
        parts: [new TextPart({ type: "text", text: "queued" })],
        createdAt: new Date(),
      })

      const idleWithQueue = {
        _tag: "Idle" as const,
        currentAgent: "cowork" as const,
      } as LoopState
      const idleQueue = appendFollowUpQueueState(emptyLoopQueueState(), {
        message: queuedMessage,
      })

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({ state: idleWithQueue, queue: idleQueue })
            const agentLoop = yield* AgentLoop

            const state = yield* waitFor(
              agentLoop.getState({
                sessionId: message.sessionId,
                branchId: message.branchId,
              }),
              (s) => s.phase === "idle",
            )

            expect(state.phase).toBe("idle")
            expect(yield* Ref.get(providerCalls)).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("discards incompatible checkpoint version and starts fresh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-stale-"))
    const dbPath = path.join(dir, "data.db")

    try {
      const { message } = createSessionState()
      const running = buildRunningState({ currentAgent: "cowork" }, { message })

      const record = await Effect.runPromise(
        buildLoopCheckpointRecord({
          sessionId: running.message.sessionId,
          branchId: running.message.branchId,
          state: running,
          queue: emptyLoopQueueState(),
        }),
      )
      const staleRecord = { ...record, version: 999 }

      const providerCalls = Ref.makeUnsafe(0)
      const layer = makeRecoveryLayer({ dbPath, providerCalls })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* seedCheckpoint({
              state: running,
              queue: emptyLoopQueueState(),
              checkpointRecord: staleRecord,
            })
            const agentLoop = yield* AgentLoop

            const state = yield* agentLoop.getState({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
            })

            expect(state.phase).toBe("idle")
            expect(yield* Ref.get(providerCalls)).toBe(0)

            const cs = yield* CheckpointStorage
            const checkpoint = yield* cs.get({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
            })
            expect(checkpoint).toBeUndefined()
          }).pipe(Effect.provide(layer)),
        ),
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
