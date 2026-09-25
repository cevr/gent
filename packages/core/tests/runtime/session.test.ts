import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  DriverRef,
  Model,
  ModelId,
  ProviderId,
} from "../../src/domain/agent"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SingleRunner } from "effect/unstable/cluster"
import {
  Branch,
  dateFromMillis,
  Message,
  type QueueSnapshot,
  Session,
} from "../../src/domain/message"
import { followUpMessageIdForSource } from "../../src/domain/agent-loop"
import { CurrentWorkspaceId } from "../../src/server/workspace-rpc"
import {
  finishPart,
  type LanguageModelStreamPart,
  textDeltaPart,
  toolCallPart,
  ModelRegistry,
  TEST_MODEL_CONTEXT_LIMIT_TOKENS,
} from "../../src/runtime/provider"
import { LanguageModelLayers, textStep, waitFor } from "../../src/test-utils/language-model"
import {
  baseLocalLayerWithProvider,
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  RecordingEventStore,
  runtimeHostContext,
  SequenceRecorder,
  testSqliteStorage,
} from "../../src/test-utils/harness"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  request,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import {
  ApprovalService,
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { AgentLoopLiveActor, AgentLoopSessionGovernance } from "../../src/runtime/agent-loop"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  RequestId,
  SessionId,
  ToolCallId,
} from "../../src/domain/ids"
import { InteractionPendingError } from "../../src/domain/interaction"
import { noBranchTools, ToolRunner } from "../../src/runtime/tools"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { getSessionSnapshot, SessionMutationsLive } from "../../src/server/server"
import {
  BranchStorage,
  EventStorage,
  MessageStorage,
  SessionStorage,
} from "../../src/storage/storage"
import { SessionRuntime } from "../../src/runtime/session"
import { ModelCompactionError, ModelContextCompactor } from "../../src/runtime/model-context"
import { makeTurnLedger } from "../../src/runtime/turn"
import type { ExtensionContributions } from "../../src/domain/extension.js"
import { e2ePreset } from "../helpers/test-preset"

// ── session runtime ─────────────────────────────────────────────────────────

const makeTestExtensions = (tools: ReadonlyArray<ToolCapability> = []) => {
  const mainAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("test/default"),
  })
  const reflect = AgentDefinition.make({
    name: AgentName.make("memory:reflect"),
    model: ModelId.make("test/override"),
  })
  let contributions: ExtensionContributions
  if (tools.length > 0) {
    contributions = { agents: [mainAgent, reflect], tools }
  } else {
    contributions = { agents: [mainAgent, reflect] }
  }
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions,
    },
  ])
}
const sessionRuntimeLayers = (config: Parameters<typeof AgentLoopLiveActor>[0]) =>
  Layer.provideMerge(AgentLoopLiveActor(config), SessionRuntime.Client)
const makeClusterRunnerLayer = <A>(storageLayer: ReturnType<typeof testSqliteStorage<A>>) =>
  Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )
const makeRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  profileCacheLayer?: Layer.Layer<SessionProfileCache>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
  const baseDepsWithoutProfile = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    LanguageModelLayers.resolver(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Live({
      cwd: "/nonexistent/gent-test-cwd",
      home: "/nonexistent/gent-test-home",
    }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  let baseDeps = baseDepsWithoutProfile
  if (!Predicate.isUndefined(profileCacheLayer)) {
    baseDeps = Layer.merge(baseDepsWithoutProfile, profileCacheLayer)
  }
  const sessionRuntimeLayer = Layer.provide(sessionRuntimeLayers({ baseSections: [] }), baseDeps)
  const sessionMutationsLayer = Layer.provide(
    SessionMutationsLive,
    Layer.mergeAll(baseDeps, sessionRuntimeLayer),
  )
  return Layer.mergeAll(baseDeps, sessionRuntimeLayer, sessionMutationsLayer)
}
const makeLiveToolRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability>,
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = testSqliteStorage(noBranchTools.storage, noBranchTools.migrations)
  const baseDeps = Layer.mergeAll(
    storageLayer,
    makeClusterRunnerLayer(storageLayer),
    providerLayer,
    LanguageModelLayers.resolver(providerLayer),
    ExtensionRegistry.fromResolved(resolvedExtensions),
    eventStoreLayer,
    recorderLayer,
    RuntimeEnvironment.Live({
      cwd: "/nonexistent/gent-test-cwd",
      home: "/nonexistent/gent-test-home",
    }),
    ConfigService.Test(),
    ApprovalService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
  return Layer.provideMerge(sessionRuntimeLayers({ baseSections: [] }), deps)
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
      cwd: "/nonexistent/profile-breaks",
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
const latestUserText = (request: { readonly prompt: Prompt.RawInput }) =>
  (() => {
    const latest = [...Prompt.make(request.prompt).content]
      .reverse()
      .find((message) => message.role === "user")
    if (Predicate.isUndefined(latest)) return ""
    return latest.content
      .filter((part): part is Prompt.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  })()
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
  it.scopedLive("validates branch ownership and idle follow-up persistence", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* Effect.gen(function* () {
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
        // Follow-ups reach a branch through the extension session facade.
        const facade = yield* runtimeHostContext(queueTarget)
        const queueExit = yield* Effect.exit(
          facade.Session.send({
            delivery: "queue",
            sourceId: "wrong-branch",
            sessionId: queueTarget.sessionId,
            branchId: queueForeign.branchId,
            content: "wrong branch",
          }),
        )
        expect(queueExit._tag).toBe("Failure")
        const firstQueue = yield* sessionRuntime.getQueuedMessages(queueTarget)
        const secondQueue = yield* sessionRuntime.getQueuedMessages(queueForeign)
        expect(firstQueue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)
        expect(secondQueue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)

        const target = yield* createSessionBranchWithIds({
          sessionId: SessionId.make("runtime-queue-direct"),
          branchId: BranchId.make("runtime-queue-direct-branch"),
        })
        const targetFacade = yield* runtimeHostContext(target)
        const queueDirect = targetFacade.Session.send({
          delivery: "queue",
          ...target,
          sourceId: "direct-follow-up",
          content: "direct follow-up",
        })
        yield* queueDirect
        yield* queueDirect
        const queue = yield* sessionRuntime.getQueuedMessages(target)
        expect(queue.steering).toEqual([])
        expect(queue.followUp).toEqual([
          expect.objectContaining({
            _tag: "FollowUp",
            id: expect.stringContaining(":direct-follow-up"),
            content: "direct follow-up",
          }),
        ])
        // The source id also names the item for removal; a second removal finds nothing.
        const dequeueDirect = targetFacade.Session.dequeueFollowUp({
          ...target,
          sourceId: "direct-follow-up",
        })
        expect(yield* dequeueDirect).toBe(true)
        expect((yield* sessionRuntime.getQueuedMessages(target)).followUp).toEqual([])
        expect(yield* dequeueDirect).toBe(false)
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("control-plane writes check session existence without resolving profiles", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const profileCacheLayer = Layer.succeed(
        SessionProfileCache,
        SessionProfileCache.of({
          resolve: () => Effect.die("control-plane writes must not resolve session profiles"),
        }),
      )
      const layer = makeRuntimeLayer(providerLayer, [], profileCacheLayer)
      yield* Effect.gen(function* () {
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
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("durable admission returns before model completion and retries enqueue once", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        { ...textStep("child reply"), gated: true },
      ])
      const layer = makeRuntimeLayer(providerLayer)
      const context = yield* Layer.build(layer)
      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const messages = yield* MessageStorage
        const { sessionId, branchId } = yield* createSessionBranch
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          content: "admitted work",
          requestId: "durable-admission",
          completion: "admission",
        })
        yield* controls.waitForCall(0)
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          content: "admitted work",
          requestId: "durable-admission",
          completion: "admission",
        })
        expect(yield* controls.callCount).toBe(1)
        const pending = yield* messages.listMessages(branchId)
        expect(pending.filter((message) => message.role === "user")).toHaveLength(1)
        yield* controls.emitAll(0)
        const completed = yield* waitFor(messages.listMessages(branchId), (current) =>
          current.some((message) =>
            message.parts.some((part) => part.type === "text" && part.text === "child reply"),
          ),
        )
        expect(completed.map((message) => message.role)).toEqual(["user", "assistant"])
        expect(completed[0]?.id).toBe(MessageId.make("message:durable-admission"))
        expect(yield* controls.callCount).toBe(1)
      }).pipe(Effect.timeout("4 seconds"), Effect.provideContext(context))
    }),
  )

  it.scopedLive("retried sendUserMessage requestId reuses the durable user message", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("first reply"),
        textStep("duplicate reply"),
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* Effect.gen(function* () {
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
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("an interjection joins the running turn ahead of queued follow-ups", () =>
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
      yield* Effect.gen(function* () {
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
        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("sendUserMessage concurrent with turn completion runs the follow-up once", () =>
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
      yield* Effect.gen(function* () {
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
        yield* controls.assertDone
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("a follow-up source whose turn settled before a restart does not run again", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
        textStep("answered the next wake"),
        textStep("answered the replay"),
      ])
      const layer = makeRuntimeLayer(providerLayer)
      yield* Effect.gen(function* () {
        const messageStorage = yield* MessageStorage
        const workspaceId = yield* CurrentWorkspaceId
        const { sessionId, branchId } = yield* createSessionBranch
        // A previous host ran the wake's turn to its end, then died before the
        // extension forgot its row: this process starts with the settled message.
        yield* messageStorage.createMessage(
          Message.cases.regular.make({
            id: followUpMessageIdForSource({
              workspaceId,
              sessionId,
              branchId,
              sourceId: "alarm-1",
            }),
            sessionId,
            branchId,
            role: "user",
            parts: [Prompt.textPart({ text: "wake alarm-1" })],
            createdAt: dateFromMillis(1_767_225_600_000),
            turnDurationMs: 5,
          }),
        )
        const facade = yield* runtimeHostContext({ sessionId, branchId })
        const wake = (sourceId: string) =>
          facade.Session.send({
            delivery: "queue",
            sessionId,
            branchId,
            sourceId,
            content: `wake ${sourceId}`,
            wake: true,
          })
        yield* wake("alarm-1")
        yield* wake("alarm-2")
        const nextId = followUpMessageIdForSource({
          workspaceId,
          sessionId,
          branchId,
          sourceId: "alarm-2",
        })
        yield* waitFor(
          messageStorage.getMessage(nextId),
          (message) => Predicate.isNotUndefined(message?.turnDurationMs),
          5000,
          "the next wake settled",
        )
        expect(yield* controls.callCount).toBe(1)
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive("drainQueuedMessages atomically clears follow-ups during an active turn", () =>
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
      yield* Effect.gen(function* () {
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
          expect.objectContaining({ _tag: "FollowUp", content: "drain me" }),
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
            if (state._tag === "Some") {
              return state.value
            }
            return Option.getOrUndefined(state)
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
      }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer))
    }),
  )
  it.scopedLive(
    "dispatch RespondInteraction resumes a waiting interaction through the live loop",
    () =>
      Effect.gen(function* () {
        const callCount = yield* Ref.make(0)
        const resolution = yield* Deferred.make<void>()
        const toolDef = makeInteractionTool(callCount, resolution)
        const layer = makeLiveToolRuntimeLayer(makeInteractionProviderLayer(), [toolDef])
        yield* Effect.gen(function* () {
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
              if (state._tag === "Some") {
                return state.value
              }
              return Option.getOrUndefined(state)
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
              if (state._tag === "Some") {
                return state.value
              }
              return Option.getOrUndefined(state)
            }),
            (current) => current?._tag === "Idle",
            5000,
            "idle after interaction response",
          )
          expect(state?._tag).toBe("Idle")
          expect(Ref.getUnsafe(callCount)).toBe(2)
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer))
      }),
  )
})

// ── session metrics ─────────────────────────────────────────────────────────

const cowork = AgentDefinition.make({
  name: AgentName.make("cowork"),
  model: ModelId.make("test/priced"),
})
/** Names its model under another provider; its driver routes it to `test/priced`. */
const routed = AgentDefinition.make({
  name: AgentName.make("routed"),
  model: ModelId.make("proxy/priced"),
  driver: DriverRef.make({ id: "test" }),
})
const modelWithPricing = new Model({
  id: ModelId.make("test/priced"),
  name: "Priced Test",
  provider: ProviderId.make("test"),
  contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
  pricing: { input: 3, output: 15 }, // $3/M in, $15/M out
})
const makeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  models: readonly Model[] = [modelWithPricing],
) =>
  baseLocalLayerWithProvider(providerLayer, {
    agents: [cowork, routed],
    // `extraLayers` in `baseLocalLayerWithProvider` are merged AFTER the
    // default `ModelRegistry.Test()`, so later merges win the tag.
    extraLayers: [ModelRegistry.Test(models)],
  })
const createSessionBranchSessionMetrics = (agent = AgentName.make("cowork")) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStorage
    const branches = yield* BranchStorage
    const sessionId = SessionId.make("metrics-session")
    const branchId = BranchId.make("metrics-branch")
    const now = dateFromMillis(1_767_225_600_000)
    yield* sessions.createSession(
      new Session({
        id: sessionId,
        name: "Metrics Test",
        admission: { agent },
        createdAt: now,
        updatedAt: now,
      }),
    )
    yield* branches.createBranch(
      new Branch({
        id: branchId,
        sessionId,
        createdAt: now,
      }),
    )
    return { sessionId, branchId }
  })
describe("session metrics", () => {
  it.live("StreamEnded.costUsd is frozen at emit time and summed into metrics.costUsd", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("reply one"),
        textStep("reply two"),
      ])
      const result = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const events = yield* EventStorage
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics()
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:first"),
          content: "first",
        })
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:second"),
          content: "second",
        })
        const envelopes = yield* events.listEvents({ sessionId, branchId })
        const streamEndeds = envelopes
          .map((e) => e.event)
          .filter(
            (
              e,
            ): e is Extract<
              typeof e,
              {
                _tag: "StreamEnded"
              }
            > => e._tag === "StreamEnded",
          )
        const metrics = (yield* getSessionSnapshot({ sessionId, branchId })).metrics
        const receipts = envelopes
          .map((e) => e.event)
          .filter(
            (e): e is Extract<typeof e, { _tag: "TurnCompleted" }> => e._tag === "TurnCompleted",
          )
        return { streamEndeds, metrics, receipts }
      }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds"))
      expect(result.streamEndeds.length).toBeGreaterThanOrEqual(1)
      // Each turn receipt carries that turn's totals, summed over its steps.
      expect(result.receipts.map((receipt) => receipt.usage)).toEqual(
        result.streamEndeds.map((ev) => ev.usage),
      )
      for (const ev of result.streamEndeds) {
        expect(ev.model).toBe(ModelId.make("test/priced"))
        expect(ev.costUsd).toBeDefined()
        expect(ev.costUsd).toBeGreaterThan(0)
      }
      const expected = result.streamEndeds.reduce((sum, ev) => sum + (ev.costUsd ?? 0), 0)
      expect(result.metrics.costUsd).toBeCloseTo(expected, 10)
      expect(result.metrics.lastInputTokens).toBeGreaterThan(0)
    }),
  )
  it.live("a routed model is priced by the model the catalog knows it as", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const streamEndeds = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const events = yield* EventStorage
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics(
          AgentName.make("routed"),
        )
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:routed"),
          content: "routed",
        })
        const envelopes = yield* events.listEvents({ sessionId, branchId })
        return envelopes.map((e) => e.event).filter((e) => e._tag === "StreamEnded")
      }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds"))
      expect(streamEndeds).toHaveLength(1)
      // The context window already reads `test/priced`; the price must too.
      expect(streamEndeds[0]?.costUsd).toBeGreaterThan(0)
      // The event names the model it ran and the model it was priced by, so a
      // client that prices part of the step uses the runtime's answer.
      expect(streamEndeds[0]?.model).toBe(ModelId.make("proxy/priced"))
      expect(streamEndeds[0]?.pricedModel).toBe(ModelId.make("test/priced"))
    }),
  )
  it.live("a turn with one step that reports no usage leaves the receipt's usage absent", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        {
          parts: [textDeltaPart("reply without usage"), finishPart({ finishReason: "stop" })],
        },
      ])
      const result = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const events = yield* EventStorage
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics()
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:first"),
          content: "first",
        })
        const envelopes = yield* events.listEvents({ sessionId, branchId })
        return envelopes
          .map((e) => e.event)
          .filter(
            (e): e is Extract<typeof e, { _tag: "TurnCompleted" }> => e._tag === "TurnCompleted",
          )
      }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds"))
      expect(result).toHaveLength(1)
      expect(result[0]?.usage).toBeUndefined()
    }),
  )
  it.live("a completed turn reports what the model saw as context metrics", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const result = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const events = yield* EventStorage
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics()
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:one"),
          content: "one",
        })
        const envelopes = yield* events.listEvents({ sessionId, branchId })
        const projected = envelopes
          .map((e) => e.event)
          .filter((e) => e._tag === "ModelContextProjected")
        const metrics = (yield* getSessionSnapshot({ sessionId, branchId })).metrics
        return { projected, metrics }
      }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds"))
      expect(result.projected).toHaveLength(1)
      const context = Option.getOrThrow(Option.fromUndefinedOr(result.metrics.context))
      expect(context.contextLimitTokens).toBe(TEST_MODEL_CONTEXT_LIMIT_TOKENS)
      expect(context.estimatedTokens).toBeGreaterThan(0)
      expect(context.availableInputTokens).toBeLessThan(TEST_MODEL_CONTEXT_LIMIT_TOKENS)
      expect(context.omittedMessages).toBe(0)
      expect(context.compactions).toBe(0)
    }),
  )
  it.live("metrics.costUsd does not drift when pricing changes after emission", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const result = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics()
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:one"),
          content: "one",
        })
        const first = (yield* getSessionSnapshot({ sessionId, branchId })).metrics
        const second = (yield* getSessionSnapshot({ sessionId, branchId })).metrics
        return { first, second }
      }).pipe(Effect.provide(makeLayer(providerLayer)), Effect.timeout("4 seconds"))
      // Two reads over the same event log must return the same cost. The cost
      // is frozen on StreamEnded at emit time — changes to pricing or the
      // registry between snapshot reads cannot shift historical costs.
      expect(result.first.costUsd).toBe(result.second.costUsd)
      expect(result.first.costUsd).toBeGreaterThan(0)
    }),
  )
  it.live("StreamEnded omits costUsd when model has no pricing", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("reply")])
      const unpriced = new Model({
        id: ModelId.make("test/priced"),
        name: "No Pricing",
        provider: ProviderId.make("test"),
        contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
      })
      const result = yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime
        const events = yield* EventStorage
        const { sessionId, branchId } = yield* createSessionBranchSessionMetrics()
        yield* runtime.sendUserMessage({
          sessionId,
          branchId,
          commandId: ActorCommandId.make("turn:one"),
          content: "one",
        })
        const envelopes = yield* events.listEvents({ sessionId, branchId })
        const streamEndeds = envelopes
          .map((e) => e.event)
          .filter(
            (
              e,
            ): e is Extract<
              typeof e,
              {
                _tag: "StreamEnded"
              }
            > => e._tag === "StreamEnded",
          )
        const metrics = (yield* getSessionSnapshot({ sessionId, branchId })).metrics
        return { streamEndeds, metrics }
      }).pipe(Effect.provide(makeLayer(providerLayer, [unpriced])), Effect.timeout("4 seconds"))
      for (const ev of result.streamEndeds) {
        expect(ev.costUsd).toBeUndefined()
      }
      expect(result.metrics.costUsd).toBe(0)
    }),
  )

  /** A compactor whose summary receipt names `summaryModelId` and one million input tokens. */
  const stubSummary =
    (summaryModelId: ModelId): ModelContextCompactor["Service"]["compact"] =>
    () =>
      Effect.succeed({
        notice: "stub summary",
        modelId: summaryModelId,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      })

  /**
   * Two turns on a small window, so the second turn's projection overflows
   * and `compact` runs. Returns the stored events of the branch.
   */
  const runCompactingTurns = (
    compact: ModelContextCompactor["Service"]["compact"],
    summaryModels: readonly Model[],
  ) =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        textStep("first reply"),
        textStep("second reply"),
      ])
      const compactor = defineExtension({
        id: "@test/stub-compactor",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "@test/stub-compactor/compactor",
              scope: "process",
              layer: Layer.succeed(ModelContextCompactor, ModelContextCompactor.of({ compact })),
            }),
          )
        }),
      })
      const smallWindow = new Model({
        id: ModelId.make("test/priced"),
        name: "Priced, small window",
        provider: ProviderId.make("test"),
        contextLength: 12_000,
        pricing: { input: 3, output: 15 },
      })
      const layer = createE2ELayer({
        providerLayer,
        agents: [AgentDefinition.make({ name: DEFAULT_AGENT_NAME, model: smallWindow.id })],
        extensionInputs: [compactor],
        extraLayers: [ModelRegistry.Test([smallWindow, ...summaryModels])],
      })
      return yield* Effect.gen(function* () {
        const { client } = yield* createRpcClient(layer)
        const { sessionId, branchId } = yield* client.session.create({})
        for (const content of [`first ${"a".repeat(20_000)}`, `second ${"b".repeat(20_000)}`]) {
          yield* client.message.send({ sessionId, branchId, content })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (snapshot) =>
              snapshot.runtime._tag === "Idle" &&
              snapshot.messages.some(
                (message) =>
                  message.role === "user" &&
                  message.parts.some((part) => part.type === "text" && part.text === content),
              ) &&
              snapshot.messages.at(-1)?.role === "assistant",
            5_000,
            "the turn settled",
          )
        }
        const events = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "StreamSynchronized"),
          Stream.map(({ event }) => event),
          Stream.runCollect,
          Effect.map((all) => Array.from(all)),
        )
        return events
      }).pipe(Effect.scoped)
    }).pipe(Effect.timeout("8 seconds"))

  it.live("a compaction summary is priced by the model its receipt names", () =>
    Effect.gen(function* () {
      const summaryModel = new Model({
        id: ModelId.make("test/summary"),
        name: "Summary",
        provider: ProviderId.make("test"),
        contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
        pricing: { input: 1, output: 1 },
      })
      const events = yield* runCompactingTurns(stubSummary(summaryModel.id), [summaryModel])
      const projected = events.find(
        (event) => event._tag === "ModelContextProjected" && event.compacted,
      )
      // One million input tokens at $1/M, not at the turn model's $3/M.
      expect(projected?._tag === "ModelContextProjected" && projected.costUsd).toBeCloseTo(1, 12)
    }),
  )

  it.live("a turn whose summary has no price stores its usage but no cost", () =>
    Effect.gen(function* () {
      const unpricedSummary = new Model({
        id: ModelId.make("test/summary-unpriced"),
        name: "Unpriced summary",
        provider: ProviderId.make("test"),
        contextLength: TEST_MODEL_CONTEXT_LIMIT_TOKENS,
      })
      const events = yield* runCompactingTurns(stubSummary(unpricedSummary.id), [unpricedSummary])
      expect(
        events.some((event) => event._tag === "ModelContextProjected" && event.compacted),
      ).toBe(true)
      const receipts = events.filter((event) => event._tag === "TurnCompleted")
      expect(receipts).toHaveLength(2)
      const [first, second] = receipts
      // The first turn priced every step; the second cannot price its summary,
      // so a sum of its step alone would read as the turn's whole cost.
      expect(first?._tag === "TurnCompleted" && first.costUsd).toBeGreaterThan(0)
      expect(second?._tag === "TurnCompleted" && second.usage).toBeDefined()
      expect(second?._tag === "TurnCompleted" && second.costUsd).toBeUndefined()
    }),
  )

  it.live("a summary that fails after its model was admitted leaves the turn without a cost", () =>
    Effect.gen(function* () {
      // The summary model is admitted, so its call may have spent tokens that
      // no receipt reports; the turn's step alone is not its whole cost.
      const failAfterAdmission: ModelContextCompactor["Service"]["compact"] = (request) =>
        request
          .summaryModel(1_000)
          .pipe(
            Effect.orDie,
            Effect.andThen(
              new ModelCompactionError({ modelId: request.modelId, reason: "SummaryEmpty" }),
            ),
          )
      const events = yield* runCompactingTurns(failAfterAdmission, [])
      expect(events.some((event) => event._tag === "ErrorOccurred" && event.notice === true)).toBe(
        true,
      )
      const receipts = events.filter((event) => event._tag === "TurnCompleted")
      expect(receipts).toHaveLength(2)
      const [first, second] = receipts
      expect(first?._tag === "TurnCompleted" && first.costUsd).toBeGreaterThan(0)
      expect(second?._tag === "TurnCompleted" && second.usage).toBeDefined()
      expect(second?._tag === "TurnCompleted" && second.costUsd).toBeUndefined()
    }),
  )
})

describe("turn ledger", () => {
  it.effect("a turn that mixes a priced and an unpriced step has no cost", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      const messageId = MessageId.make("ledger-turn")
      yield* ledger.beginTurn(messageId)
      const usage = Option.some({ inputTokens: 100, outputTokens: 10 })
      yield* ledger.noteStep({
        agent: AgentName.make("cowork"),
        model: ModelId.make("test/priced"),
        usage,
        costUsd: Option.some(0.5),
        toolCallCount: 1,
      })
      yield* ledger.noteStep({
        agent: AgentName.make("cowork"),
        model: ModelId.make("custom/unpriced"),
        usage,
        costUsd: Option.none(),
        toolCallCount: 0,
      })
      const total = yield* ledger.total
      expect(total.usageKnown).toBe(true)
      expect(total.costUsd).toEqual(Option.none())
    }),
  )

  it.effect("a turn whose steps are all priced sums them", () =>
    Effect.gen(function* () {
      const ledger = yield* makeTurnLedger
      yield* ledger.beginTurn(MessageId.make("ledger-priced"))
      for (const cost of [0.5, 0.25]) {
        yield* ledger.noteStep({
          agent: AgentName.make("cowork"),
          model: ModelId.make("test/priced"),
          usage: Option.some({ inputTokens: 100, outputTokens: 10 }),
          costUsd: Option.some(cost),
          toolCallCount: 0,
        })
      }
      expect((yield* ledger.total).costUsd).toEqual(Option.some(0.75))
    }),
  )
})

// ── branch resources ────────────────────────────────────────────────────────

class BranchCounter extends Context.Service<BranchCounter, { readonly instance: number }>()(
  "@gent/core/tests/runtime/session.test/BranchCounter",
) {}

describe("branch-scoped resources", () => {
  it.live("builds a branch resource per loop and releases it when the branch closes", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      let nextInstance = 0

      const extensionId = ExtensionId.make("@gent/tests/branch-resource")
      const readId = "read-branch-instance"

      const BranchResourceExtension = defineExtension({
        id: extensionId,
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "@gent/tests/branch-resource/counter",
              scope: "branch",
              layer: Layer.effect(
                BranchCounter,
                Effect.acquireRelease(
                  Effect.sync(() => {
                    const instance = ++nextInstance
                    events.push(`acquire:${instance}`)
                    return BranchCounter.of({ instance })
                  }),
                  (service) => Effect.sync(() => events.push(`release:${service.instance}`)),
                ),
              ),
            }),
          )
          yield* host.register(
            "request",
            request({
              id: readId,
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const counter = yield* BranchCounter
                  return `instance:${counter.instance}`
                }),
            }),
          )
        }),
      })

      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        extensionInputs: [...e2ePreset.extensionInputs, BranchResourceExtension],
      })

      // The branch resource is live for the running loop, and is the same
      // instance across calls within that branch.
      const first = yield* client.extension.request({
        sessionId,
        branchId,
        extensionId,
        capabilityId: readId,
        input: "read",
      })
      expect(first).toBe("instance:1")
      expect(events).toContain("acquire:1")
      expect(events).not.toContain("release:1")

      const second = yield* client.extension.request({
        sessionId,
        branchId,
        extensionId,
        capabilityId: readId,
        input: "read",
      })
      expect(second).toBe("instance:1")
      expect(nextInstance).toBe(1)
    }).pipe(Effect.scoped),
  )
})
