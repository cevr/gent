import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Ref, Schema, Stream } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { AgentDefinition } from "@gent/core/domain/agent"
import { Branch, Session } from "@gent/core/domain/message"
import type { QueueSnapshot } from "@gent/core/domain/queue"
import {
  createSequenceProvider,
  finishPart,
  textDeltaPart,
  textStep,
  toolCallPart,
  type ProviderStreamPart,
} from "@gent/core/debug/provider"
import { EventEnvelope, EventId, EventStoreError, type AgentEvent } from "@gent/core/domain/event"
import { tool, type AnyCapabilityContribution } from "@gent/core/extensions/api"
import { Provider } from "@gent/core/providers/provider"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import { EventPublisherLive } from "@gent/core/server/event-publisher"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { RecordingEventStore, SequenceRecorder, type CallRecord } from "@gent/core/test-utils"
import { ConfigService } from "@gent/core/runtime/config-service"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { ActorCommandId, BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Permission } from "@gent/core/domain/permission"
import { InteractionPendingError } from "@gent/core/domain/interaction-request"
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
  applySteerCommand,
  interruptPayloadToSteerCommand,
  invokeToolCommand,
  respondInteractionCommand,
  recordToolResultCommand,
  sendUserMessageCommand,
} from "@gent/core/runtime/session-runtime"
import type { ExtensionContributions } from "../../src/domain/extension.js"

const makeTestExtensions = (tools: AnyCapabilityContribution[] = []) => {
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
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, baseDeps)
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, providedEventPublisherLayer),
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
  tools: AnyCapabilityContribution[],
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
    RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    ApprovalService.Test(),
    Permission.Live([], "allow"),
    BunServices.layer,
    ResourceManagerLive,
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

const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "append")
    .map((call) => (call.args as { _tag?: string } | undefined)?._tag)

const latestUserText = (request: { readonly prompt: unknown }) =>
  [...Prompt.make(request.prompt).content]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.filter((part): part is Prompt.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n") ?? ""

const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
  tool({
    id: "interaction-tool",
    description: "Tool that triggers an interaction",
    resources: ["interaction-tool"],
    params: Schema.Struct({ value: Schema.String }),
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const count = yield* Ref.getAndUpdate(callCount, (current) => current + 1)
        if (count === 0) {
          return yield* new InteractionPendingError({
            requestId: "req-test-1",
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

  test("recordToolResult rolls back the tool message when durable event append fails", async () => {
    const { layer: providerLayer } = await Effect.runPromise(createSequenceProvider([]))
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

    await Effect.runPromise(
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
      }).pipe(Effect.provide(layer)),
    )
  })

  test("recordToolResult retry does not duplicate the durable event", async () => {
    const { layer: providerLayer } = await Effect.runPromise(createSequenceProvider([]))
    const layer = makeRuntimeLayer(providerLayer)

    await Effect.runPromise(
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
      }).pipe(Effect.provide(layer)),
    )
  })

  test("recordToolResult retries committed event delivery without duplicating the durable event", async () => {
    const { layer: providerLayer } = await Effect.runPromise(createSequenceProvider([]))
    const delivered: string[] = []
    const eventPublisherLayer = makePublisherFailingFirstMatchingDelivery(
      (event) => event._tag === "ToolCallSucceeded",
      delivered,
    )
    const layer = makeRuntimeLayerWithEventPublisher(providerLayer, eventPublisherLayer)

    await Effect.runPromise(
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
      }).pipe(Effect.provide(layer)),
    )
  })

  test("dispatch ApplySteer interjects ahead of queued follow-ups", async () => {
    const { layer: providerLayer, controls } = await Effect.runPromise(
      createSequenceProvider([
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
      ]),
    )

    const layer = makeRuntimeLayer(providerLayer)

    await Effect.runPromise(
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
          5_000,
          "interjected turn completion",
        )

        expect(messages.filter((message) => message.role === "assistant")).toHaveLength(3)
        yield* controls.assertDone()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("dispatch RespondInteraction resumes a waiting interaction through the live loop", async () => {
    const callCount = Ref.makeUnsafe(0)
    const resolution = Deferred.makeUnsafe<void>()
    const toolDef = makeInteractionTool(callCount, resolution)
    const layer = makeLiveToolRuntimeLayer(makeInteractionProviderLayer(), [toolDef])

    await Effect.runPromise(
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
          5_000,
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
          5_000,
          "idle after interaction response",
        )

        expect(state._tag).toBe("Idle")
        expect(Ref.getUnsafe(callCount)).toBe(2)
      }).pipe(Effect.provide(layer)),
    )
  })
})
