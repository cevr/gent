import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import { Branch, Session } from "@gent/core/domain/message"
import type { QueueSnapshot } from "@gent/core/domain/queue"
import { textStep } from "@gent/core/debug/provider"
import { EventEnvelope, EventId, EventStoreError, type AgentEvent } from "@gent/core/domain/event"
import { tool, ToolNeeds, type ToolToken } from "@gent/core/extensions/api"
import {
  Provider,
  finishPart,
  textDeltaPart,
  toolCallPart,
  type ProviderStreamPart,
} from "@gent/core/providers/provider"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { EventPublisherLive } from "../../src/server/event-publisher"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { RecordingEventStore, SequenceRecorder, type CallRecord } from "@gent/core/test-utils"
import { CheckpointStorage } from "@gent/core/storage/checkpoint-storage"
import { ConfigService } from "../../src/runtime/config-service"
import { ApprovalService } from "../../src/runtime/approval-service"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core/domain/ids"
import { Permission } from "@gent/core/domain/permission"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRuntime } from "../../src/runtime/extensions/resource-host/extension-runtime"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control.js"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionCommands } from "../../src/server/session-commands"
import { Storage, StorageError } from "@gent/core/storage/sqlite-storage"
import {
  SessionRuntime,
  SessionRuntimeError,
  applySteerCommand,
  interruptPayloadToSteerCommand,
  invokeToolCommand,
  respondInteractionCommand,
  recordToolResultCommand,
  sendUserMessageCommand,
} from "../../src/runtime/session-runtime"
import type { ExtensionContributions } from "../../src/domain/extension.js"
import type { AgentLoopCheckpointRecord } from "../../src/runtime/agent/agent-loop.checkpoint"
const narrowR = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
const makeTestExtensions = (tools: ReadonlyArray<ToolToken> = []) => {
  const cowork = AgentDefinition.make({
    name: "cowork" as never,
    model: "test/default" as never,
  })
  const reflect = AgentDefinition.make({
    name: "memory:reflect" as never,
    model: "test/override" as never,
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [cowork, reflect],
        ...(tools.length > 0 ? { tools } : {}),
      } satisfies ExtensionContributions,
    },
  ])
}
const makeRuntimeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: ReadonlyArray<ToolToken> = [],
  profileCacheLayer?: Layer.Layer<SessionProfileCache>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const baseDepsWithoutProfile = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    SessionCwdRegistry.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    ModelRegistry.Test(),
  )
  const baseDeps =
    profileCacheLayer === undefined
      ? baseDepsWithoutProfile
      : Layer.merge(baseDepsWithoutProfile, profileCacheLayer)
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionMutationsLayer),
  )
}
const makeRuntimeLayerWithEventPublisher = (
  providerLayer: Layer.Layer<Provider>,
  eventPublisherLayer: Layer.Layer<EventPublisher, never, Storage>,
) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    SessionCwdRegistry.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    ModelRegistry.Test(),
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, baseDeps)
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(baseDeps, providedEventPublisherLayer),
  )
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, providedEventPublisherLayer, sessionMutationsLayer),
  )
}
const checkpointKey = (sessionId: SessionId, branchId: BranchId) => `${sessionId}:${branchId}`
const checkpointStorageLayer = (options: { failUpsertOn?: number; failRemoveOn?: number }) => {
  let upsertCount = 0
  let removeCount = 0
  const records = new Map<string, AgentLoopCheckpointRecord>()
  return Layer.succeed(CheckpointStorage, {
    upsert: (record) =>
      Effect.gen(function* () {
        upsertCount += 1
        if (options.failUpsertOn === upsertCount) {
          return yield* new StorageError({ message: "checkpoint upsert failed" })
        }
        records.set(checkpointKey(record.sessionId, record.branchId), record)
        return record
      }),
    get: (input) => Effect.succeed(records.get(checkpointKey(input.sessionId, input.branchId))),
    list: () => Effect.succeed(Array.from(records.values())),
    remove: (input) =>
      Effect.gen(function* () {
        removeCount += 1
        if (options.failRemoveOn === removeCount) {
          return yield* new StorageError({ message: "checkpoint remove failed" })
        }
        records.delete(checkpointKey(input.sessionId, input.branchId))
      }),
  })
}
const makeRuntimeLayerWithCheckpointFailure = (options: {
  failUpsertOn?: number
  failRemoveOn?: number
}) => {
  const providerLayer = Layer.succeed(Provider, {
    stream: () => Effect.succeed(Stream.fromIterable([finishPart({ finishReason: "stop" })])),
    generate: () => Effect.succeed("test"),
  })
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    checkpointStorageLayer(options),
    providerLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
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
          delivered.push(envelope.event._tag)
          if (!failed && matches(envelope.event)) {
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
const makeLiveToolRuntimeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: ReadonlyArray<ToolToken>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ExtensionRuntime.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    eventStoreLayer,
    recorderLayer,
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
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}
const createSessionBranch = Effect.gen(function* () {
  const storage = yield* Storage
  const sessionId = SessionId.make("runtime-session")
  const branchId = BranchId.make("runtime-branch")
  const now = new Date()
  yield* storage.createSession(
    new Session({
      id: sessionId,
      name: "Runtime Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return { sessionId, branchId }
})
const createCwdSessionBranch = Effect.gen(function* () {
  const storage = yield* Storage
  const sessionId = SessionId.make("runtime-session-with-cwd")
  const branchId = BranchId.make("runtime-branch-with-cwd")
  const now = new Date()
  yield* storage.createSession(
    new Session({
      id: sessionId,
      name: "Runtime Test With Cwd",
      cwd: "/tmp/profile-breaks",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* storage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return { sessionId, branchId }
})
const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
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
const latestUserText = (request: { readonly prompt: unknown }) =>
  [...Prompt.make(request.prompt as Prompt.RawInput).content]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n") ?? ""
const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
  tool({
    id: "interaction-tool",
    description: "Tool that triggers an interaction",
    needs: [ToolNeeds.write("interaction")],
    params: Schema.Struct({ value: Schema.String }),
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const count = yield* Ref.getAndUpdate(callCount, (current) => current + 1)
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
              { toolCallId: ToolCallId.make("tc-1") },
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
describe("SessionRuntime", () => {
  it.live("control-plane dispatch checks session existence without resolving profiles", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([])
      const profileCacheLayer = Layer.succeed(SessionProfileCache, {
        resolve: () => Effect.die("control-plane dispatch must not resolve session profiles"),
      })
      const layer = makeRuntimeLayer(providerLayer, [], profileCacheLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createCwdSessionBranch
          yield* sessionRuntime.dispatch(
            applySteerCommand(
              interruptPayloadToSteerCommand({
                _tag: "Cancel",
                sessionId,
                branchId,
              }),
            ),
          )
          yield* sessionRuntime.dispatch(
            respondInteractionCommand({
              sessionId,
              branchId,
              requestId: "req-not-waiting",
            }),
          )
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("dispatch SendUserMessage fails when saving the running checkpoint fails", () =>
    Effect.gen(function* () {
      const layer = makeRuntimeLayerWithCheckpointFailure({ failUpsertOn: 1 })
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const recorder = yield* SequenceRecorder
          const { sessionId, branchId } = yield* createSessionBranch
          const exit = yield* Effect.exit(
            sessionRuntime.dispatch(
              sendUserMessageCommand({
                sessionId,
                branchId,
                content: "persist this turn",
              }),
            ),
          )
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure") {
            const error = Cause.findErrorOption(exit.cause)
            expect(Option.isSome(error)).toBe(true)
            if (Option.isSome(error)) {
              expect(error.value).toBeInstanceOf(SessionRuntimeError)
              expect(error.value.message).toBe("dispatch failed")
            }
            expect(Cause.pretty(exit.cause)).toContain("checkpoint upsert failed")
          }
          expect(eventTags(yield* recorder.getCalls())).toContain("ErrorOccurred")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "sendUserMessage keeps agentOverride turn-scoped and leaves the default agent selected",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* Provider.Sequence([
          {
            ...textStep("override reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("test/override")
            },
          },
          {
            ...textStep("default reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("test/default")
            },
          },
        ])
        const layer = makeRuntimeLayer(providerLayer)
        yield* narrowR(
          Effect.gen(function* () {
            const sessionRuntime = yield* SessionRuntime
            const storage = yield* Storage
            const recorder = yield* SequenceRecorder
            const { sessionId, branchId } = yield* createSessionBranch
            yield* sessionRuntime.dispatch(
              sendUserMessageCommand({
                sessionId,
                branchId,
                content: "first",
                agentOverride: AgentName.make("memory:reflect"),
              }),
            )
            yield* sessionRuntime.dispatch(
              sendUserMessageCommand({
                sessionId,
                branchId,
                content: "second",
              }),
            )
            const messages = yield* waitFor(
              storage.listMessages(branchId),
              (current) => current.filter((message) => message.role === "assistant").length === 2,
              5000,
              "two assistant replies",
            )
            expect(messages.map((message) => message.role)).toEqual([
              "user",
              "assistant",
              "user",
              "assistant",
            ])
            const state = yield* waitFor(
              sessionRuntime.getState({ sessionId, branchId }),
              (current) => current._tag === "Idle",
              5000,
              "idle runtime state",
            )
            expect(state.agent).toBe(AgentName.make("cowork"))
            const calls = yield* recorder.getCalls()
            expect(eventTags(calls)).not.toContain("AgentSwitched")
            yield* controls.assertDone()
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
  )
  it.live("invokeTool persists assistant and tool messages without queueing a follow-up turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const recorder = yield* SequenceRecorder
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.dispatch(
            invokeToolCommand({
              sessionId,
              branchId,
              toolName: "read",
              input: {},
            }),
          )
          const messages = yield* waitFor(
            storage.listMessages(branchId),
            (current) => current.length === 2,
            5000,
            "invokeTool messages",
          )
          const queue = yield* sessionRuntime.getQueuedMessages({ sessionId, branchId })
          const calls = yield* recorder.getCalls()
          expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
          expect(messages[0]?.parts[0]?.type).toBe("tool-call")
          expect(messages[1]?.parts[0]?.type).toBe("tool-result")
          expect(queue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)
          expect(eventTags(calls)).toContain("ToolCallStarted")
          expect(eventTags(calls)).toContain("ToolCallSucceeded")
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult rolls back the tool message when durable event append fails", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "ToolCallSucceeded"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.succeed(
                EventEnvelope.make({ id: EventId.make(0), event, createdAt: Date.now() }),
              ),
        deliver: () => Effect.void,
        publish: () => Effect.void,
        terminateSession: () => Effect.void,
      })
      const layer = makeRuntimeLayerWithEventPublisher(providerLayer, failingPublisherLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch
          const commandId = ActorCommandId.make("record-tool-atomicity")
          const exit = yield* Effect.exit(
            sessionRuntime.dispatch(
              recordToolResultCommand({
                commandId,
                sessionId,
                branchId,
                toolCallId: ToolCallId.make("tool-call-atomicity"),
                toolName: "read",
                output: { ok: true },
              }),
            ),
          )
          const message = yield* storage.getMessage(MessageId.make(`${commandId}:tool-result`))
          expect(exit._tag).toBe("Failure")
          expect(message).toBeUndefined()
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult retry does not duplicate the durable event", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const recorder = yield* SequenceRecorder
          const { sessionId, branchId } = yield* createSessionBranch
          const commandId = ActorCommandId.make("record-tool-idempotent")
          const command = recordToolResultCommand({
            commandId,
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-idempotent"),
            toolName: "read",
            output: { ok: true },
          })
          yield* sessionRuntime.dispatch(command)
          yield* sessionRuntime.dispatch(command)
          const messages = yield* storage.listMessages(branchId)
          const calls = yield* recorder.getCalls()
          const toolSucceeded = eventTags(calls).filter((tag) => tag === "ToolCallSucceeded")
          expect(messages.filter((message) => message.role === "tool")).toHaveLength(1)
          expect(toolSucceeded).toHaveLength(1)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "recordToolResult retries committed event delivery without duplicating the durable event",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([])
        const delivered: string[] = []
        const eventPublisherLayer = makePublisherFailingFirstMatchingDelivery(
          (event) => event._tag === "ToolCallSucceeded",
          delivered,
        )
        const layer = makeRuntimeLayerWithEventPublisher(providerLayer, eventPublisherLayer)
        yield* narrowR(
          Effect.gen(function* () {
            const sessionRuntime = yield* SessionRuntime
            const storage = yield* Storage
            const { sessionId, branchId } = yield* createSessionBranch
            const commandId = ActorCommandId.make("record-tool-delivery-retry")
            const command = recordToolResultCommand({
              commandId,
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-delivery-retry"),
              toolName: "read",
              output: { ok: true },
            })
            const firstExit = yield* Effect.exit(sessionRuntime.dispatch(command))
            yield* sessionRuntime.dispatch(command)
            const messages = yield* storage.listMessages(branchId)
            const events = yield* storage.listEvents({ sessionId, branchId })
            const toolSucceeded = events.filter(
              (envelope) => envelope.event._tag === "ToolCallSucceeded",
            )
            expect(firstExit._tag).toBe("Failure")
            expect(messages.filter((message) => message.role === "tool")).toHaveLength(1)
            expect(toolSucceeded).toHaveLength(1)
            expect(delivered.filter((tag) => tag === "ToolCallSucceeded")).toHaveLength(2)
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
  )
  it.live("recordToolResult commands are serialized per session", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* Provider.Sequence([])
      let releaseFirstDelivery: () => void = () => {}
      let markFirstDeliveryStarted: () => void = () => {}
      const firstDeliveryStarted = new Promise<void>((resolve) => {
        markFirstDeliveryStarted = resolve
      })
      const releaseDelivery = new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve
      })
      let deliveredToolResults = 0
      const eventPublisherLayer = Layer.effect(
        EventPublisher,
        Effect.gen(function* () {
          const storage = yield* Storage
          const append = (event: AgentEvent) =>
            storage
              .appendEvent(event)
              .pipe(
                Effect.mapError(
                  (error) => new EventStoreError({ message: error.message, cause: error }),
                ),
              )
          const deliver = (envelope: EventEnvelope) =>
            Effect.promise(() => {
              if (envelope.event._tag !== "ToolCallSucceeded") return Promise.resolve()
              deliveredToolResults++
              if (deliveredToolResults === 1) {
                markFirstDeliveryStarted()
                return releaseDelivery
              }
              return Promise.resolve()
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
      const layer = makeRuntimeLayerWithEventPublisher(providerLayer, eventPublisherLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const first = recordToolResultCommand({
            commandId: ActorCommandId.make("record-tool-serialize-a"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-a"),
            toolName: "read",
            output: { value: "a" },
          })
          const second = recordToolResultCommand({
            commandId: ActorCommandId.make("record-tool-serialize-b"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-b"),
            toolName: "read",
            output: { value: "b" },
          })
          const firstFiber = yield* Effect.forkChild(sessionRuntime.dispatch(first))
          yield* Effect.promise(() => firstDeliveryStarted).pipe(Effect.timeout("5 seconds"))
          const secondFiber = yield* Effect.forkChild(sessionRuntime.dispatch(second))
          const earlySecond = yield* Fiber.join(secondFiber).pipe(
            Effect.timeoutOption("200 millis"),
          )
          expect(earlySecond._tag).toBe("None")
          expect(deliveredToolResults).toBe(1)
          releaseFirstDelivery()
          yield* Fiber.join(firstFiber)
          yield* Fiber.join(secondFiber)
          expect(deliveredToolResults).toBe(2)
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult waits for the active turn mutation owner", () =>
    Effect.gen(function* () {
      let markStreamStarted: () => void = () => {}
      let releaseStream: () => void = () => {}
      const streamStarted = new Promise<void>((resolve) => {
        markStreamStarted = resolve
      })
      const streamReleased = new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      const providerLayer = Layer.succeed(Provider, {
        stream: () =>
          Effect.promise(() => {
            markStreamStarted()
            return streamReleased.then(() =>
              Stream.fromIterable([
                textDeltaPart("done"),
                finishPart({ finishReason: "stop" }),
              ] satisfies ProviderStreamPart[]),
            )
          }),
        generate: () => Effect.succeed("test"),
      })
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.dispatch(
              sendUserMessageCommand({
                sessionId,
                branchId,
                content: "hold the turn open",
              }),
            ),
          )
          yield* Effect.promise(() => streamStarted).pipe(Effect.timeout("5 seconds"))
          const recordFiber = yield* Effect.forkChild(
            sessionRuntime.dispatch(
              recordToolResultCommand({
                commandId: ActorCommandId.make("record-tool-active-owner"),
                sessionId,
                branchId,
                toolCallId: ToolCallId.make("tool-call-active-owner"),
                toolName: "read",
                output: { value: "blocked until turn completes" },
              }),
            ),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(
            Effect.timeoutOption("200 millis"),
          )
          const messagesBeforeRelease = yield* storage.listMessages(branchId)
          expect(earlyRecord._tag).toBe("None")
          expect(messagesBeforeRelease.some((message) => message.role === "tool")).toBe(false)
          releaseStream()
          yield* Fiber.join(submitFiber)
          yield* Fiber.join(recordFiber)
          const messagesAfterRelease = yield* waitFor(
            storage.listMessages(branchId),
            (messages) => messages.some((message) => message.role === "tool"),
            5000,
            "tool result after active turn releases ownership",
          )
          expect(messagesAfterRelease.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "tool",
          ])
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("dispatch ApplySteer interjects ahead of queued follow-ups", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertRequest: (request) => {
            expect(request.model).toBe("test/default")
            expect(latestUserText(request)).toBe("first")
          },
        },
        {
          ...textStep("steer reply"),
          assertRequest: (request) => {
            expect(latestUserText(request)).toBe("steer now")
          },
        },
        {
          ...textStep("queued reply"),
          assertRequest: (request) => {
            expect(latestUserText(request)).toBe("queued")
          },
        },
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({ sessionId, branchId, content: "first" }),
          )
          yield* controls.waitForCall(0)
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({ sessionId, branchId, content: "queued" }),
          )
          yield* sessionRuntime.dispatch(
            applySteerCommand(
              interruptPayloadToSteerCommand({
                _tag: "Interject",
                sessionId,
                branchId,
                message: "steer now",
              }),
            ),
          )
          const queue = yield* sessionRuntime.getQueuedMessages({ sessionId, branchId })
          expect(queue.steering).toEqual([
            expect.objectContaining({ _tag: "steering", content: "steer now" }),
          ])
          expect(queue.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "queued" }),
          ])
          yield* controls.emitAll(0)
          const messages = yield* waitFor(
            storage.listMessages(branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 3,
            5000,
            "interjected turn completion",
          )
          expect(messages.filter((message) => message.role === "assistant")).toHaveLength(3)
          yield* controls.assertDone()
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("dispatch SendUserMessage concurrent with turn completion runs the follow-up once", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertRequest: (request) => {
            expect(latestUserText(request)).toBe("first")
          },
        },
        {
          ...textStep("second reply"),
          assertRequest: (request) => {
            expect(latestUserText(request)).toBe("second")
          },
        },
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({ sessionId, branchId, content: "first" }),
          )
          yield* controls.waitForCall(0)
          const emitFiber = yield* Effect.forkChild(controls.emitAll(0))
          const followUpFiber = yield* Effect.forkChild(
            sessionRuntime.dispatch(
              sendUserMessageCommand({ sessionId, branchId, content: "second" }),
            ),
          )
          yield* Fiber.join(emitFiber)
          yield* Fiber.join(followUpFiber)
          const messages = yield* waitFor(
            storage.listMessages(branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 2,
            5000,
            "concurrent follow-up completion",
          )
          expect(messages.filter((message) => message.role === "user")).toHaveLength(2)
          expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2)
          expect(yield* controls.callCount).toBe(2)
          yield* controls.assertDone()
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("drainQueuedMessages atomically clears follow-ups during an active turn", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* Provider.Sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertRequest: (request) => {
            expect(latestUserText(request)).toBe("first")
          },
        },
        textStep("should not run"),
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const storage = yield* Storage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({ sessionId, branchId, content: "first" }),
          )
          yield* controls.waitForCall(0)
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({ sessionId, branchId, content: "drain me" }),
          )
          const drained = yield* sessionRuntime.drainQueuedMessages({ sessionId, branchId })
          expect(drained.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "drain me" }),
          ])
          expect(yield* sessionRuntime.getQueuedMessages({ sessionId, branchId })).toEqual({
            steering: [],
            followUp: [],
          } satisfies QueueSnapshot)
          yield* controls.emitAll(0)
          yield* waitFor(
            sessionRuntime.getState({ sessionId, branchId }),
            (state) => state._tag === "Idle",
            5000,
            "idle after drained follow-up",
          )
          expect(yield* controls.callCount).toBe(1)
          expect(
            (yield* storage.listMessages(branchId)).filter((message) => message.role === "user"),
          ).toHaveLength(1)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("dispatch RespondInteraction resumes a waiting interaction through the live loop", () =>
    Effect.gen(function* () {
      const callCount = Ref.makeUnsafe(0)
      const resolution = Deferred.makeUnsafe<void>()
      const toolDef = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolRuntimeLayer(makeInteractionProviderLayer(), [toolDef])
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.dispatch(
            sendUserMessageCommand({
              sessionId,
              branchId,
              content: "trigger interaction",
            }),
          )
          yield* waitFor(
            sessionRuntime.getState({ sessionId, branchId }),
            (current) => current._tag === "WaitingForInteraction",
            5000,
            "waiting interaction state",
          )
          yield* sessionRuntime.dispatch(
            respondInteractionCommand({
              sessionId,
              branchId,
              requestId: "req-test-1",
            }),
          )
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          const state = yield* waitFor(
            sessionRuntime.getState({ sessionId, branchId }),
            (current) => current._tag === "Idle",
            5000,
            "idle after interaction response",
          )
          expect(state._tag).toBe("Idle")
          expect(Ref.getUnsafe(callCount)).toBe(2)
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
