import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Cause, Clock, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SingleRunner } from "effect/unstable/cluster"
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import { dateFromMillis, Branch, Session } from "@gent/core/domain/message"
import type { QueueSnapshot } from "@gent/core/domain/queue"
import { textStep } from "@gent/core/debug/provider"
import { EventEnvelope, EventId, EventStoreError, type AgentEvent } from "@gent/core/domain/event"
import { tool, ToolNeeds, type ToolCapability } from "@gent/core/extensions/api"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "@gent/core/test-utils/language-model"
import { ModelResolver } from "@gent/core/providers/model-resolver"
import { EventPublisher, EventPublisherLive } from "@gent/core/domain/event-publisher"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { RecordingEventStore, SequenceRecorder, type CallRecord } from "@gent/core/test-utils"
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
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { ResourceManagerLive } from "../../src/runtime/resource-manager"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import { SessionCommands } from "../../src/server/session-commands"
import { SqliteStorage } from "@gent/core/storage/sqlite-storage"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { EventStorage } from "@gent/core/storage/event-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { SessionRuntime, interruptPayloadToSteerCommand } from "../../src/runtime/session-runtime"
import type { ExtensionContributions } from "../../src/domain/extension.js"
const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>
const makeTestExtensions = (tools: ReadonlyArray<ToolCapability> = []) => {
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
const sessionRuntimeLayers = (baseSections: Parameters<typeof SessionRuntime.Live>[0]) =>
  SessionRuntime.LiveWithEntity(baseSections)
const makeClusterRunnerLayer = (storageLayer: ReturnType<typeof SqliteStorage.TestWithSql>) =>
  Layer.provide(SingleRunner.layer({ runnerStorage: "memory" }), storageLayer)
const makeRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  profileCacheLayer?: Layer.Layer<SessionProfileCache>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql()
  const baseDepsWithoutProfile = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const baseDeps =
    profileCacheLayer === undefined
      ? baseDepsWithoutProfile
      : Layer.merge(baseDepsWithoutProfile, profileCacheLayer)
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const sessionRuntimeLayer = Layer.provide(
    sessionRuntimeLayers({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  return Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer, sessionMutationsLayer)
}
const makeRuntimeLayerWithEventPublisher = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  eventPublisherLayer: Layer.Layer<EventPublisher, never, EventStorage>,
) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql()
  const baseDeps = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, baseDeps)
  const sessionRuntimeLayer = Layer.provide(
    sessionRuntimeLayers({ baseSections: [] }),
    Layer.merge(baseDeps, providedEventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, providedEventPublisherLayer, sessionRuntimeLayer),
  )
  return Layer.mergeAll(
    baseDeps,
    providedEventPublisherLayer,
    sessionRuntimeLayer,
    sessionMutationsLayer,
  )
}
const makeLiveToolRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql()
  const baseDeps = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    eventStoreLayer,
    recorderLayer,
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ResourceManagerLive,
    ModelRegistry.Test(),
    GentPlatform.Test(),
  )
  const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
  const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
  return Layer.provideMerge(
    sessionRuntimeLayers({ baseSections: [] }),
    Layer.merge(deps, eventPublisherLayer),
  )
}
const createSessionBranch = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const sessionId = SessionId.make("runtime-session")
  const branchId = BranchId.make("runtime-branch")
  const now = dateFromMillis(1_767_225_600_000)
  yield* sessionStorage.createSession(
    new Session({
      id: sessionId,
      name: "Runtime Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branchStorage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return { sessionId, branchId }
})
const createCwdSessionBranch = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const sessionId = SessionId.make("runtime-session-with-cwd")
  const branchId = BranchId.make("runtime-branch-with-cwd")
  const now = dateFromMillis(1_767_225_600_000)
  yield* sessionStorage.createSession(
    new Session({
      id: sessionId,
      name: "Runtime Test With Cwd",
      cwd: "/tmp/profile-breaks",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branchStorage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
  return { sessionId, branchId }
})
const createSessionBranchWithIds = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
}) =>
  Effect.gen(function* () {
    const sessionStorage = yield* SessionStorage
    const branchStorage = yield* BranchStorage
    const now = dateFromMillis(1_767_225_600_000)
    yield* sessionStorage.createSession(
      new Session({
        id: input.sessionId,
        name: `Runtime Test ${input.sessionId}`,
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* branchStorage.createBranch(
      new Branch({ id: input.branchId, sessionId: input.sessionId, createdAt: now }),
    )
    return input
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
  return LanguageModelLayers.testStream(() => {
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
        ] satisfies LanguageModelStreamPart[]),
      )
    }
    return Effect.succeed(
      Stream.fromIterable([
        textDeltaPart("done"),
        finishPart({ finishReason: "stop" }),
      ] satisfies LanguageModelStreamPart[]),
    )
  })
}
describe("SessionRuntime", () => {
  it.live("validates branch ownership and idle follow-up persistence", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const sendTarget = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("runtime-target-first"),
            branchId: BranchId.make("runtime-target-first-branch"),
          })
          const sendForeign = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("runtime-target-second"),
            branchId: BranchId.make("runtime-target-second-branch"),
          })
          const sendExit = yield* Effect.exit(
            sessionRuntime.sendUserMessage({
              sessionId: sendTarget.sessionId,
              branchId: sendForeign.branchId,
              content: "wrong branch",
            }),
          )
          expect(sendExit._tag).toBe("Failure")
          if (sendExit._tag === "Failure") {
            expect(Cause.pretty(sendExit.cause)).toContain("Branch not found for session")
          }

          const { sessionId } = yield* createSessionBranch
          const readExit = yield* Effect.exit(
            sessionRuntime.getState({
              sessionId,
              branchId: BranchId.make("runtime-target-missing-branch"),
            }),
          )
          expect(readExit._tag).toBe("Failure")
          if (readExit._tag === "Failure") {
            expect(Cause.pretty(readExit.cause)).toContain("Branch not found for session")
          }

          const queueTarget = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("runtime-queue-first"),
            branchId: BranchId.make("runtime-queue-first-branch"),
          })
          const queueForeign = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("runtime-queue-second"),
            branchId: BranchId.make("runtime-queue-second-branch"),
          })
          const queueExit = yield* Effect.exit(
            sessionRuntime.queueFollowUp({
              sessionId: queueTarget.sessionId,
              branchId: queueForeign.branchId,
              content: "wrong branch",
            }),
          )
          expect(queueExit._tag).toBe("Failure")
          if (queueExit._tag === "Failure") {
            expect(Cause.pretty(queueExit.cause)).toContain("Branch not found for session")
          }
          const firstQueue = yield* sessionRuntime.getQueuedMessages(queueTarget)
          const secondQueue = yield* sessionRuntime.getQueuedMessages(queueForeign)
          expect(firstQueue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)
          expect(secondQueue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)

          const target = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("runtime-queue-direct"),
            branchId: BranchId.make("runtime-queue-direct-branch"),
          })
          yield* sessionRuntime.queueFollowUp({
            ...target,
            content: "direct follow-up",
          })
          const queue = yield* sessionRuntime.getQueuedMessages(target)
          expect(queue.steering).toEqual([])
          expect(queue.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "direct follow-up" }),
          ])
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("control-plane writes check session existence without resolving profiles", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const profileCacheLayer = Layer.succeed(SessionProfileCache, {
        resolve: () => Effect.die("control-plane writes must not resolve session profiles"),
      })
      const layer = makeRuntimeLayer(providerLayer, [], profileCacheLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createCwdSessionBranch
          yield* sessionRuntime.steer(
            interruptPayloadToSteerCommand({
              _tag: "Cancel",
              sessionId,
              branchId,
            }),
          )
          yield* sessionRuntime.respondInteraction({
            sessionId,
            branchId,
            requestId: InteractionRequestId.make("req-not-waiting"),
          })
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live(
    "sendUserMessage keeps agentOverride turn-scoped and leaves the default agent selected",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
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
            const messageStorage = yield* MessageStorage
            const recorder = yield* SequenceRecorder
            const { sessionId, branchId } = yield* createSessionBranch
            yield* sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "first",
              agentOverride: AgentName.make("memory:reflect"),
            })
            yield* sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "second",
            })
            const messages = yield* waitFor(
              messageStorage.listMessages(branchId),
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
  it.live("persists tool messages without queueing or duplicating durable results", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const recorder = yield* SequenceRecorder
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.invokeTool({
            sessionId,
            branchId,
            toolName: "read",
            input: {},
          })
          const messages = yield* waitFor(
            messageStorage.listMessages(branchId),
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

          const baselineSucceeded = eventTags(calls).filter(
            (tag) => tag === "ToolCallSucceeded",
          ).length
          const retryTarget = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("record-tool-idempotent-session"),
            branchId: BranchId.make("record-tool-idempotent-branch"),
          })
          const commandId = ActorCommandId.make("record-tool-idempotent")
          const command = {
            commandId,
            ...retryTarget,
            toolCallId: ToolCallId.make("tool-call-idempotent"),
            toolName: "read",
            output: { ok: true },
          }
          yield* sessionRuntime.recordToolResult(command)
          yield* sessionRuntime.recordToolResult(command)
          const retryMessages = yield* messageStorage.listMessages(retryTarget.branchId)
          const afterRetryCalls = yield* recorder.getCalls()
          const toolSucceeded = eventTags(afterRetryCalls).filter(
            (tag) => tag === "ToolCallSucceeded",
          )
          expect(retryMessages.filter((message) => message.role === "tool")).toHaveLength(1)
          expect(toolSucceeded.length - baselineSucceeded).toBe(1)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult rolls back the tool message when durable event append fails", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const failingPublisherLayer = Layer.succeed(EventPublisher, {
        append: (event: AgentEvent) =>
          event._tag === "ToolCallSucceeded"
            ? Effect.fail(new EventStoreError({ message: "append failed" }))
            : Effect.gen(function* () {
                return EventEnvelope.make({
                  id: EventId.make(0),
                  event,
                  createdAt: yield* Clock.currentTimeMillis,
                })
              }),
        deliver: () => Effect.void,
        publish: () => Effect.void,
      })
      const layer = makeRuntimeLayerWithEventPublisher(providerLayer, failingPublisherLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          const commandId = ActorCommandId.make("record-tool-atomicity")
          const exit = yield* Effect.exit(
            sessionRuntime.recordToolResult({
              commandId,
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-atomicity"),
              toolName: "read",
              output: { ok: true },
            }),
          )
          const message = yield* messageStorage.getMessage(
            MessageId.make(`${commandId}:tool-result`),
          )
          expect(exit._tag).toBe("Failure")
          expect(message).toBeUndefined()
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult commands are serialized per session", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const firstDeliveryStarted = yield* Deferred.make<void>()
      const releaseDelivery = yield* Deferred.make<void>()
      let deliveredToolResults = 0
      const eventPublisherLayer = Layer.effect(
        EventPublisher,
        Effect.gen(function* () {
          const eventStorage = yield* EventStorage
          const append = (event: AgentEvent) =>
            eventStorage
              .appendEvent(event)
              .pipe(
                Effect.mapError(
                  (error) => new EventStoreError({ message: error.message, cause: error }),
                ),
              )
          const deliver = (envelope: EventEnvelope) =>
            Effect.gen(function* () {
              if (envelope.event._tag !== "ToolCallSucceeded") return
              deliveredToolResults++
              if (deliveredToolResults === 1) {
                yield* Deferred.succeed(firstDeliveryStarted, undefined)
                yield* Deferred.await(releaseDelivery)
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
          })
        }),
      )
      const layer = makeRuntimeLayerWithEventPublisher(providerLayer, eventPublisherLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const first = {
            commandId: ActorCommandId.make("record-tool-serialize-a"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-a"),
            toolName: "read",
            output: { value: "a" },
          }
          const second = {
            commandId: ActorCommandId.make("record-tool-serialize-b"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-b"),
            toolName: "read",
            output: { value: "b" },
          }
          const firstFiber = yield* Effect.forkChild(sessionRuntime.recordToolResult(first))
          yield* Deferred.await(firstDeliveryStarted).pipe(Effect.timeout("5 seconds"))
          const secondFiber = yield* Effect.forkChild(sessionRuntime.recordToolResult(second))
          const earlySecond = yield* Fiber.join(secondFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlySecond._tag).toBe("None")
          expect(deliveredToolResults).toBe(1)
          yield* Deferred.succeed(releaseDelivery, undefined)
          yield* Fiber.join(firstFiber)
          yield* Fiber.join(secondFiber)
          expect(deliveredToolResults).toBe(2)
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("recordToolResult waits for the active turn mutation owner", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "hold the turn open",
            }),
          )
          yield* Deferred.await(streamStarted).pipe(Effect.timeout("5 seconds"))
          const recordFiber = yield* Effect.forkChild(
            sessionRuntime.recordToolResult({
              commandId: ActorCommandId.make("record-tool-active-owner"),
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-active-owner"),
              toolName: "read",
              output: { value: "blocked until turn completes" },
            }),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(Effect.timeoutOption("1 millis"))
          const messagesBeforeRelease = yield* messageStorage.listMessages(branchId)
          expect(earlyRecord._tag).toBe("None")
          expect(messagesBeforeRelease.some((message) => message.role === "tool")).toBe(false)
          yield* Deferred.succeed(streamReleased, undefined)
          yield* Fiber.join(submitFiber)
          yield* Fiber.join(recordFiber)
          const messagesAfterRelease = yield* waitFor(
            messageStorage.listMessages(branchId),
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
  it.live("terminateSession interrupts an active turn while tool result delivery is waiting", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          const submitFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({
              sessionId,
              branchId,
              content: "hold the turn open",
            }),
          )
          yield* Deferred.await(streamStarted).pipe(Effect.timeout("5 seconds"))
          const recordFiber = yield* Effect.forkChild(
            sessionRuntime.recordToolResult({
              commandId: ActorCommandId.make("record-tool-terminate-owner"),
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-terminate-owner"),
              toolName: "read",
              output: { value: "blocked until turn completes" },
            }),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlyRecord._tag).toBe("None")

          yield* sessionRuntime.terminateSession(sessionId).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(submitFiber).pipe(Effect.ignore)
          yield* Fiber.join(recordFiber).pipe(Effect.ignore)
          const afterTerminate = yield* Effect.exit(
            sessionRuntime.getState({ sessionId, branchId }),
          )
          expect(afterTerminate._tag).toBe("Failure")
          yield* Deferred.succeed(streamReleased, undefined).pipe(Effect.ignore)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("steer interject interrupts the active turn ahead of queued follow-ups", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertRequest: (request) => {
            expect(request.model).toBe("test/default")
          },
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("first")
          },
        },
        {
          ...textStep("steer reply"),
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("steer now")
          },
        },
        {
          ...textStep("queued reply"),
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("queued")
          },
        },
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.sendUserMessage({ sessionId, branchId, content: "first" })
          yield* controls.waitForCall(0)
          yield* sessionRuntime.sendUserMessage({ sessionId, branchId, content: "queued" })
          yield* sessionRuntime.steer(
            interruptPayloadToSteerCommand({
              _tag: "Interject",
              sessionId,
              branchId,
              message: "steer now",
            }),
          )
          yield* controls.emitAll(0)
          const messages = yield* waitFor(
            messageStorage.listMessages(branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 3,
            5000,
            "interjected turn completion",
          )
          expect(
            messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.parts.find((part) => part.type === "text")?.text),
          ).toEqual(["first reply", "steer reply", "queued reply"])
          yield* controls.assertDone()
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("sendUserMessage concurrent with turn completion runs the follow-up once", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("first")
          },
        },
        {
          ...textStep("second reply"),
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("second")
          },
        },
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.sendUserMessage({ sessionId, branchId, content: "first" })
          yield* controls.waitForCall(0)
          const emitFiber = yield* Effect.forkChild(controls.emitAll(0))
          const followUpFiber = yield* Effect.forkChild(
            sessionRuntime.sendUserMessage({ sessionId, branchId, content: "second" }),
          )
          yield* Fiber.join(emitFiber)
          yield* Fiber.join(followUpFiber)
          const messages = yield* waitFor(
            messageStorage.listMessages(branchId),
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
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        {
          ...textStep("first reply"),
          gated: true,
          assertOptions: (options) => {
            expect(latestUserText(options)).toBe("first")
          },
        },
        textStep("should not run"),
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.sendUserMessage({ sessionId, branchId, content: "first" })
          yield* controls.waitForCall(0)
          yield* sessionRuntime.sendUserMessage({ sessionId, branchId, content: "drain me" })
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
            (yield* messageStorage.listMessages(branchId)).filter(
              (message) => message.role === "user",
            ),
          ).toHaveLength(1)
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
  it.live("dispatch RespondInteraction resumes a waiting interaction through the live loop", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const toolDef = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolRuntimeLayer(makeInteractionProviderLayer(), [toolDef])
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.sendUserMessage({
            sessionId,
            branchId,
            content: "trigger interaction",
          })
          yield* waitFor(
            sessionRuntime.getState({ sessionId, branchId }),
            (current) => current._tag === "WaitingForInteraction",
            5000,
            "waiting interaction state",
          )
          yield* sessionRuntime.respondInteraction({
            sessionId,
            branchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
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
