import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Cause, Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { narrowR } from "../helpers/effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SingleRunner } from "effect/unstable/cluster"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import type { QueueSnapshot } from "@gent/core-internal/domain/queue"
import { textStep } from "@gent/core-internal/debug/provider"
import { type CallRecord } from "@gent/core-internal/test-utils"
import { ExtensionContext, tool, type ToolCapability } from "@gent/core/extensions/api"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { RecordingEventStore, SequenceRecorder } from "@gent/core-internal/test-utils"
import { ConfigService } from "../../src/runtime/config-service"
import { ApprovalService } from "../../src/runtime/approval-service"
import { AgentLoopSessionGovernance } from "../../src/runtime/agent/agent-loop.session-governance"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { Permission } from "@gent/core-internal/domain/permission"
import { InteractionPendingError } from "@gent/core-internal/domain/interaction-request"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ToolRunner } from "../../src/runtime/agent/tool-runner"
import { ModelRegistry } from "../../src/runtime/model-registry"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { SessionProfileCache } from "../../src/runtime/session-profile"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { SessionCommands } from "../../src/server/session-commands"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import type { ExtensionContributions } from "../../src/domain/extension.js"
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
  SessionRuntime.Live(baseSections)
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
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
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
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
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
    params: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({
      resolved: Schema.Boolean,
      value: Schema.String,
    }),
    execute: (params) =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
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
              sourceId: "wrong-branch",
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
            sourceId: "direct-follow-up",
            content: "direct follow-up",
          })
          yield* sessionRuntime.queueFollowUp({
            ...target,
            sourceId: "direct-follow-up",
            content: "direct follow-up",
          })
          const queue = yield* sessionRuntime.getQueuedMessages(target)
          expect(queue.steering).toEqual([])
          expect(queue.followUp).toEqual([
            expect.objectContaining({
              _tag: "follow-up",
              id: expect.stringContaining(":direct-follow-up"),
              content: "direct follow-up",
            }),
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
          yield* sessionRuntime.steer({
            _tag: "Cancel",
            sessionId,
            branchId,
            requestId: RequestId.make("req-cancel-profile-free"),
          })
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
            const stateStream = yield* sessionRuntime.watchState({ sessionId, branchId })
            const stateOption = yield* Stream.runHead(stateStream)
            expect(stateOption._tag).toBe("Some")
            if (stateOption._tag === "Some") {
              expect(stateOption.value._tag).toBe("Idle")
              expect(stateOption.value.agent).toBe(AgentName.make("cowork"))
            }
            const calls = yield* recorder.getCalls()
            expect(eventTags(calls)).not.toContain("AgentSwitched")
            yield* controls.assertDone()
          }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
        )
      }),
  )
  it.live("retried sendUserMessage requestId reuses the durable user message", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first reply"),
        textStep("duplicate reply"),
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          yield* sessionRuntime.sendUserMessage({
            sessionId,
            branchId,
            content: "first attempt",
            requestId: "req-runtime-send-1",
          })
          yield* sessionRuntime.sendUserMessage({
            sessionId,
            branchId,
            content: "retry should not create a new message",
            requestId: "req-runtime-send-1",
          })
          const messages = yield* waitFor(
            messageStorage.listMessages(branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 1,
            5000,
            "single assistant reply for retried send",
          )
          expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
          expect(messages[0]?.id).toBe(MessageId.make("message:req-runtime-send-1"))
          expect(messages[0]?.parts).toEqual([Prompt.textPart({ text: "first attempt" })])
          expect(yield* controls.callCount).toBe(1)
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
          yield* sessionRuntime.steer({
            _tag: "Interject",
            sessionId,
            branchId,
            requestId: RequestId.make("req-interject-queued"),
            message: "steer now",
          })
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
          const drained = yield* sessionRuntime.drainQueuedMessages({
            sessionId,
            branchId,
            requestId: "req-drain-follow-up",
          })
          const retried = yield* sessionRuntime.drainQueuedMessages({
            sessionId,
            branchId,
            requestId: "req-drain-follow-up",
          })
          expect(drained.followUp).toEqual([
            expect.objectContaining({ _tag: "follow-up", content: "drain me" }),
          ])
          expect(retried).toEqual(drained)
          expect(yield* sessionRuntime.getQueuedMessages({ sessionId, branchId })).toEqual({
            steering: [],
            followUp: [],
          } satisfies QueueSnapshot)
          yield* controls.emitAll(0)
          yield* waitFor(
            Effect.gen(function* () {
              const stream = yield* sessionRuntime.watchState({ sessionId, branchId })
              const state = yield* Stream.runHead(stream)
              return state._tag === "Some" ? state.value : undefined
            }),
            (state) => state?._tag === "Idle",
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
            Effect.gen(function* () {
              const stream = yield* sessionRuntime.watchState({ sessionId, branchId })
              const state = yield* Stream.runHead(stream)
              return state._tag === "Some" ? state.value : undefined
            }),
            (current) => current?._tag === "WaitingForInteraction",
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
            Effect.gen(function* () {
              const stream = yield* sessionRuntime.watchState({ sessionId, branchId })
              const state = yield* Stream.runHead(stream)
              return state._tag === "Some" ? state.value : undefined
            }),
            (current) => current?._tag === "Idle",
            5000,
            "idle after interaction response",
          )
          expect(state?._tag).toBe("Idle")
          expect(Ref.getUnsafe(callCount)).toBe(2)
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
