import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentDefinition, AgentName } from "@gent/core/domain/agent"
import { ExtensionId } from "@gent/core/domain/ids"
import { ModelId } from "@gent/core/domain/model"
import type { CallRecord } from "@gent/core/test-utils"
import { Provider } from "@gent/core/providers/provider"
import { textStep } from "@gent/core/debug/provider"
import { EventPublisherLive } from "../../../src/server/event-publisher"
import { SessionCwdRegistry } from "../../../src/runtime/session-cwd-registry"
import { SessionCommands } from "../../../src/server/session-commands"
import { ResourceManagerLive } from "../../../src/runtime/resource-manager"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ConfigService } from "../../../src/runtime/config-service"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { ActorRouter } from "../../../src/runtime/extensions/resource-host/actor-router"
import { ActorEngine } from "../../../src/runtime/extensions/actor-engine"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"
import { SessionRuntime } from "../../../src/runtime/session-runtime"
import { SessionProfileCache } from "../../../src/runtime/session-profile"
import { Permission } from "@gent/core/domain/permission"
import { Storage } from "@gent/core/storage/sqlite-storage"
import { RecordingEventStore, SequenceRecorder } from "@gent/core/test-utils"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { ExtensionTurnControl } from "../../../src/runtime/extensions/turn-control.js"
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

const makeCommandsLayer = (providerLayer: Layer.Layer<Provider>) => {
  const resolvedExtensions = makeTestExtensions()
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const baseDeps = Layer.mergeAll(
    Storage.TestWithSql(),
    providerLayer,
    eventStoreLayer,
    recorderLayer,
    ExtensionRegistry.fromResolved(resolvedExtensions),
    DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    }),
    ActorRouter.Test(),
    ActorEngine.Live,
    ExtensionTurnControl.Test(),
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
    SessionCwdRegistry.Test(),
    SessionCommands.SessionRuntimeTerminatorLive,
    ModelRegistry.Test(),
    Permission.Test(),
    SessionProfileCache.Test(),
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  const sessionMutationsLayer = Layer.provide(
    SessionCommands.SessionMutationsLive,
    Layer.merge(baseDeps, eventPublisherLayer),
  )
  const sessionRuntimeLayer = Layer.provide(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionMutationsLayer),
  )
  return Layer.provideMerge(
    SessionCommands.Live,
    Layer.mergeAll(baseDeps, eventPublisherLayer, sessionMutationsLayer, sessionRuntimeLayer),
  )
}

const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "append")
    .map((call) => (call.args as { _tag?: string } | undefined)?._tag)

describe("agent override behavior", () => {
  test("sendMessage keeps agentOverride turn-scoped and does not switch the session agent", async () => {
    const { layer: providerLayer, controls } = await Effect.runPromise(
      Provider.Sequence([
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
      ]),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const storage = yield* Storage
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
          storage.listMessages(session.branchId),
          (current) => current.filter((message) => message.role === "assistant").length === 2,
          5_000,
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
      }).pipe(Effect.provide(makeCommandsLayer(providerLayer))),
    )
  })

  test("createSession with initialPrompt uses the override for the first turn without persisting an agent switch", async () => {
    const { layer: providerLayer, controls } = await Effect.runPromise(
      Provider.Sequence([
        {
          ...textStep("seeded reply"),
          assertRequest: (request) => {
            expect(request.model).toBe("test/override")
          },
        },
      ]),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const storage = yield* Storage
        const recorder = yield* SequenceRecorder

        const session = yield* commands.createSession({
          name: "Initial Prompt Override",
          initialPrompt: "seed the session",
          agentOverride: AgentName.make("memory:reflect"),
        })

        const messages = yield* waitFor(
          storage.listMessages(session.branchId),
          (current) => current.filter((message) => message.role === "assistant").length === 1,
          5_000,
          "initial prompt assistant reply",
        )
        const calls = yield* recorder.getCalls()

        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
        expect(eventTags(calls)).not.toContain("AgentSwitched")
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeCommandsLayer(providerLayer))),
    )
  })

  test("createSession skips dispatch when initialPrompt is missing or empty", async () => {
    const { layer: providerLayer, controls } = await Effect.runPromise(Provider.Sequence([]))

    await Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* SessionCommands
        const storage = yield* Storage

        const noPrompt = yield* commands.createSession({ name: "No Prompt Test" })
        const emptyPrompt = yield* commands.createSession({
          name: "Empty Prompt Test",
          initialPrompt: "",
        })

        expect(yield* storage.listMessages(noPrompt.branchId)).toEqual([])
        expect(yield* storage.listMessages(emptyPrompt.branchId)).toEqual([])
        yield* controls.assertDone()
      }).pipe(Effect.provide(makeCommandsLayer(providerLayer))),
    )
  })
})
