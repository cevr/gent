import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentDefinition } from "@gent/core/domain/agent"
import { Branch, Session } from "@gent/core/domain/message"
import type { QueueSnapshot } from "@gent/core/domain/queue"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import type { AnyCapabilityContribution } from "@gent/core/extensions/api"
import type { Provider } from "@gent/core/providers/provider"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { RecordingEventStore, SequenceRecorder, type CallRecord } from "@gent/core/test-utils"
import { ConfigService } from "@gent/core/runtime/config-service"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import { ExtensionTurnControl } from "../../src/runtime/extensions/turn-control.js"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { ResourceManagerLive } from "@gent/core/runtime/resource-manager"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { Storage } from "@gent/core/storage/sqlite-storage"
import {
  SessionRuntime,
  invokeToolCommand,
  sendUserMessageCommand,
} from "@gent/core/runtime/session-runtime"
import type { ExtensionContributions } from "../../src/domain/extension.js"

const makeTestExtensions = (tools: AnyCapabilityContribution[] = []) => {
  const cowork = new AgentDefinition({
    name: "cowork" as never,
    model: "test/default" as never,
  })
  const reflect = new AgentDefinition({
    name: "memory:reflect" as never,
    model: "test/override" as never,
  })

  return resolveExtensions([
    {
      manifest: { id: "agents" },
      scope: "builtin" as const,
      sourcePath: "test",
      contributions: {
        agents: [cowork, reflect],
        ...(tools.length > 0 ? { capabilities: tools } : {}),
      } satisfies ExtensionContributions,
    },
  ])
}

const makeRuntimeLayer = (
  providerLayer: Layer.Layer<Provider>,
  tools: AnyCapabilityContribution[] = [],
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
    MachineEngine.Test(),
    ExtensionTurnControl.Test(),
    eventStoreLayer,
    recorderLayer,
    ToolRunner.Test(),
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ResourceManagerLive,
  )
  const eventPublisherLayer = Layer.provide(EventPublisherLive, baseDeps)
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, eventPublisherLayer),
  )
}

const createSessionBranch = Effect.gen(function* () {
  const storage = yield* Storage
  const sessionId = SessionId.of("runtime-session")
  const branchId = BranchId.of("runtime-branch")
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

const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "publish")
    .map((call) => (call.args as { _tag?: string } | undefined)?._tag)

describe("SessionRuntime", () => {
  test("sendUserMessage keeps agentOverride turn-scoped and leaves the default agent selected", async () => {
    const { layer: providerLayer, controls } = await Effect.runPromise(
      createSequenceProvider([
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

    const layer = makeRuntimeLayer(providerLayer)

    await Effect.runPromise(
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
            agentOverride: "memory:reflect",
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
          5_000,
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
          5_000,
          "idle runtime state",
        )
        expect(state.agent).toBe("cowork")

        const calls = yield* recorder.getCalls()
        expect(eventTags(calls)).not.toContain("AgentSwitched")
        yield* controls.assertDone()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("invokeTool persists assistant and tool messages without queueing a follow-up turn", async () => {
    const { layer: providerLayer } = await Effect.runPromise(createSequenceProvider([]))
    const layer = makeRuntimeLayer(providerLayer)

    await Effect.runPromise(
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
          5_000,
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
      }).pipe(Effect.provide(layer)),
    )
  })
})
