import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Effect, Layer } from "effect"
import { SingleRunner } from "effect/unstable/cluster"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { ModelId } from "@gent/core-internal/domain/model"
import type { CallRecord } from "@gent/core-internal/test-utils"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep } from "@gent/core-internal/debug/provider"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SessionCommands } from "../../../src/server/session-commands"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ConfigService } from "../../../src/runtime/config-service"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { SessionRuntime } from "../../../src/runtime/session-runtime"
import { SessionProfileCache } from "../../../src/runtime/session-profile"
import { Permission } from "@gent/core-internal/domain/permission"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { RecordingEventStore, SequenceRecorder } from "@gent/core-internal/test-utils"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import type { ExtensionContributions } from "../../../src/domain/extension.js"
const makeTestExtensions = () => {
  const cowork = AgentDefinition.make({
    name: AgentName.make("cowork"),
    model: ModelId.make("test/default"),
  })
  const reflect = AgentDefinition.make({
    name: AgentName.make("memory:reflect"),
    model: ModelId.make("test/override"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: { agents: [cowork, reflect] } satisfies ExtensionContributions,
    },
  ])
}
const makeCommandsLayer = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql()
  const clusterRunnerLayer = Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    storageLayer,
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
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    Permission.Test(),
    SessionProfileCache.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer),
  )
  return Layer.provideMerge(
    SessionCommands.Live,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionRuntimeLayer, sessionMutationsLayer),
  ) as Layer.Layer<SessionCommands | MessageStorage | SequenceRecorder>
}
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
describe("agent override behavior", () => {
  it.live("sendMessage keeps agentOverride turn-scoped and does not switch the session agent", () =>
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
        const commands = yield* SessionCommands
        const messageStorage = yield* MessageStorage
        const recorder = yield* SequenceRecorder
        const session = yield* commands.createSession({ name: "Agent Override Test" })
        yield* commands.sendMessage({
          sessionId: session.sessionId,
          branchId: session.branchId,
          content: "with override",
          agentOverride: AgentName.make("memory:reflect"),
        })
        yield* commands.sendMessage({
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
        const calls = yield* recorder.getCalls()
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ])
        expect(eventTags(calls)).not.toContain("AgentSwitched")
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeCommandsLayer(providerLayer)))
    }),
  )
  it.live(
    "createSession with initialPrompt uses the override for the first turn without persisting an agent switch",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...textStep("seeded reply"),
            assertRequest: (request) => {
              expect(request.model).toBe("test/override")
            },
          },
        ])
        yield* Effect.gen(function* () {
          const commands = yield* SessionCommands
          const messageStorage = yield* MessageStorage
          const recorder = yield* SequenceRecorder
          const session = yield* commands.createSession({
            name: "Initial Prompt Override",
            initialPrompt: "seed the session",
            agentOverride: AgentName.make("memory:reflect"),
          })
          const messages = yield* waitFor(
            messageStorage.listMessages(session.branchId),
            (current) => current.filter((message) => message.role === "assistant").length === 1,
            5000,
            "initial prompt assistant reply",
          )
          const calls = yield* recorder.getCalls()
          expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
          expect(eventTags(calls)).not.toContain("AgentSwitched")
          yield* controls.assertDone()
        }).pipe(Effect.provide(makeCommandsLayer(providerLayer)))
      }),
  )
  it.live("createSession skips dispatch when initialPrompt is missing or empty", () =>
    Effect.gen(function* () {
      const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
      yield* Effect.gen(function* () {
        const commands = yield* SessionCommands
        const messageStorage = yield* MessageStorage
        const noPrompt = yield* commands.createSession({ name: "No Prompt Test" })
        const emptyPrompt = yield* commands.createSession({
          name: "Empty Prompt Test",
          initialPrompt: "",
        })
        expect(yield* messageStorage.listMessages(noPrompt.branchId)).toEqual([])
        expect(yield* messageStorage.listMessages(emptyPrompt.branchId)).toEqual([])
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeCommandsLayer(providerLayer)))
    }),
  )
})
