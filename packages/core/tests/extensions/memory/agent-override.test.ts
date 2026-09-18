import { BunCrypto, BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Effect, Layer, Schema } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { AgentDefinition, AgentName, DEFAULT_AGENT_NAME, ModelId } from "../../../src/domain/agent"
import { ExtensionId } from "../../../src/domain/ids"
import type { CallRecord } from "../../../src/test-utils"
import { ModelRegistry, ModelResolver } from "../../../src/runtime/provider"
import { LanguageModelLayers } from "../../../src/test-utils/language-model"
import { textStep } from "../../../src/test-utils/sequence-steps"
import { AgentEvent, EventPublisherLive } from "../../../src/domain/event"
import { type ExtensionContributions, SessionMutations } from "../../../src/domain/extension"
import { SessionMutationsLive } from "../../../src/server/session-mutations-live"
import { noBranchTools, ToolRunner } from "../../../src/runtime/agent/tools"
import {
  ApprovalService,
  DriverRegistry,
  ExtensionRegistry,
  resolveExtensions,
  SessionProfileCache,
} from "../../../src/runtime/extension-host"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ConfigService, RuntimeEnvironment } from "../../../src/runtime/config"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { SessionRuntime } from "../../../src/runtime/session-runtime"
import { MessageStorage, SqliteStorage } from "../../../src/storage/storage"
import { RecordingEventStore, SequenceRecorder } from "../../../src/test-utils"
import { waitFor } from "../../../src/test-utils/fixtures"
const makeTestExtensions = () => {
  const mainAgent = AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("test/default"),
  })
  const reflect = AgentDefinition.make({
    name: AgentName.make("memory:reflect"),
    model: ModelId.make("test/override"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { agents: [mainAgent, reflect] } satisfies ExtensionContributions,
    },
  ])
}
const makeMutationsLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )
  const baseDeps = Layer.mergeAll(
    storageLayer,
    clusterRunnerLayer,
    providerLayer,
    ModelResolver.fromLanguageModel(providerLayer),
    eventStoreLayer,
    recorderLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ToolRunner.Test(),
    ApprovalService.Test(),
    RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    SessionProfileCache.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  return Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer, sessionMutationsLayer)
}
const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "append")
    .map((call) => Schema.decodeUnknownSync(AgentEvent)(call.args)._tag)
describe("agent override behavior", () => {
  it.scopedLive(
    "sendUserMessage keeps agentOverride turn-scoped and does not switch the session agent",
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
        yield* Effect.gen(function* () {
          const mutations = yield* SessionMutations
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const recorder = yield* SequenceRecorder
          const session = yield* mutations.createSession({ name: "Agent Override Test" })
          yield* sessionRuntime.sendUserMessage({
            sessionId: session.sessionId,
            branchId: session.branchId,
            content: "with override",
            agentOverride: AgentName.make("memory:reflect"),
          })
          yield* sessionRuntime.sendUserMessage({
            sessionId: session.sessionId,
            branchId: session.branchId,
            content: "without override",
          })
          const messages = yield* waitFor(
            messageStorage.listMessages(session.branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 2,
            5000,
            "two assistant replies",
          )
          const calls = yield* recorder.getCalls
          expect(messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
          ])
          expect(eventTags(calls)).not.toContain("AgentSwitched")
          yield* controls.assertDone
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(makeMutationsLayer(providerLayer)), Effect.scoped)
      }).pipe(Effect.provide(BunCrypto.layer)),
  )
  it.scopedLive("createSession skips dispatch when initialPrompt is missing or empty", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
      yield* Effect.gen(function* () {
        const mutations = yield* SessionMutations
        const messageStorage = yield* MessageStorage
        const noPrompt = yield* mutations.createSession({ name: "No Prompt Test" })
        const emptyPrompt = yield* mutations.createSession({
          name: "Empty Prompt Test",
          initialPrompt: "",
        })
        expect(yield* messageStorage.listMessages(noPrompt.branchId)).toEqual([])
        expect(yield* messageStorage.listMessages(emptyPrompt.branchId)).toEqual([])
        yield* controls.assertDone
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(makeMutationsLayer(providerLayer)), Effect.scoped)
    }).pipe(Effect.provide(BunCrypto.layer)),
  )
})
