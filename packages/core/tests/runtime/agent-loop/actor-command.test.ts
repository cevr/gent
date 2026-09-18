import { AgentDefinition, DEFAULT_AGENT_NAME, ModelId } from "../../../src/domain/agent"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { request, type RequestCapability, type ToolCapability } from "@gent/core/extensions/api"
import {
  ApprovalService,
  DriverRegistry,
  ExtensionRegistry,
  resolveExtensions,
} from "../../../src/runtime/extension-host"
import { noBranchTools, ProcessLocalToolReplay, ToolRunner } from "../../../src/runtime/tools"
import { narrowR } from "../../helpers/effect"
import { SingleRunner } from "effect/unstable/cluster"
import { dateFromMillis, Branch, Session } from "../../../src/domain/message"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "../../../src/test-utils/language-model"
import { ModelRegistry, ModelResolver } from "../../../src/runtime/provider"
import { EventPublisherLive } from "../../../src/domain/event"
import { RecordingEventStore, SequenceRecorder } from "../../../src/test-utils"
import { ConfigService, RuntimeEnvironment } from "../../../src/runtime/config"
import {
  AgentLoop as AgentLoopActor,
  AgentLoopSessionGovernance,
} from "../../../src/runtime/agent-loop"
import { ActorCommandId, BranchId, ExtensionId, SessionId } from "../../../src/domain/ids"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { BranchStorage, SessionStorage, SqliteStorage } from "../../../src/storage/storage"
import { SessionRuntime } from "../../../src/runtime/session"
import { entityIdOf } from "../../../src/domain/agent-loop"
import { DefaultWorkspaceId } from "../../../src/server/workspace-rpc"
import type { ExtensionContributions } from "../../../src/domain/extension.js"

const makeTestExtensions = (
  tools: ReadonlyArray<ToolCapability> = [],
  requests: ReadonlyArray<RequestCapability> = [],
) => {
  const mainAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("test/default"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [mainAgent],
        tools,
        requests,
      } satisfies ExtensionContributions,
    },
  ])
}

const makeClusterRunnerLayer = <A>(storageLayer: ReturnType<typeof SqliteStorage.TestWithSql<A>>) =>
  Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )

const makeRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
  requests: ReadonlyArray<RequestCapability> = [],
) => {
  const resolvedExtensions = makeTestExtensions(tools, requests)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
  let toolRunnerLayer = ToolRunner.Test()
  if (tools.length > 0) toolRunnerLayer = ToolRunner.Live
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
    toolRunnerLayer,
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const approvalLayer = ApprovalService.Live.pipe(
    Layer.provide(Layer.merge(baseDeps, eventPublisherLayer)),
  )
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, eventPublisherLayer, approvalLayer, ProcessLocalToolReplay.Live),
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

let getActorStateCounter = 0
const getActorState = (input: { sessionId: SessionId; branchId: BranchId }) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    return yield* ref.execute(
      AgentLoopActor.GetState.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: ActorCommandId.make(`get-state-${++getActorStateCounter}`),
      }),
    )
  })

/**
 * `RequestExtension` is the live side-mutation operation: its handler takes the
 * same per-session permit and the same `drainWake` as every other mutation. The
 * concurrency tests below drive the actor through it, so they assert the
 * permit's behavior against a path production actually uses.
 */
const TEST_REQUEST_EXTENSION_ID = ExtensionId.make("agents")

const requestExtensionViaActor = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly capabilityId: string
  readonly input: unknown
}) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    return yield* ref.execute(
      AgentLoopActor.RequestExtension.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: input.commandId,
        extensionId: TEST_REQUEST_EXTENSION_ID,
        capabilityId: input.capabilityId,
        input: { _tag: "Present", value: input.input },
      }),
    )
  })

describe("agent-loop actor commands", () => {
  it.live("side-mutation commands are serialized per session", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const firstEntered = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      let entered = 0
      let completed = 0
      const blockingRequest = request({
        id: "serialize-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Effect.gen(function* () {
            entered++
            if (entered === 1) {
              // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
              yield* Deferred.succeed(firstEntered, undefined)
              yield* Deferred.await(releaseFirst)
            }
            completed++
            return value
          }),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [blockingRequest])
      yield* narrowR(
        Effect.gen(function* () {
          const { sessionId, branchId } = yield* createSessionBranch
          const call = (commandId: string, value: string) =>
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make(commandId),
              capabilityId: "serialize-probe",
              input: value,
            })
          const firstFiber = yield* Effect.forkChild(call("serialize-a", "a"))
          yield* Deferred.await(firstEntered).pipe(Effect.timeout("5 seconds"))
          const secondFiber = yield* Effect.forkChild(call("serialize-b", "b"))
          // The permit is held by the first command, so the second cannot even
          // enter the capability body until the first releases it.
          const earlySecond = yield* Fiber.join(secondFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlySecond._tag).toBe("None")
          expect(entered).toBe(1)
          expect(completed).toBe(0)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(firstFiber)
          yield* Fiber.join(secondFiber)
          expect(entered).toBe(2)
          expect(completed).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("a side mutation waits for the active turn mutation owner", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      let executed = false
      const probeRequest = request({
        id: "owner-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) =>
          Effect.sync(() => {
            executed = true
            return value
          }),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [probeRequest])
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
          const requestFiber = yield* Effect.forkChild(
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make("request-active-owner"),
              capabilityId: "owner-probe",
              input: "blocked until turn completes",
            }),
          )
          // The running turn owns the mutation permit, so the side mutation
          // cannot start until the turn releases it.
          const earlyRequest = yield* Fiber.join(requestFiber).pipe(
            Effect.timeoutOption("1 millis"),
          )
          expect(earlyRequest._tag).toBe("None")
          expect(executed).toBe(false)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined)
          yield* Fiber.join(submitFiber)
          const result = yield* Fiber.join(requestFiber)
          expect(executed).toBe(true)
          expect(result).toEqual("blocked until turn completes")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("a read-only request answers while the turn holds the mutation permit", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const readProbe = request({
        id: "read-probe",
        readonly: true,
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) => Effect.succeed(`read ${value}`),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [readProbe])
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
          // The turn still owns the permit, and the read does not need it.
          const result = yield* requestExtensionViaActor({
            sessionId,
            branchId,
            commandId: ActorCommandId.make("request-read-during-turn"),
            capabilityId: "read-probe",
            input: "mid-turn",
          }).pipe(Effect.timeout("2 seconds"))
          expect(result).toEqual("read mid-turn")
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined)
          yield* Fiber.join(submitFiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("TerminateBranch interrupts an active turn while a side mutation is waiting", () =>
    Effect.gen(function* () {
      const streamStarted = yield* Deferred.make<void>()
      const streamReleased = yield* Deferred.make<void>()
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamStarted, undefined)
          yield* Deferred.await(streamReleased)
          return Stream.fromIterable([
            textDeltaPart("done"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const terminateProbe = request({
        id: "terminate-probe",
        input: Schema.String,
        output: Schema.String,
        execute: (value: string) => Effect.succeed(value),
      })
      const layer = makeRuntimeLayer(providerLayer, [], [terminateProbe])
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
            requestExtensionViaActor({
              sessionId,
              branchId,
              commandId: ActorCommandId.make("request-terminate-owner"),
              capabilityId: "terminate-probe",
              input: "blocked until turn completes",
            }),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlyRecord._tag).toBe("None")
          yield* sessionRuntime.terminateSession(sessionId).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(submitFiber).pipe(Effect.ignore)
          yield* Fiber.join(recordFiber).pipe(Effect.ignore)
          const afterTerminate = yield* Effect.exit(getActorState({ sessionId, branchId }))
          expect(afterTerminate._tag).toBe("Failure")
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(streamReleased, undefined).pipe(Effect.ignore)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )
})
