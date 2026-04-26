import { describe, expect, test } from "bun:test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentLoop } from "../../src/runtime/agent/agent-loop"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { ConfigService } from "../../src/runtime/config-service"
import { ExtensionTurnControl, TurnControlError } from "../../src/runtime/extensions/turn-control"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { AgentDefinition, AgentName, ExternalDriverRef } from "@gent/core/domain/agent"
import {
  Provider,
  ProviderError,
  finishPart,
  reasoningDeltaPart,
  textDeltaPart,
  toolCallPart,
  type ProviderStreamPart,
} from "@gent/core/providers/provider"
import { textStep, toolCallStep } from "@gent/core/debug/provider"
import {
  Branch,
  ImagePart,
  Message,
  Session,
  TextPart,
  ToolResultPart,
} from "@gent/core/domain/message"
import { Agents } from "@gent/extensions/all-agents"
import { type ToolContext } from "@gent/core/domain/tool"
import {
  tool,
  type AnyCapabilityContribution,
  type AnyResourceContribution,
} from "@gent/core/extensions/api"
import { Permission } from "@gent/core/domain/permission"
import {
  EventEnvelope,
  EventId,
  EventStore,
  EventStoreError,
  type AgentEvent,
} from "@gent/core/domain/event"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { ApprovalService } from "../../src/runtime/approval-service"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { EventPublisherLive } from "../../src/server/event-publisher"
import { Storage, StorageError } from "@gent/core/storage/sqlite-storage"
import { SequenceRecorder, RecordingEventStore, ensureStorageParents } from "@gent/core/test-utils"
import { emptyQueueSnapshot } from "@gent/core/domain/queue"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import {
  assistantDraftFromMessage,
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../src/runtime/agent/agent-loop.utils"
import type { TurnError, TurnEvent } from "@gent/core/domain/driver"
import {
  buildLoopCheckpointRecord,
  decodeLoopCheckpointState,
  type AgentLoopCheckpointRecord,
} from "../../src/runtime/agent/agent-loop.checkpoint"
import {
  appendFollowUpQueueState,
  appendSteeringItem,
  buildRunningState,
  emptyLoopQueueState,
  LoopState,
} from "../../src/runtime/agent/agent-loop.state"
import { EventStoreLive } from "../../src/runtime/event-store-live"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"

// ============================================================================
// Shared helpers
// ============================================================================

const makeExtRegistry = (
  tools: AnyCapabilityContribution[] = [],
  resources: AnyResourceContribution[] = [],
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: "agents" },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        capabilities: tools,
        resources,
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
  Message.Regular.make({
    id: `${sessionId}-${branchId}-${text}`,
    sessionId,
    branchId,
    role: "user",
    parts: [new TextPart({ type: "text", text })],
    createdAt: new Date(),
  })

const runAgentLoop = (
  agentLoop: AgentLoop,
  message: Message,
  options?: Parameters<AgentLoop["run"]>[1],
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() => agentLoop.run(message, options)),
  )

const submitAgentLoop = (
  agentLoop: AgentLoop,
  message: Message,
  options?: Parameters<AgentLoop["submit"]>[1],
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() => agentLoop.submit(message, options)),
  )

const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyCapabilityContribution[] = [],
  resources: AnyResourceContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools, resources),
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
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
    ModelRegistry.Test(),
    recorderLayer,
    eventStoreLayer,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

const checkpointKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`

const checkpointStorageLayer = (options?: { failUpsertOn?: number; failRemoveOn?: number }) => {
  let upsertCount = 0
  let removeCount = 0
  const records = new Map<string, AgentLoopCheckpointRecord>()

  return Layer.succeed(CheckpointStorage, {
    upsert: (record) =>
      Effect.gen(function* () {
        upsertCount += 1
        if (options?.failUpsertOn === upsertCount) {
          return yield* new StorageError({
            message: "checkpoint upsert failed",
          })
        }
        records.set(checkpointKey(record.sessionId, record.branchId), record)
        return record
      }),
    get: (input) => Effect.succeed(records.get(checkpointKey(input.sessionId, input.branchId))),
    list: () => Effect.succeed(Array.from(records.values())),
    remove: (input) =>
      Effect.gen(function* () {
        removeCount += 1
        if (options?.failRemoveOn === removeCount) {
          return yield* new StorageError({
            message: "checkpoint remove failed",
          })
        }
        records.delete(checkpointKey(input.sessionId, input.branchId))
      }),
  })
}

const makeCheckpointFailureLayer = (options: { failUpsertOn?: number; failRemoveOn?: number }) => {
  const providerLayer = Layer.succeed(Provider, {
    stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
    generate: () => Effect.succeed("test response"),
  })
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    checkpointStorageLayer(options),
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
    ModelRegistry.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

/** Scripted provider: returns stream parts from an array, one response per stream() call. */
const scriptedProvider = (
  responses: ReadonlyArray<ReadonlyArray<ProviderStreamPart>>,
): Layer.Layer<Provider> => {
  let index = 0
  return Layer.succeed(Provider, {
    stream: () =>
      Effect.succeed(
        Stream.fromIterable(responses[index++] ?? [finishPart({ finishReason: "stop" })]),
      ),
    generate: () => Effect.succeed("test response"),
  })
}

const retryableStreamError = () =>
  new ProviderError({
    message: "rate limit exceeded (429)",
    model: "test",
    cause: { headers: new Headers({ "retry-after": "0" }) },
  })

const makeLiveToolLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyCapabilityContribution[] = [],
  resources: AnyResourceContribution[] = [],
) => {
  const turnControlLayer = ExtensionTurnControl.Live
  const extRegistry = makeExtRegistry(tools, resources)
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    extRegistry,
    MachineEngine.Test(),
    turnControlLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    EventStore.Memory,
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
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
    ModelRegistry.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}

const makeLayerWithEventPublisher = (
  providerLayer: Layer.Layer<Provider>,
  eventPublisherLayer: Layer.Layer<EventPublisher, never, Storage>,
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
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
    ModelRegistry.Test(),
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, deps)
  return Layer.provideMerge(
    AgentLoop.Live({ baseSections: [] }),
    Layer.merge(deps, providedEventPublisherLayer),
  )
}

const makePublisherFailingFirstMatchingDelivery = (
  matches: (event: AgentEvent) => boolean,
  delivered: string[],
) =>
  Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const storage = yield* Storage
      let failed = false
      const append = (event: AgentEvent) =>
        storage
          .appendEvent(event)
          .pipe(
            Effect.mapError(
              (error) => new EventStoreError({ message: error.message, cause: error }),
            ),
          )
      const deliver = (envelope: EventEnvelope) =>
        Effect.gen(function* () {
          const event = envelope.event
          delivered.push(
            event._tag === "MessageReceived" ? `${event._tag}:${event.message.role}` : event._tag,
          )
          if (!failed && matches(event)) {
            failed = true
            return yield* new EventStoreError({ message: "deliver failed" })
          }
        })
      return EventPublisher.of({
        append,
        deliver,
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* append(event)
            yield* deliver(envelope)
          }),
        terminateSession: () => Effect.void,
      })
    }),
  )

const parityExternalAgent = AgentDefinition.make({
  name: "test-external-parity" as never,
  driver: ExternalDriverRef.make({ id: "test-parity-driver" }),
})

const makeExternalLayerWithEvents = (
  events: ReadonlyArray<TurnEvent>,
  eventsRef: Ref.Ref<AgentEvent[]>,
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: "agents" },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
      },
    },
    {
      manifest: { id: "external-parity" },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [parityExternalAgent],
        externalDrivers: [
          {
            id: "test-parity-driver",
            executor: {
              executeTurn: () => Stream.fromIterable<TurnEvent, TurnError>(events),
            },
            invalidate: () => Effect.void,
          },
        ],
      },
    },
  ])
  const registryLayer = Layer.merge(
    ExtensionRegistry.fromResolved(resolved),
    DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    }),
  )
  const providerLayer = Layer.succeed(Provider, {
    stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
    generate: () => Effect.succeed("unused"),
  })
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    registryLayer,
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    makeCountingEventStore(eventsRef),
    ToolRunner.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
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
  runtimeTag: string,
  attempts = 50,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const state = yield* agentLoop.getState(params)
      if (state._tag === runtimeTag) return state
      yield* Effect.sleep("1 millis")
    }
    throw new Error(`Timed out waiting for runtime state "${runtimeTag}"`)
  })

// ============================================================================
// streaming
// ============================================================================

describe("run completion", () => {
  test("run returns after a fast turn completes before the caller awaits idle", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([textStep("fast reply")])

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const sessionId = SessionId.make("fast-run-session")
        const branchId = BranchId.make("fast-run-branch")

        yield* runAgentLoop(agentLoop, makeMessage(sessionId, branchId, "fast")).pipe(
          Effect.timeout("2 seconds"),
        )

        const state = yield* agentLoop.getState({ sessionId, branchId })
        expect(state._tag).toBe("Idle")
      }).pipe(Effect.provide(makeLayer(providerLayer)))
    }).pipe(Effect.runPromise))
})

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
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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

          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))

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
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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
      ModelRegistry.Test(),
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

          const fiberA = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)
          const fiberB = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("s1", "b1", "second")),
          )
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
              return finishPart({ finishReason: "stop" })
            }),
          ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
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

          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))

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
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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

          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, second)
          yield* runAgentLoop(agentLoop, third)

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
      stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
      generate: () => Effect.succeed("test response"),
    })

    const layer = makeRecordingLayer(providerLayer)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder

          yield* runAgentLoop(agentLoop, makeMessage("s1", "b1", "inspect me"))

          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map((call) => (call.args as { _tag?: string } | undefined)?._tag)
            .filter((tag): tag is string => tag !== undefined)

          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("rolls back assistant message when durable MessageReceived append fails", async () => {
    const providerLayer = scriptedProvider([
      [textDeltaPart("not committed"), finishPart({ finishReason: "stop" })],
    ])
    const failingPublisherLayer = Layer.succeed(EventPublisher, {
      append: (event: AgentEvent) =>
        event._tag === "MessageReceived" && event.message.role === "assistant"
          ? Effect.fail(new EventStoreError({ message: "append failed" }))
          : Effect.succeed(
              EventEnvelope.make({ id: EventId.make(0), event, createdAt: Date.now() }),
            ),
      deliver: () => Effect.void,
      publish: () => Effect.void,
      terminateSession: () => Effect.void,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("atomic-assistant-session", "atomic-assistant-branch", "hello")

        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))

        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer))),
    )
  })

  test("rolls back turn duration when TurnCompleted append fails", async () => {
    const providerLayer = scriptedProvider([
      [textDeltaPart("committed before finalize"), finishPart({ finishReason: "stop" })],
    ])
    const failingPublisherLayer = Layer.succeed(EventPublisher, {
      append: (event: AgentEvent) =>
        event._tag === "TurnCompleted"
          ? Effect.fail(new EventStoreError({ message: "append failed" }))
          : Effect.succeed(
              EventEnvelope.make({ id: EventId.make(0), event, createdAt: Date.now() }),
            ),
      deliver: () => Effect.void,
      publish: () => Effect.void,
      terminateSession: () => Effect.void,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("atomic-turn-session", "atomic-turn-branch", "hello")

        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* storage.getMessage(message.id)

        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer))),
    )
  })

  test("retries committed user event delivery without duplicating the durable event", async () => {
    const providerLayer = scriptedProvider([
      [textDeltaPart("after retry"), finishPart({ finishReason: "stop" })],
    ])
    const delivered: string[] = []
    const failingPublisherLayer = makePublisherFailingFirstMatchingDelivery(
      (event) => event._tag === "MessageReceived" && event.message.role === "user",
      delivered,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("retry-assistant-session", "retry-assistant-branch", "hello")

        const firstExit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        yield* waitForPhase(
          agentLoop,
          { sessionId: message.sessionId, branchId: message.branchId },
          "Idle",
        )
        yield* runAgentLoop(agentLoop, message)

        const events = yield* storage.listEvents({
          sessionId: message.sessionId,
          branchId: message.branchId,
        })
        const userReceived = events.filter(
          (envelope) =>
            envelope.event._tag === "MessageReceived" && envelope.event.message.id === message.id,
        )

        expect(firstExit._tag).toBe("Failure")
        expect(userReceived).toHaveLength(1)
        expect(
          delivered.filter((tag) => tag === "MessageReceived:user").length,
        ).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer))),
    )
  })

  test("persists assistant image parts from provider response streams", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const agentLoop = yield* AgentLoop
      const message = makeMessage("image-session", "image-branch", "show image")

      yield* runAgentLoop(agentLoop, message)

      const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
      expect(assistant).toBeDefined()
      expect(assistant?.parts).toEqual([
        new ImagePart({
          type: "image",
          image: "data:image/png;base64,aGk=",
          mediaType: "image/png",
        }),
      ])
    }).pipe(
      Effect.provide(
        makeLayer(
          scriptedProvider([
            [
              Response.makePart("file", {
                mediaType: "image/png",
                data: new Uint8Array([104, 105]),
              }),
              finishPart({ finishReason: "stop" }),
            ],
          ]),
        ),
      ),
      Effect.runPromise,
    ))

  test("interjection runs before queued follow-up with scoped agent override", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerCalls: Array<{ model: string; latestUserText: string }> = []
    let streamCount = 0

    const providerLayer = Layer.succeed(Provider, {
      stream: (request) => {
        const latestUserText = [...Prompt.make(request.prompt).content]
          .reverse()
          .find((message) => message.role === "user")
          ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
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
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }

        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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

          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
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
                return finishPart({ finishReason: "stop" })
              }),
            ).pipe(Stream.map(() => finishPart({ finishReason: "stop" }))),
          )
        }
        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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

          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queuedA)
          yield* runAgentLoop(agentLoop, queuedB)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: "s1",
            branchId: "b1",
            message: "steer now",
          })

          const snapshot = yield* agentLoop.getQueue({ sessionId: "s1", branchId: "b1" })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ _tag: "steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued a\nqueued b" }),
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
      stream: (request) => {
        const latestUserText =
          Prompt.make(request.prompt)
            .content.slice()
            .reverse()
            .flatMap((message) => message.content)
            .find((part): part is Prompt.TextPart => part.type === "text")?.text ?? ""

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

        return Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })]))
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

          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)

          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued after failure" }),
          ])

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)

          expect(providerCalls).toEqual(["first", "queued after failure"])

          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: "s1",
            branchId: "b1",
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("retries retryable provider stream-consumption failures before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.fail(retryableStreamError())
            }
            return Stream.fromIterable([
              textDeltaPart("after retry"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        generate: () => Effect.succeed("test response"),
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("stream-retry-session", "stream-retry-branch", "retry")

        yield* runAgentLoop(agentLoop, message)

        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([new TextPart({ type: "text", text: "after retry" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("retries retryable provider stream-consumption failures after metadata but before output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([
                  Response.makePart("response-metadata", {
                    id: "response-before-output",
                    modelId: "test",
                    timestamp: undefined,
                    request: undefined,
                  }),
                  Response.makePart("text-start", { id: "text-before-output" }),
                ]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("after metadata retry"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        generate: () => Effect.succeed("test response"),
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage(
          "stream-metadata-retry-session",
          "stream-metadata-retry-branch",
          "retry",
        )

        yield* runAgentLoop(agentLoop, message)

        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(2)
        expect(tags).toContain("ProviderRetrying")
        expect(tags).not.toContain("ErrorOccurred")

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([
          new TextPart({ type: "text", text: "after metadata retry" }),
        ])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("emits stream failure events after pre-output retries are exhausted", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.sync(() => {
            streamCalls += 1
            return Stream.fail(retryableStreamError())
          }),
        generate: () => Effect.succeed("test response"),
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage(
          "stream-retry-exhausted-session",
          "stream-retry-exhausted-branch",
          "retry",
        )

        yield* runAgentLoop(agentLoop, message)

        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(3)
        expect(tags.filter((tag) => tag === "ProviderRetrying")).toHaveLength(2)
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("does not retry retryable provider stream failures after partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      let streamCalls = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.sync(() => {
            streamCalls += 1
            if (streamCalls === 1) {
              return Stream.concat(
                Stream.fromIterable([textDeltaPart("partial answer")]),
                Stream.fail(retryableStreamError()),
              )
            }
            return Stream.fromIterable([
              textDeltaPart("duplicate answer"),
              finishPart({ finishReason: "stop" }),
            ])
          }),
        generate: () => Effect.succeed("test response"),
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("stream-no-retry-session", "stream-no-retry-branch", "retry")

        yield* runAgentLoop(agentLoop, message)

        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(streamCalls).toBe(1)
        expect(tags).not.toContain("ProviderRetrying")
        expect(tags).toContain("ErrorOccurred")

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant?.parts).toEqual([new TextPart({ type: "text", text: "partial answer" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))

  test("native response error parts fail the stream and preserve partial output", () =>
    Effect.gen(function* () {
      const eventsRef = yield* Ref.make<AgentEvent[]>([])
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("partial answer"),
              Response.makePart("error", { error: new Error("native response part failed") }),
              textDeltaPart("unreachable"),
            ]),
          ),
        generate: () => Effect.succeed("test response"),
      })

      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("native-error-session", "native-error-branch", "fail natively")

        yield* runAgentLoop(agentLoop, message)

        const events = yield* Ref.get(eventsRef)
        const tags = events.map((event) => event._tag)
        expect(tags).toContain("StreamStarted")
        expect(tags).toContain("StreamChunk")
        expect(tags).toContain("StreamEnded")
        expect(tags).toContain("ErrorOccurred")
        expect(tags).toContain("TurnCompleted")

        const error = events.find((event) => event._tag === "ErrorOccurred")
        expect(error).toEqual(expect.objectContaining({ error: "native response part failed" }))

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        expect(assistant?.parts).toEqual([new TextPart({ type: "text", text: "partial answer" })])
      }).pipe(Effect.provide(makeLayerWithEvents(providerLayer, eventsRef)))
    }).pipe(Effect.runPromise))
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
          toolCallPart("serial-a", {}, { toolCallId: "tc-1" }),
          toolCallPart("serial-b", {}, { toolCallId: "tc-2" }),
          finishPart({ finishReason: "tool-calls" }),
        ],
        [finishPart({ finishReason: "stop" })],
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
  const contSessionId = SessionId.make("cont-test-session")
  const contBranchId = BranchId.make("cont-test-branch")

  const makeContMessage = (text: string) =>
    Message.Regular.make({
      id: MessageId.make(`msg-${Date.now()}-${Math.random().toString(36).slice(2)}`),
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
        yield* runAgentLoop(agentLoop, makeContMessage("test auto-continue"))

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
        yield* runAgentLoop(agentLoop, makeContMessage("text only"))

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
        yield* runAgentLoop(agentLoop, makeContMessage("multi-hop"))

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

        yield* runAgentLoop(agentLoop, makeContMessage("turn-events"))

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

        const fiber = yield* Effect.forkChild(
          runAgentLoop(agentLoop, makeContMessage("interrupt test")),
        )

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
        yield* runAgentLoop(agentLoop, makeContMessage("structural guard"))

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

        yield* runAgentLoop(agentLoop, msg)

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
        yield* Effect.forkChild(runAgentLoop(agentLoop, first))

        // Wait for the gated step (second stream call) to start
        yield* controls.waitForCall(1)

        // Queue a follow-up while step 1 is gated
        yield* runAgentLoop(agentLoop, followUp)

        // Interrupt the current turn. `agentLoop.steer` issues
        // `actor.call(Interrupt)` which is serialized request-reply — by the
        // time it returns, the actor has already set `interruptedRef = true`
        // and signalled the active stream. No additional wait needed.
        yield* agentLoop.steer({
          _tag: "Interrupt",
          sessionId: contSessionId,
          branchId: contBranchId,
        })

        // Release the gated step so the interrupted turn can finalize
        yield* controls.emitAll(1)

        // Wait for the follow-up to complete
        yield* waitForPhase(
          agentLoop,
          { sessionId: contSessionId, branchId: contBranchId },
          "Idle",
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

describe("turn stream parity", () => {
  test("model and external turns produce the same assistant draft and lifecycle tags", () =>
    Effect.gen(function* () {
      const expectedTags = [
        "MessageReceived",
        "StreamStarted",
        "StreamChunk",
        "StreamEnded",
        "MessageReceived",
        "TurnCompleted",
      ]

      const modelEventsRef = yield* Ref.make<AgentEvent[]>([])
      const externalEventsRef = yield* Ref.make<AgentEvent[]>([])

      const modelDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("model-parity-session", "model-parity-branch", "hello")

        yield* runAgentLoop(agentLoop, message)

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeLayerWithEvents(
            scriptedProvider([
              [
                reasoningDeltaPart("thinking"),
                textDeltaPart("hello from parity"),
                finishPart({
                  finishReason: "stop",
                  usage: { inputTokens: 3, outputTokens: 5 },
                }),
              ],
            ]),
            modelEventsRef,
          ),
        ),
      )

      const externalDraft = yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("external-parity-session", "external-parity-branch", "hello")

        yield* runAgentLoop(agentLoop, message, { agentOverride: "test-external-parity" as never })

        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(assistant).toBeDefined()
        return assistantDraftFromMessage(assistant!)
      }).pipe(
        Effect.provide(
          makeExternalLayerWithEvents(
            [
              { _tag: "reasoning-delta", text: "thinking" },
              { _tag: "text-delta", text: "hello from parity" },
              {
                _tag: "finished",
                stopReason: "stop",
                usage: { inputTokens: 3, outputTokens: 5 },
              },
            ],
            externalEventsRef,
          ),
        ),
      )

      expect(modelDraft).toEqual(externalDraft)
      expect(
        (yield* Ref.get(modelEventsRef))
          .map((event) => event._tag)
          .filter((tag) => tag !== "MachineInspected"),
      ).toEqual(expectedTags)
      expect(
        (yield* Ref.get(externalEventsRef))
          .map((event) => event._tag)
          .filter((tag) => tag !== "MachineInspected"),
      ).toEqual(expectedTags)
    }).pipe(Effect.runPromise))
})

// ============================================================================
// interaction
// ============================================================================

describe("interaction", () => {
  const intSessionId = SessionId.make("s-interaction")
  const intBranchId = BranchId.make("b-interaction")

  const makeIntMessage = (text: string) =>
    Message.Regular.make({
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
              toolCallPart(
                "interaction-tool",
                { value: "test" },
                {
                  toolCallId: ToolCallId.make("tc-1"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies ProviderStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies ProviderStreamPart[]),
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
      ModelRegistry.Test(),
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
            runAgentLoop(agentLoop, makeIntMessage("trigger interaction")),
          )

          const state = yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          expect(state._tag).toBe("WaitingForInteraction")
          expect(Ref.getUnsafe(callCount)).toBe(1)

          const calls = yield* recorder.getCalls()
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "append")
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

          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("interrupt test")),
          )

          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
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
          expect(stateAfter._tag).toBe("Idle")
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
            Stream.fromIterable([textDeltaPart("hello"), finishPart({ finishReason: "stop" })]),
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
      ModelRegistry.Test(),
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

          yield* runAgentLoop(agentLoop, makeIntMessage("no interaction"))

          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "nonexistent",
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("Idle")
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
              toolCallPart(
                tool.id,
                { value: "guard-test" },
                {
                  toolCallId: ToolCallId.make("tc-guard"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies ProviderStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("interaction resolved"),
            finishPart({ finishReason: "stop" }),
          ] satisfies ProviderStreamPart[])
        }),
      generate: () => Effect.succeed("test"),
    })

    const layer = makeLiveToolLayer(separateCallProvider, [tool])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("guard interaction")),
          )

          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
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
// checkpoint persistence
// ============================================================================

describe("checkpoint persistence", () => {
  test("submit fails when saving the running checkpoint fails", async () => {
    const layer = makeCheckpointFailureLayer({ failUpsertOn: 1 })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const message = makeMessage("checkpoint-upsert-session", "b1", "persist")

          const exit = yield* Effect.exit(submitAgentLoop(agentLoop, message))

          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            expect(Cause.pretty(exit.cause)).toContain("Failed to persist agent loop checkpoint")
            expect(Cause.pretty(exit.cause)).toContain("checkpoint upsert failed")
          }
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("run fails when removing the completed checkpoint fails", async () => {
    const layer = makeCheckpointFailureLayer({ failRemoveOn: 2 })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const message = makeMessage("checkpoint-remove-session", "b1", "persist")

          const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))

          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            expect(Cause.pretty(exit.cause)).toContain("Failed to persist agent loop checkpoint")
            expect(Cause.pretty(exit.cause)).toContain("checkpoint remove failed")
          }
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("failed checkpoint save removes the dead loop so later turns can recreate it", async () => {
    let providerCalls = 0
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.sync(() => {
          providerCalls += 1
          return Stream.fromIterable([finishPart({ finishReason: "stop" })])
        }),
      generate: () => Effect.succeed("test response"),
    })
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      checkpointStorageLayer({ failUpsertOn: 1 }),
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
      ModelRegistry.Test(),
    )
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, Layer.provide(EventPublisherLive, deps)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop

          const failed = yield* Effect.exit(
            submitAgentLoop(agentLoop, makeMessage("checkpoint-recreate-session", "b1", "first")),
          )
          expect(failed._tag).toBe("Failure")

          yield* runAgentLoop(agentLoop, makeMessage("checkpoint-recreate-session", "b1", "second"))

          expect(providerCalls).toBe(1)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("failed queue checkpoint leaves queued follow-up out of memory", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ),
        ),
      generate: () => Effect.succeed("test response"),
    })
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      checkpointStorageLayer({ failUpsertOn: 2 }),
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
      ModelRegistry.Test(),
    )
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, Layer.provide(EventPublisherLive, deps)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("checkpoint-queue-session", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)

          const queued = yield* Effect.exit(
            submitAgentLoop(agentLoop, makeMessage("checkpoint-queue-session", "b1", "queued")),
          )
          expect(queued._tag).toBe("Failure")

          const snapshot = yield* agentLoop.getQueue({
            sessionId: "checkpoint-queue-session",
            branchId: "b1",
          })
          expect(snapshot).toEqual(emptyQueueSnapshot())

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("turn-control follow-up fails only after durable queue mutation fails", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ),
        ),
      generate: () => Effect.succeed("test response"),
    })
    const turnControlLayer = ExtensionTurnControl.Live
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      checkpointStorageLayer({ failUpsertOn: 2 }),
      providerLayer,
      makeExtRegistry(),
      MachineEngine.Test(),
      turnControlLayer,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      EventStore.Memory,
      ToolRunner.Test(),
      BunServices.layer,
      ResourceManagerLive,
      ModelRegistry.Test(),
    )
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, Layer.provide(EventPublisherLive, deps)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const turnControl = yield* ExtensionTurnControl
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("turn-control-checkpoint-session", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)

          const queued = yield* Effect.exit(
            turnControl.queueFollowUp({
              sessionId: SessionId.make("turn-control-checkpoint-session"),
              branchId: BranchId.make("b1"),
              content: "queued",
            }),
          )
          expect(queued._tag).toBe("Failure")
          if (queued._tag === "Failure") {
            const error = Cause.squash(queued.cause)
            expect(error).toBeInstanceOf(TurnControlError)
            expect((error as TurnControlError).command).toBe("QueueFollowUp")
            expect((error as TurnControlError).message).toContain("Failed to apply QueueFollowUp")
          }

          const snapshot = yield* agentLoop.getQueue({
            sessionId: "turn-control-checkpoint-session",
            branchId: "b1",
          })
          expect(snapshot).toEqual(emptyQueueSnapshot())

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      ),
    )
  })

  test("failed drain checkpoint leaves queued follow-up in memory", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())
    const firstStarted = await Effect.runPromise(Deferred.make<void>())
    const providerLayer = Layer.succeed(Provider, {
      stream: () =>
        Effect.succeed(
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(gate)
              return finishPart({ finishReason: "stop" })
            }),
          ),
        ),
      generate: () => Effect.succeed("test response"),
    })
    const deps = Layer.mergeAll(
      Storage.TestWithSql(),
      checkpointStorageLayer({ failUpsertOn: 3 }),
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
      ModelRegistry.Test(),
    )
    const layer = Layer.provideMerge(
      AgentLoop.Live({ baseSections: [] }),
      Layer.merge(deps, Layer.provide(EventPublisherLive, deps)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("checkpoint-drain-session", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, makeMessage("checkpoint-drain-session", "b1", "queued"))

          const drained = yield* Effect.exit(
            agentLoop.drainQueue({
              sessionId: "checkpoint-drain-session",
              branchId: "b1",
            }),
          )
          expect(drained._tag).toBe("Failure")

          const snapshot = yield* agentLoop.getQueue({
            sessionId: "checkpoint-drain-session",
            branchId: "b1",
          })
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued" }),
          ])

          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
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
    const sessionId = SessionId.make("session-loop-recovery")
    const branchId = BranchId.make("branch-loop-recovery")
    const message = Message.Regular.make({
      id: MessageId.make("message-loop-recovery"),
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
    providerParts?: ReadonlyArray<ProviderStreamPart>
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
        scope: "builtin",
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
              params.providerParts ?? [
                textDeltaPart("recovered assistant"),
                finishPart({ finishReason: "stop" }),
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
      ModelRegistry.Test(),
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

  const toLegacyCheckpointJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => toLegacyCheckpointJson(item))
    if (typeof value !== "object" || value === null) return value
    const record = value as Record<string, unknown>
    const entries = Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, toLegacyCheckpointJson(entry)]),
    )
    if (
      (entries._tag === "regular" || entries._tag === "interjection") &&
      typeof entries.id === "string" &&
      typeof entries.sessionId === "string" &&
      typeof entries.branchId === "string" &&
      Array.isArray(entries.parts)
    ) {
      const { _tag, ...legacy } = entries
      return { ...legacy, kind: _tag }
    }
    return entries
  }

  test("decodes v1 checkpoints with legacy message kind markers", async () => {
    const { message } = createSessionState()
    const interjection = Message.Interjection.make({
      id: MessageId.make("legacy-interjection"),
      sessionId: message.sessionId,
      branchId: message.branchId,
      role: "user",
      parts: [new TextPart({ type: "text", text: "legacy steer" })],
      createdAt: new Date(),
    })

    const record = await Effect.runPromise(
      buildLoopCheckpointRecord({
        sessionId: message.sessionId,
        branchId: message.branchId,
        state: LoopState.Idle.make({ currentAgent: AgentName.make("cowork") }),
        queue: appendSteeringItem(emptyLoopQueueState(), { message: interjection }),
      }),
    )
    const legacyJson = JSON.stringify(toLegacyCheckpointJson(JSON.parse(record.stateJson)))

    const decoded = await Effect.runPromise(decodeLoopCheckpointState(legacyJson))
    expect(decoded.queue.steering[0]?.message._tag).toBe("interjection")
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
              (s) => s._tag === "Idle",
            )

            expect(state._tag).toBe("Idle")
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
      const queuedMessage = Message.Regular.make({
        id: MessageId.make("queued-msg"),
        sessionId: message.sessionId,
        branchId: message.branchId,
        role: "user",
        parts: [new TextPart({ type: "text", text: "queued" })],
        createdAt: new Date(),
      })

      const idleWithQueue = LoopState.Idle.make({
        currentAgent: AgentName.make("cowork"),
      })
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
              (s) => s._tag === "Idle",
            )

            expect(state._tag).toBe("Idle")
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

            expect(state._tag).toBe("Idle")
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
