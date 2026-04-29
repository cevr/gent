import { describe, expect, test, it } from "effect-bun-test"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"
import { SqlClient } from "effect/unstable/sql"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { AgentLoop, type AgentLoopService } from "../../src/runtime/agent/agent-loop"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { resolveExtensions, ExtensionRegistry } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
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
  type ProviderRequest,
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
  ToolNeeds,
  type AnyResourceContribution,
  type ToolToken,
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
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids"
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
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const resolved = resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
        tools,
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
  agentLoop: AgentLoopService,
  message: Message,
  options?: Parameters<AgentLoopService["run"]>[1],
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() => agentLoop.run(message, options)),
  )
const submitAgentLoop = (
  agentLoop: AgentLoopService,
  message: Message,
  options?: Parameters<AgentLoopService["submit"]>[1],
) =>
  ensureStorageParents({ sessionId: message.sessionId, branchId: message.branchId }).pipe(
    Effect.flatMap(() => agentLoop.submit(message, options)),
  )
const makeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools, resources),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
const checkpointStorageLayer = (options?: {
  failUpsertOn?: number
  failGetOn?: number
  failRemoveOn?: number
}) => {
  let upsertCount = 0
  let getCount = 0
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
    get: (input) =>
      Effect.gen(function* () {
        getCount += 1
        if (options?.failGetOn === getCount) {
          return yield* new StorageError({
            message: "checkpoint get failed",
          })
        }
        return records.get(checkpointKey(input.sessionId, input.branchId))
      }),
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
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
  tools: ReadonlyArray<ToolToken> = [],
  resources: AnyResourceContribution[] = [],
) => {
  const turnControlLayer = ExtensionTurnControl.Live
  const extRegistry = makeExtRegistry(tools, resources)
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    extRegistry,
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
  tools: ReadonlyArray<ToolToken> = [],
) => {
  const deps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    makeExtRegistry(tools),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: Object.values(Agents),
      },
    },
    {
      manifest: { id: ExtensionId.make("external-parity") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [parityExternalAgent],
        externalDrivers: [
          {
            id: "test-parity-driver",
            executor: {
              executeTurn: () =>
                Stream.fromIterable<TurnEvent>(events) as Stream.Stream<TurnEvent, TurnError>,
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
    ExtensionRuntime.Test(),
    ActorEngine.Live,
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
  agentLoop: AgentLoopService,
  params: {
    sessionId: SessionId
    branchId: BranchId
  },
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
  it.live("concurrent sessions run independently", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
      yield* Effect.scoped(
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
      )
    }),
  )
  it.live("same session/branch serializes loop creation", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
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
      )
    }),
  )
  it.live("interrupt scoped to session/branch", () =>
    Effect.gen(function* () {
      const gateA = yield* Deferred.make<void>()
      const gateB = yield* Deferred.make<void>()
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const messageA = makeMessage("s1", "b1", "alpha")
          const messageB = makeMessage("s2", "b2", "beta")
          const fiberA = yield* Effect.forkChild(runAgentLoop(agentLoop, messageA))
          const fiberB = yield* Effect.forkChild(runAgentLoop(agentLoop, messageB))
          yield* Deferred.await(startedA)
          yield* Deferred.await(startedB)
          yield* agentLoop.steer({
            _tag: "Interrupt",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          const finishedA = yield* Fiber.join(fiberA).pipe(Effect.timeoutOption("200 millis"))
          expect(finishedA._tag).toBe("Some")
          const statusB = fiberB.pollUnsafe()
          expect(statusB).toBeUndefined()
          yield* Deferred.succeed(gateA, undefined)
          yield* Deferred.succeed(gateB, undefined)
          yield* Fiber.join(fiberB)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("batches queued messages into one follow-up", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
      yield* Effect.scoped(
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
          const messages = yield* storage.listMessages(BranchId.make("b1"))
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
      )
    }),
  )
  it.live("publishes StreamStarted and TurnCompleted events", () =>
    Effect.gen(function* () {
      const providerLayer = Layer.succeed(Provider, {
        stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
        generate: () => Effect.succeed("test response"),
      })
      const layer = makeRecordingLayer(providerLayer)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const recorder = yield* SequenceRecorder
          yield* runAgentLoop(agentLoop, makeMessage("s1", "b1", "inspect me"))
          const calls = yield* recorder.getCalls()
          const publishedEvents = calls
            .filter((call) => call.service === "EventStore" && call.method === "append")
            .map(
              (call) =>
                (
                  call.args as
                    | {
                        _tag?: string
                      }
                    | undefined
                )?._tag,
            )
            .filter((tag): tag is string => tag !== undefined)
          expect(publishedEvents).toContain("StreamStarted")
          expect(publishedEvents).toContain("TurnCompleted")
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("rolls back assistant message when durable MessageReceived append fails", () =>
    Effect.gen(function* () {
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
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("atomic-assistant-session", "atomic-assistant-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const assistant = yield* storage.getMessage(assistantMessageIdForTurn(message.id, 1))
        expect(exit._tag).toBe("Failure")
        expect(assistant).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("rolls back turn duration when TurnCompleted append fails", () =>
    Effect.gen(function* () {
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
      yield* Effect.gen(function* () {
        const agentLoop = yield* AgentLoop
        const storage = yield* Storage
        const message = makeMessage("atomic-turn-session", "atomic-turn-branch", "hello")
        const exit = yield* Effect.exit(runAgentLoop(agentLoop, message))
        const user = yield* storage.getMessage(message.id)
        expect(exit._tag).toBe("Failure")
        expect(user?.turnDurationMs).toBeUndefined()
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
  it.live("retries committed user event delivery without duplicating the durable event", () =>
    Effect.gen(function* () {
      const providerLayer = scriptedProvider([
        [textDeltaPart("after retry"), finishPart({ finishReason: "stop" })],
      ])
      const delivered: string[] = []
      const failingPublisherLayer = makePublisherFailingFirstMatchingDelivery(
        (event) => event._tag === "MessageReceived" && event.message.role === "user",
        delivered,
      )
      yield* Effect.gen(function* () {
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
      }).pipe(Effect.provide(makeLayerWithEventPublisher(providerLayer, failingPublisherLayer)))
    }),
  )
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
  it.live("interjection runs before queued follow-up with scoped agent override", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: Array<{
        model: string
        latestUserText: string
      }> = []
      let streamCount = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: (request: ProviderRequest) => {
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          yield* agentLoop.steer({
            _tag: "Interject",
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            message: "steer now",
            agent: AgentName.make("deepwork"),
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
      )
    }),
  )
  it.live("getQueue reads without draining", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
      yield* Effect.scoped(
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
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
            message: "steer now",
          })
          const snapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot.steering).toEqual([
            expect.objectContaining({ _tag: "steering", content: "steer now" }),
          ])
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued a\nqueued b" }),
          ])
          const secondSnapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(secondSnapshot).toEqual(snapshot)
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("flushes queued follow-ups after provider failure", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const providerCalls: string[] = []
      let streamCalls = 0
      const providerLayer = Layer.succeed(Provider, {
        stream: (request: ProviderRequest) => {
          const latestUserText =
            Prompt.make(request.prompt)
              .content.slice()
              .reverse()
              .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
              .find(
                (part: unknown): part is Prompt.TextPart =>
                  typeof part === "object" &&
                  part !== null &&
                  (
                    part as {
                      type?: unknown
                    }
                  ).type === "text",
              )?.text ?? ""
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const first = makeMessage("s1", "b1", "first")
          const queued = makeMessage("s1", "b1", "queued after failure")
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(firstStarted)
          yield* runAgentLoop(agentLoop, queued)
          const snapshotWhileRunning = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotWhileRunning.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued after failure" }),
          ])
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(providerCalls).toEqual(["first", "queued after failure"])
          const snapshotAfterFailure = yield* agentLoop.getQueue({
            sessionId: SessionId.make("s1"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshotAfterFailure).toEqual(emptyQueueSnapshot())
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
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
  it.live("serial tool calls do not overlap", () =>
    Effect.gen(function* () {
      const events: string[] = []
      let running = 0
      let maxRunning = 0
      const makeSerialTool = (name: string) =>
        tool({
          id: name,
          // All instances share one write need and therefore cannot overlap.
          needs: [ToolNeeds.write("test-serial")],
          description: `Serial tool ${name}`,
          params: Schema.Struct({}),
          execute: () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                running += 1
                maxRunning = Math.max(maxRunning, running)
                events.push(`start:${name}`)
              })
              yield* Effect.sleep(1)
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
            toolCallPart("serial-a", {}, { toolCallId: ToolCallId.make("tc-1") }),
            toolCallPart("serial-b", {}, { toolCallId: ToolCallId.make("tc-2") }),
            finishPart({ finishReason: "tool-calls" }),
          ],
          [finishPart({ finishReason: "stop" })],
        ]),
        [toolA, toolB],
      )
      yield* Effect.gen(function* () {
        const storage = yield* Storage
        const loop = yield* AgentLoop
        const now = new Date()
        const session = new Session({
          id: SessionId.make("serial-session"),
          name: "Serial Test",
          createdAt: now,
          updatedAt: now,
        })
        const branch = new Branch({
          id: BranchId.make("serial-branch"),
          sessionId: session.id,
          createdAt: now,
        })
        yield* storage.createSession(session)
        yield* storage.createBranch(branch)
        yield* loop.runOnce({
          sessionId: session.id,
          branchId: branch.id,
          agentName: AgentName.make("cowork"),
          prompt: "run serial tools",
        })
      }).pipe(Effect.provide(layer))
      expect(maxRunning).toBe(1)
      expect(events.length).toBe(4)
      expect(events[0]?.startsWith("start:")).toBe(true)
      expect(events[1]?.startsWith("end:")).toBe(true)
      expect(events[2]?.startsWith("start:")).toBe(true)
      expect(events[3]?.startsWith("end:")).toBe(true)
      expect(events[0]?.slice("start:".length)).toBe(events[1]?.slice("end:".length))
      expect(events[2]?.slice("start:".length)).toBe(events[3]?.slice("end:".length))
    }),
  )
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
        const tc = turnCompleted[0] as {
          interrupted?: boolean
        }
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
          (e) =>
            (
              e as {
                interrupted?: boolean
              }
            ).interrupted === true,
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
      ] as const
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
      expect((yield* Ref.get(modelEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
      expect((yield* Ref.get(externalEventsRef)).map((event) => event._tag as string)).toEqual([
        ...expectedTags,
      ])
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
      needs: [ToolNeeds.write("interaction")],
      params: Schema.Struct({ value: Schema.String }),
      execute: (
        params: {
          value: string
        },
        ctx: ToolContext,
      ) =>
        Effect.gen(function* () {
          const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
          if (count === 0) {
            return yield* new InteractionPendingError({
              requestId: InteractionRequestId.make("req-test-1"),
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
    tools: ReadonlyArray<ToolToken>,
    providerLayer?: Layer.Layer<Provider>,
  ) => {
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      Storage.TestWithSql(),
      providerLayer ?? makeInteractionProviderLayer(),
      makeExtRegistry(tools),
      ExtensionRuntime.Test(),
      ActorEngine.Live,
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
  it.live("tool triggers InteractionPendingError and machine parks", () =>
    Effect.gen(function* () {
      const callCount = Ref.makeUnsafe(0)
      const resolution = Deferred.makeUnsafe<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
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
            .map(
              (c) =>
                (
                  c.args as {
                    _tag: string
                  }
                )._tag,
            )
          expect(eventTags).toContain("ToolCallStarted")
          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("stale interaction response does not resume a different pending request", () =>
    Effect.gen(function* () {
      const callCount = Ref.makeUnsafe(0)
      const resolution = Deferred.makeUnsafe<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("stale interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-stale-1"),
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("WaitingForInteraction")
          expect(Ref.getUnsafe(callCount)).toBe(1)
          expect(yield* Deferred.isDone(resolution)).toBe(false)

          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt during WaitingForInteraction finalizes turn", () =>
    Effect.gen(function* () {
      const callCount = Ref.makeUnsafe(0)
      const resolution = Deferred.makeUnsafe<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])
      yield* Effect.scoped(
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
      )
    }),
  )
  it.live("respondInteraction is no-op when not in WaitingForInteraction", () =>
    Effect.gen(function* () {
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          yield* runAgentLoop(agentLoop, makeIntMessage("no interaction"))
          yield* agentLoop.respondInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("nonexistent"),
          })
          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("Idle")
        }).pipe(Effect.provide(loopLayer)),
      )
    }),
  )
  it.live("GUARD: interaction resume executes tool without new LLM call", () =>
    Effect.gen(function* () {
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
      yield* Effect.scoped(
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
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCallsRef)).toBe(2)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
// ============================================================================
// checkpoint persistence
// ============================================================================
describe("checkpoint persistence", () => {
  it.live("submit fails when saving the running checkpoint fails", () =>
    Effect.gen(function* () {
      const layer = makeCheckpointFailureLayer({ failUpsertOn: 1 })
      yield* Effect.scoped(
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
      )
    }),
  )
  it.live("run fails when removing the completed checkpoint fails", () =>
    Effect.gen(function* () {
      const layer = makeCheckpointFailureLayer({ failRemoveOn: 2 })
      yield* Effect.scoped(
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
      )
    }),
  )
  it.live("failed checkpoint save removes the dead loop so later turns can recreate it", () =>
    Effect.gen(function* () {
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const failed = yield* Effect.exit(
            submitAgentLoop(agentLoop, makeMessage("checkpoint-recreate-session", "b1", "first")),
          )
          expect(failed._tag).toBe("Failure")
          yield* runAgentLoop(agentLoop, makeMessage("checkpoint-recreate-session", "b1", "second"))
          expect(providerCalls).toBe(1)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("failed queue checkpoint leaves queued follow-up out of memory", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
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
            sessionId: SessionId.make("checkpoint-queue-session"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot).toEqual(emptyQueueSnapshot())
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("turn-control follow-up fails only after durable queue mutation fails", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
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
            sessionId: SessionId.make("turn-control-checkpoint-session"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot).toEqual(emptyQueueSnapshot())
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("failed drain checkpoint leaves queued follow-up in memory", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
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
        ExtensionRuntime.Test(),
        ActorEngine.Live,
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* AgentLoop
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeMessage("checkpoint-drain-session", "b1", "first")),
          )
          yield* Deferred.await(firstStarted)
          yield* submitAgentLoop(agentLoop, makeMessage("checkpoint-drain-session", "b1", "queued"))
          const drained = yield* Effect.exit(
            agentLoop.drainQueue({
              sessionId: SessionId.make("checkpoint-drain-session"),
              branchId: BranchId.make("b1"),
            }),
          )
          expect(drained._tag).toBe("Failure")
          const snapshot = yield* agentLoop.getQueue({
            sessionId: SessionId.make("checkpoint-drain-session"),
            branchId: BranchId.make("b1"),
          })
          expect(snapshot.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued" }),
          ])
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
})
// ============================================================================
// recovery
// ============================================================================
describe("recovery", () => {
  const idempotentTestTool = tool({
    id: "test-idempotent",
    description: "Test idempotent tool",
    needs: [ToolNeeds.read("recovery")],
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
        manifest: { id: ExtensionId.make("test-recovery") },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          agents: Object.values(Agents),
          tools: [idempotentTestTool],
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
      ExtensionRuntime.Test(),
      ActorEngine.Live,
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
  const waitFor = <A, E>(
    effect: Effect.Effect<A, E>,
    predicate: (value: A) => boolean,
    attempts = 50,
  ): Effect.Effect<A, E> =>
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
  const collectRecoveryAbandoned = (sessionId: SessionId, branchId: BranchId) =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      const envelopes = yield* eventStore.subscribe({ sessionId, branchId }).pipe(
        Stream.filter((envelope) => envelope.event._tag === "AgentLoopRecoveryAbandoned"),
        Stream.take(1),
        Stream.runCollect,
      )
      return Array.from(envelopes, (envelope) => envelope.event)
    })
  const toLegacyCheckpointJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => toLegacyCheckpointJson(item))
    if (typeof value !== "object" || value === null) return value
    const record = value as Record<string, unknown>
    const entries = Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, toLegacyCheckpointJson(entry)]),
    )
    if (
      (entries["_tag"] === "regular" || entries["_tag"] === "interjection") &&
      typeof entries["id"] === "string" &&
      typeof entries["sessionId"] === "string" &&
      typeof entries["branchId"] === "string" &&
      Array.isArray(entries["parts"])
    ) {
      const { _tag, ...legacy } = entries
      return { ...legacy, kind: _tag }
    }
    return entries
  }
  it.live("decodes v1 checkpoints with legacy message kind markers", () =>
    Effect.gen(function* () {
      const { message } = createSessionState()
      const interjection = Message.Interjection.make({
        id: MessageId.make("legacy-interjection"),
        sessionId: message.sessionId,
        branchId: message.branchId,
        role: "user",
        parts: [new TextPart({ type: "text", text: "legacy steer" })],
        createdAt: new Date(),
      })
      const record = yield* buildLoopCheckpointRecord({
        sessionId: message.sessionId,
        branchId: message.branchId,
        state: LoopState.Idle.make({ currentAgent: AgentName.make("cowork") }),
        queue: appendSteeringItem(emptyLoopQueueState(), { message: interjection }),
      })
      const legacyJson = JSON.stringify(toLegacyCheckpointJson(JSON.parse(record.stateJson)))
      const decoded = yield* decodeLoopCheckpointState(legacyJson)
      expect(decoded.queue.steering[0]?.message._tag).toBe("interjection")
    }),
  )
  it.live("recovers from Running checkpoint and completes the turn", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-running-"))
      const dbPath = path.join(dir, "data.db")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const { message } = createSessionState()
            const running = buildRunningState(
              { currentAgent: AgentName.make("cowork") },
              { message },
            )
            const providerCalls = Ref.makeUnsafe(0)
            const layer = makeRecoveryLayer({ dbPath, providerCalls })
            yield* Effect.scoped(
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
            )
          }),
        () =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
  it.live("recovers from Idle with queued follow-up", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-idle-queue-"))
      const dbPath = path.join(dir, "data.db")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
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
            yield* Effect.scoped(
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
            )
          }),
        () =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
  it.live("audits incompatible checkpoint version and starts fresh", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-stale-"))
      const dbPath = path.join(dir, "data.db")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const { message } = createSessionState()
            const running = buildRunningState(
              { currentAgent: AgentName.make("cowork") },
              { message },
            )
            const record = yield* buildLoopCheckpointRecord({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
              state: running,
              queue: emptyLoopQueueState(),
            })
            const staleRecord = { ...record, version: 999 }
            const providerCalls = Ref.makeUnsafe(0)
            const layer = makeRecoveryLayer({ dbPath, providerCalls })
            yield* Effect.scoped(
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
                const events = yield* collectRecoveryAbandoned(
                  running.message.sessionId,
                  running.message.branchId,
                )
                expect(events[0]?._tag).toBe("AgentLoopRecoveryAbandoned")
                if (events[0]?._tag === "AgentLoopRecoveryAbandoned") {
                  expect(events[0].reason).toBe("checkpoint-version-mismatch")
                }
              }).pipe(Effect.provide(layer)),
            )
          }),
        () =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
  it.live("audits undecodable checkpoint and starts fresh", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-bad-checkpoint-"))
      const dbPath = path.join(dir, "data.db")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const { message } = createSessionState()
            const running = buildRunningState(
              { currentAgent: AgentName.make("cowork") },
              { message },
            )
            const record = yield* buildLoopCheckpointRecord({
              sessionId: running.message.sessionId,
              branchId: running.message.branchId,
              state: running,
              queue: emptyLoopQueueState(),
            })
            const badRecord = { ...record, stateJson: '{"state":{"_tag":"Nope"}}' }
            const providerCalls = Ref.makeUnsafe(0)
            const layer = makeRecoveryLayer({ dbPath, providerCalls })
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* seedCheckpoint({
                  state: running,
                  queue: emptyLoopQueueState(),
                  checkpointRecord: badRecord,
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
                const events = yield* collectRecoveryAbandoned(
                  running.message.sessionId,
                  running.message.branchId,
                )
                expect(events[0]?._tag).toBe("AgentLoopRecoveryAbandoned")
                if (events[0]?._tag === "AgentLoopRecoveryAbandoned") {
                  expect(events[0].reason).toBe("checkpoint-decode-failed")
                }
              }).pipe(Effect.provide(layer)),
            )
          }),
        () =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
  it.live("fails closed when checkpoint read fails", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-checkpoint-read-fail-"))
      const dbPath = path.join(dir, "data.db")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const { message } = createSessionState()
            const running = buildRunningState(
              { currentAgent: AgentName.make("cowork") },
              { message },
            )
            const providerCalls = Ref.makeUnsafe(0)
            const layer = makeRecoveryLayer({ dbPath, providerCalls })
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* seedCheckpoint({ state: running, queue: emptyLoopQueueState() })
                const sql = yield* SqlClient.SqlClient
                yield* sql`DROP TABLE agent_loop_checkpoints`
                const agentLoop = yield* AgentLoop
                const exit = yield* agentLoop
                  .getState({
                    sessionId: running.message.sessionId,
                    branchId: running.message.branchId,
                  })
                  .pipe(Effect.exit)
                expect(Exit.isFailure(exit)).toBe(true)
                if (Exit.isFailure(exit)) {
                  expect(Cause.pretty(exit.cause)).toContain("Failed to read agent loop checkpoint")
                }
                expect(yield* Ref.get(providerCalls)).toBe(0)
                const events = yield* collectRecoveryAbandoned(
                  running.message.sessionId,
                  running.message.branchId,
                )
                expect(events[0]?._tag).toBe("AgentLoopRecoveryAbandoned")
                if (events[0]?._tag === "AgentLoopRecoveryAbandoned") {
                  expect(events[0].reason).toBe("checkpoint-read-failed")
                }
              }).pipe(Effect.provide(layer)),
            )
          }),
        () =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
})
// ============================================================================
// W8 regression: durable suspension + queue drain
// ============================================================================
//
// Verifies the two genuine FSM-justified behaviors are preserved by the
// post-W8 runtime (plain Effect fiber + Phase Ref + checkpoint):
//   1. Durable suspension across scope teardown (process death simulation):
//      a session in `WaitingForInteraction` survives a scope tear-down,
//      and `respondInteraction` against a fresh scope re-executes the
//      pending tool and finalizes the turn.
//   2. Queue drain order: while a turn is `Running`, multiple `submit`
//      calls enqueue and drain in submission order after `TurnDone`.
//
// Cites: `make-impossible-states-unrepresentable` (phase-tag invariants),
//        `redesign-from-first-principles` (post-W8 runtime carries the
//        same correctness load as the FSM did).
describe("W8 regression: durable suspension and queue drain", () => {
  // ── Suspension test ──
  const suspendSessionId = SessionId.make("session-loop-suspend")
  const suspendBranchId = BranchId.make("branch-loop-suspend")
  const makeSuspendMessage = (id: string, text: string) =>
    Message.Regular.make({
      id: MessageId.make(id),
      sessionId: suspendSessionId,
      branchId: suspendBranchId,
      role: "user",
      parts: [new TextPart({ type: "text", text })],
      createdAt: new Date(),
    })
  // Provider script: first stream() emits the interaction-tool call,
  // second emits a final text + stop. Tracks the call index so that
  // the second scope (post-tear-down) keeps advancing the script when
  // the resumed turn re-streams.
  const makeSuspendProviderLayer = (streamCallRef: Ref.Ref<number>, toolId: string) =>
    Layer.succeed(Provider, {
      stream: () =>
        Effect.gen(function* () {
          const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
          if (idx === 0) {
            return Stream.fromIterable([
              toolCallPart(
                toolId,
                { value: "suspend" },
                { toolCallId: ToolCallId.make("tc-suspend") },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies ProviderStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("resumed"),
            finishPart({ finishReason: "stop" }),
          ] satisfies ProviderStreamPart[])
        }),
      generate: () => Effect.succeed("test"),
    })
  // Build a per-scope live-tool layer pointed at the same dbPath. The
  // tool fixture closes over an external `callCount` Ref so its state
  // survives scope teardown (stand-in for any persistence external to
  // the Effect scope — DB, Redis, file system).
  const makeSuspendScopeLayer = (params: {
    dbPath: string
    streamCallRef: Ref.Ref<number>
    callCountRef: Ref.Ref<number>
    resolution: Deferred.Deferred<void>
  }) => {
    const interactionTool = tool({
      id: "suspend-interaction-tool",
      description: "Tool that suspends on first call and succeeds on resume",
      needs: [ToolNeeds.write("interaction")],
      params: Schema.Struct({ value: Schema.String }),
      execute: (
        toolParams: {
          value: string
        },
        ctx: ToolContext,
      ) =>
        Effect.gen(function* () {
          const count = yield* Ref.getAndUpdate(params.callCountRef, (n) => n + 1)
          if (count === 0) {
            return yield* new InteractionPendingError({
              requestId: InteractionRequestId.make("req-suspend-1"),
              sessionId: ctx.sessionId,
              branchId: ctx.branchId,
            })
          }
          yield* Deferred.succeed(params.resolution, void 0).pipe(
            Effect.catchEager(() => Effect.void),
          )
          return { resolved: true, value: toolParams.value }
        }),
    })
    const storageLayer = Storage.LiveWithSql(params.dbPath).pipe(
      Layer.provide(BunFileSystem.layer),
      Layer.provide(BunServices.layer),
    )
    const eventStoreLayer = Layer.provide(EventStoreLive, storageLayer)
    const providerLayer = makeSuspendProviderLayer(params.streamCallRef, interactionTool.id)
    const extRegistry = makeExtRegistry([interactionTool])
    const baseDeps = Layer.mergeAll(
      storageLayer,
      eventStoreLayer,
      providerLayer,
      extRegistry,
      ExtensionRuntime.Test(),
      ActorEngine.Live,
      ExtensionTurnControl.Live,
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
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
  it.live(
    "WaitingForInteraction survives scope teardown and resumes via respondInteraction",
    () =>
      Effect.gen(function* () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gent-loop-suspend-"))
        const dbPath = path.join(dir, "data.db")
        yield* Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.gen(function* () {
              // Cross-scope refs: stand in for state external to the Effect scope.
              // `callCountRef` tracks tool invocations (DB-equivalent), and
              // `streamCallRef` lets the provider keep advancing its script when
              // the resumed turn streams again under the second scope.
              const callCountRef = Ref.makeUnsafe(0)
              const streamCallRef = Ref.makeUnsafe(0)
              const scope1Resolution = Deferred.makeUnsafe<void>()
              // Scope 1: drive the loop until WaitingForInteraction, then exit.
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const agentLoop = yield* AgentLoop
                  const message = makeSuspendMessage("msg-suspend-1", "trigger interaction")
                  const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
                  yield* waitForPhase(
                    agentLoop,
                    { sessionId: suspendSessionId, branchId: suspendBranchId },
                    "WaitingForInteraction",
                  )
                  expect(yield* Ref.get(callCountRef)).toBe(1)
                  expect(yield* Ref.get(streamCallRef)).toBe(1)
                  // Interrupt the runAgentLoop fiber so scope teardown can
                  // proceed cleanly without inheriting the parked turn fiber.
                  yield* Fiber.interrupt(fiber)
                }).pipe(
                  Effect.provide(
                    makeSuspendScopeLayer({
                      dbPath,
                      streamCallRef,
                      callCountRef,
                      resolution: scope1Resolution,
                    }),
                  ),
                ),
              )
              // The scope is gone — including the in-memory `loops` map and
              // every Deferred the suspended turn was awaiting. Only the SQLite
              // DB at `dbPath` survives. This mirrors a process restart.
              // Scope 2: fresh layer (new in-memory state), same DB, same
              // cross-scope refs. respondInteraction must:
              //   - re-hydrate the loop from checkpoint (WaitingForInteraction),
              //   - dispatch InteractionResponded → forkTurn(Running),
              //   - re-execute the tool (count: 1 → 2 → resolves the tool),
              //   - the resumed turn streams a final text and reaches Idle.
              const scope2Resolution = Deferred.makeUnsafe<void>()
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const agentLoop = yield* AgentLoop
                  yield* agentLoop.respondInteraction({
                    sessionId: suspendSessionId,
                    branchId: suspendBranchId,
                    requestId: InteractionRequestId.make("req-suspend-1"),
                  })
                  yield* Deferred.await(scope2Resolution).pipe(Effect.timeout("5 seconds"))
                  expect(yield* Ref.get(callCountRef)).toBe(2)
                  const finalState = yield* waitForPhase(
                    agentLoop,
                    { sessionId: suspendSessionId, branchId: suspendBranchId },
                    "Idle",
                  )
                  expect(finalState._tag).toBe("Idle")
                  // The resumed turn must have driven the provider through
                  // its second response (text + stop), so streamCallRef
                  // advanced to 2 — proves the post-W8 runtime runs the
                  // full inner loop on resume, not just a result hand-back.
                  expect(yield* Ref.get(streamCallRef)).toBe(2)
                }).pipe(
                  Effect.provide(
                    makeSuspendScopeLayer({
                      dbPath,
                      streamCallRef,
                      callCountRef,
                      resolution: scope2Resolution,
                    }),
                  ),
                ),
              )
            }),
          () =>
            Effect.sync(() => {
              fs.rmSync(dir, { recursive: true, force: true })
            }),
        )
      }),
    15000,
  )
  // ── Queue drain test ──
  it.live(
    "multiple submits during a Running turn drain in submission order after TurnDone",
    () =>
      Effect.gen(function* () {
        const drainSessionId = SessionId.make("session-loop-drain")
        const drainBranchId = BranchId.make("branch-loop-drain")
        // Provider gates each turn on a per-turn Deferred so the test can
        // serialize "submit while Running" semantics deterministically.
        // First stream() call is gated by gates[0], second by gates[1], etc.
        // Each call records its index into `streamOrder` and returns a
        // simple text+stop response when its gate resolves.
        const gates = [
          Deferred.makeUnsafe<void>(),
          Deferred.makeUnsafe<void>(),
          Deferred.makeUnsafe<void>(),
          Deferred.makeUnsafe<void>(),
        ]
        const streamOrder = Ref.makeUnsafe<readonly number[]>([])
        const streamCallRef = Ref.makeUnsafe(0)
        const gatedProvider = Layer.succeed(Provider, {
          stream: () =>
            Effect.gen(function* () {
              const idx = yield* Ref.getAndUpdate(streamCallRef, (n) => n + 1)
              yield* Ref.update(streamOrder, (arr) => [...arr, idx])
              const gate = gates[idx]
              if (gate !== undefined) {
                yield* Deferred.await(gate)
              }
              return Stream.fromIterable([
                textDeltaPart(`turn-${idx}`),
                finishPart({ finishReason: "stop" }),
              ] satisfies ProviderStreamPart[])
            }),
          generate: () => Effect.succeed("test"),
        })
        const deps = Layer.mergeAll(
          Storage.TestWithSql(),
          gatedProvider,
          makeExtRegistry(),
          ExtensionRuntime.Test(),
          ActorEngine.Live,
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
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* AgentLoop
            // `interactive: true` disables follow-up batching in
            // `canBatchQueuedFollowUp` — without it, multiple plain-text
            // user submits collapse into a single combined turn before
            // they ever hit the queue drain.
            const submitOne = (id: string, text: string) =>
              submitAgentLoop(
                agentLoop,
                Message.Regular.make({
                  id: MessageId.make(id),
                  sessionId: drainSessionId,
                  branchId: drainBranchId,
                  role: "user",
                  parts: [new TextPart({ type: "text", text })],
                  createdAt: new Date(),
                }),
                { interactive: true },
              )
            // Submit turn #0; wait until the provider's stream() has
            // actually been entered (parked on gate[0]). Phase transitions
            // to Running before stream() is called, so we poll on
            // streamCallRef instead.
            yield* submitOne("msg-drain-0", "first")
            yield* Effect.gen(function* () {
              for (let i = 0; i < 200; i++) {
                if ((yield* Ref.get(streamCallRef)) >= 1) return
                yield* Effect.sleep("1 millis")
              }
              throw new Error("timed out waiting for first stream() call")
            })
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Submit #1, #2, #3 while #0 is still parked. They MUST
            // enqueue (Running → Running re-enter) — they cannot start
            // a new stream() until #0's gate releases.
            yield* submitOne("msg-drain-1", "second")
            yield* submitOne("msg-drain-2", "third")
            yield* submitOne("msg-drain-3", "fourth")
            // Confirm stream() was not re-entered.
            expect(yield* Ref.get(streamCallRef)).toBe(1)
            // Release all gates. Drain proceeds: #0 → #1 → #2 → #3.
            yield* Deferred.succeed(gates[0]!, void 0)
            yield* Deferred.succeed(gates[1]!, void 0)
            yield* Deferred.succeed(gates[2]!, void 0)
            yield* Deferred.succeed(gates[3]!, void 0)
            // Wait for full drain: stream call count must reach 4 and
            // loop returns to Idle.
            yield* waitForPhase(
              agentLoop,
              { sessionId: drainSessionId, branchId: drainBranchId },
              "Idle",
            )
            const finalCount = yield* Ref.get(streamCallRef)
            expect(finalCount).toBe(4)
            const order = yield* Ref.get(streamOrder)
            expect(order).toEqual([0, 1, 2, 3])
          }).pipe(Effect.provide(layer)),
        )
      }),
    15000,
  )
})
