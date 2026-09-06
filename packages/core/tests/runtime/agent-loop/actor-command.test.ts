import { ModelId } from "@gent/core-internal/domain/model"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { Cause, Clock, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { ExtensionContext, tool, type ToolCapability } from "@gent/core/extensions/api"
import { Permission } from "@gent/core-internal/domain/permission"
import { ApprovalService } from "@gent/core-internal/runtime/approval-service"
import {
  processLocalReplayBindingKey,
  ProcessLocalToolReplay,
} from "@gent/core-internal/runtime/agent/process-local-tool-replay"
import {
  assistantMessageIdForCommand,
  toolCallIdForCommand,
} from "@gent/core-internal/runtime/agent/agent-loop.utils"
import { narrowR } from "../../helpers/effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import { SingleRunner } from "effect/unstable/cluster"
import type { PeekResult } from "effect-encore"
import { AgentDefinition, AgentName } from "@gent/core-internal/domain/agent"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import type { QueueSnapshot } from "@gent/core-internal/domain/queue"
import {
  EventEnvelope,
  EventId,
  EventStoreError,
  AgentEvent,
} from "@gent/core-internal/domain/event"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { EventPublisher, EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import {
  RecordingEventStore,
  SequenceRecorder,
  type CallRecord,
} from "@gent/core-internal/test-utils"
import { ConfigService } from "../../../src/runtime/config-service"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import {
  ActorCommandId,
  BranchId,
  ExtensionId,
  MessageId,
  SessionId,
  ToolCallId,
  ToolName,
} from "@gent/core-internal/domain/ids"
import { ExtensionRegistry, resolveExtensions } from "../../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { SessionRuntime } from "../../../src/runtime/session-runtime"
import { AgentLoop as AgentLoopActor } from "../../../src/runtime/agent/agent-loop.actor"
import { entityIdOf } from "../../../src/runtime/agent/agent-loop.entity-id"
import { AgentLoopError } from "../../../src/runtime/agent/agent-loop.state"
import { DefaultWorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import type { ExtensionContributions } from "../../../src/domain/extension.js"

const makeTestExtensions = (tools: ReadonlyArray<ToolCapability> = []) => {
  const cowork = AgentDefinition.make({
    name: AgentName.make("cowork"),
    model: ModelId.make("test/default"),
  })
  return resolveExtensions([
    {
      manifest: { id: ExtensionId.make("agents") },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        agents: [cowork],
        tools,
      } satisfies ExtensionContributions,
    },
  ])
}

const makeClusterRunnerLayer = (storageLayer: ReturnType<typeof SqliteStorage.TestWithSql>) =>
  Layer.provide(
    SingleRunner.layer({ runnerStorage: "memory" }),
    Layer.merge(storageLayer, BunCrypto.layer),
  )

const makeRuntimeLayer = (
  providerLayer: Layer.Layer<LanguageModel.LanguageModel>,
  tools: ReadonlyArray<ToolCapability> = [],
) => {
  const resolvedExtensions = makeTestExtensions(tools)
  const recorderLayer = SequenceRecorder.Live
  const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
  const storageLayer = SqliteStorage.TestWithSql()
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
    Permission.Live([], "allow"),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
    ApprovalService.Test(),
    RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
    ConfigService.Test(),
    BunServices.layer,
    ModelRegistry.Test(),
    GentPlatform.Test(),
    AgentLoopSessionGovernance.Live,
  )
  const providedEventPublisherLayer = Layer.provide(eventPublisherLayer, baseDeps)
  return Layer.provideMerge(
    SessionRuntime.Live({ baseSections: [] }),
    Layer.merge(baseDeps, providedEventPublisherLayer),
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

const recordToolResultViaActor = (input: {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly commandId: ActorCommandId
  readonly toolCallId: ToolCallId
  readonly toolName: ToolName
  readonly output: unknown
  readonly isError?: boolean
}) =>
  Effect.gen(function* () {
    const actorClientFactory = yield* AgentLoopActor.Context
    const ref = yield* actorClientFactory(
      entityIdOf(DefaultWorkspaceId, input.sessionId, input.branchId),
    )
    yield* ref.execute(
      AgentLoopActor.RecordToolResult.make({
        workspaceId: DefaultWorkspaceId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        commandId: input.commandId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: input.output,
        isError: input.isError,
      }),
    )
  })

const eventTags = (calls: ReadonlyArray<CallRecord>) =>
  calls
    .filter((call) => call.service === "EventStore" && call.method === "append")
    .map((call) => Schema.decodeUnknownSync(AgentEvent)(call.args)._tag)

const materializeActorCommand = <A, E>(result: PeekResult<A, E>): Effect.Effect<A, E> => {
  switch (result._tag) {
    case "Success":
      return Effect.succeed(result.value)
    case "Failure":
      return Effect.fail(result.error)
    case "Interrupted":
      return Effect.interrupt
    case "Defect":
      return Effect.die(result.cause)
    case "Pending":
    case "Suspended":
      return Effect.die(new Error(`Actor command did not reach a terminal state: ${result._tag}`))
  }
}

describe("agent-loop actor commands", () => {
  it.live("InvokeTool rejects approval with a paired result and durable command failure", () =>
    Effect.gen(function* () {
      const executions = yield* Ref.make(0)
      const approvalTool = tool({
        id: "direct-approval",
        description: "Needs human approval",
        params: Schema.Struct({}),
        output: Schema.Boolean,
        execute: () =>
          Effect.gen(function* () {
            yield* Ref.update(executions, (count) => count + 1)
            const ctx = yield* ExtensionContext
            return (yield* ctx.Interaction.approve({ text: "approve direct invocation" })).approved
          }),
      })
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer, [approvalTool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { sessionId, branchId } = yield* createSessionBranch
          const factory = yield* AgentLoopActor.Context
          const control = yield* AgentLoopActor.Control
          const entityId = entityIdOf(DefaultWorkspaceId, sessionId, branchId)
          const ref = yield* factory(entityId)
          const commandId = ActorCommandId.make("direct-approval-command")
          const payload = AgentLoopActor.InvokeTool.make({
            workspaceId: DefaultWorkspaceId,
            sessionId,
            branchId,
            commandId,
            toolName: ToolName.make("direct-approval"),
            input: {},
          })
          yield* ref.send(payload)
          const first = yield* AgentLoopActor.InvokeTool.waitFor(payload)
          expect(first._tag).toBe("Failure")
          if (first._tag !== "Failure") return
          expect(first.error.cause).toMatchObject({
            message:
              "InvokeTool cannot wait for approval. Use a session turn for interactive tools.",
          })
          expect(first.error.message).toContain("InvokeTool cannot wait for approval")
          const storage = yield* MessageStorage
          const history = yield* storage.listMessages(branchId)
          expect(history.map((message) => message.role)).toEqual(["assistant", "tool"])
          expect(history[1]?.parts[0]).toEqual(
            Prompt.toolResultPart({
              id: toolCallIdForCommand(commandId),
              name: "direct-approval",
              isFailure: true,
              providerExecuted: false,
              result: {
                error:
                  "InvokeTool cannot wait for approval. Use a session turn for interactive tools.",
                reason: "ToolInvocationInteractionError",
              },
            }),
          )
          const approval = yield* ApprovalService
          expect(yield* approval.pendingRequestId({ sessionId, branchId })).toBeUndefined()
          const replay = yield* ProcessLocalToolReplay
          expect(
            Option.isNone(
              yield* replay.getBinding(
                processLocalReplayBindingKey({
                  sessionId,
                  branchId,
                  assistantMessageId: assistantMessageIdForCommand(commandId),
                  toolCallId: toolCallIdForCommand(commandId),
                }),
              ),
            ),
          ).toBe(true)
          yield* ref.send(payload)
          yield* control.redeliver(entityId)
          const repeated = yield* AgentLoopActor.InvokeTool.waitFor(payload)
          expect(repeated).toEqual(first)
          expect(yield* Ref.get(executions)).toBe(1)
          const recorder = yield* SequenceRecorder
          expect(eventTags(yield* recorder.getCalls)).toContain("InteractionResolved")
          const state = yield* ref.execute(
            AgentLoopActor.GetState.make({
              workspaceId: DefaultWorkspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make("direct-approval-state"),
            }),
          )
          expect(state._tag).toBe("Idle")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for the actor operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer), narrowR),
      )
    }),
  )
  it.live("InvokeTool actor command dedupes by commandId", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const sessionRuntime = yield* SessionRuntime
          const messageStorage = yield* MessageStorage
          const recorder = yield* SequenceRecorder
          const { sessionId, branchId } = yield* createSessionBranch
          const actorClientFactory = yield* AgentLoopActor.Context
          const actorControl = yield* AgentLoopActor.Control
          const entityId = entityIdOf(DefaultWorkspaceId, sessionId, branchId)
          const ref = yield* actorClientFactory(entityId)
          yield* ref.execute(
            AgentLoopActor.GetState.make({
              workspaceId: DefaultWorkspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make("invoke-tool-warm-state"),
            }),
          )
          const invokePayload = AgentLoopActor.InvokeTool.make({
            workspaceId: DefaultWorkspaceId,
            sessionId,
            branchId,
            commandId: ActorCommandId.make("invoke-tool-idempotent"),
            toolName: ToolName.make("read"),
            input: {},
          })
          yield* ref.send(invokePayload)
          yield* actorControl.redeliver(entityId)
          yield* AgentLoopActor.InvokeTool.waitFor(invokePayload).pipe(
            Effect.flatMap(materializeActorCommand),
          )
          yield* ref.send(invokePayload)
          yield* actorControl.redeliver(entityId)
          yield* AgentLoopActor.InvokeTool.waitFor(invokePayload).pipe(
            Effect.flatMap(materializeActorCommand),
          )
          const messages = yield* waitFor(
            messageStorage.listMessages(branchId),
            (current) => current.length === 2,
            5000,
            "invokeTool messages",
          )
          const queue = yield* sessionRuntime.getQueuedMessages({ sessionId, branchId })
          const calls = yield* recorder.getCalls
          expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"])
          expect(messages[0]?.parts[0]?.type).toBe("tool-call")
          expect(messages[1]?.parts[0]?.type).toBe("tool-result")
          expect(queue).toEqual({ followUp: [], steering: [] } satisfies QueueSnapshot)
          expect(eventTags(calls)).toContain("ToolCallStarted")
          expect(eventTags(calls)).toContain("ToolCallSucceeded")
          expect(eventTags(calls).filter((tag) => tag === "ToolCallStarted")).toHaveLength(1)
          expect(eventTags(calls).filter((tag) => tag === "ToolCallSucceeded")).toHaveLength(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("Interrupt reports invalid derived cancel commands through the error channel", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const { sessionId, branchId } = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("interrupt-invalid-command-session"),
            branchId: BranchId.make("interrupt-invalid-command-branch"),
          })
          const actorClientFactory = yield* AgentLoopActor.Context
          const actorControl = yield* AgentLoopActor.Control
          const entityId = entityIdOf(DefaultWorkspaceId, sessionId, branchId)
          const ref = yield* actorClientFactory(entityId)
          yield* ref.execute(
            AgentLoopActor.GetState.make({
              workspaceId: DefaultWorkspaceId,
              sessionId,
              branchId,
              commandId: ActorCommandId.make("interrupt-warm-state"),
            }),
          )
          const interruptPayload = AgentLoopActor.Interrupt.make({
            workspaceId: DefaultWorkspaceId,
            sessionId,
            branchId,
            commandId: ActorCommandId.make("x".repeat(129)),
          })
          const exit = yield* Effect.gen(function* () {
            yield* ref.send(interruptPayload)
            yield* actorControl.redeliver(entityId)
            const result = yield* AgentLoopActor.Interrupt.waitFor(interruptPayload)
            return yield* materializeActorCommand(result)
          }).pipe(Effect.exit)

          expect(exit._tag).toBe("Failure")
          if (exit._tag !== "Failure") return
          const errorOption = Cause.findErrorOption(exit.cause)
          if (errorOption._tag !== "Some") {
            return yield* Effect.die(
              new Error(`Expected interrupt failure error, got cause: ${Cause.pretty(exit.cause)}`),
            )
          }
          const error = errorOption.value
          if (!Schema.is(AgentLoopError)(error)) {
            return yield* Effect.die(new Error(`Expected AgentLoopError, got: ${String(error)}`))
          }
          expect(error.message).toBe("Invalid interrupt command")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("recordToolResult dedupes by commandId", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const layer = makeRuntimeLayer(providerLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          const recorder = yield* SequenceRecorder
          const target = yield* createSessionBranchWithIds({
            sessionId: SessionId.make("record-tool-idempotent-session"),
            branchId: BranchId.make("record-tool-idempotent-branch"),
          })
          const command = {
            commandId: ActorCommandId.make("record-tool-idempotent"),
            ...target,
            toolCallId: ToolCallId.make("tool-call-idempotent"),
            toolName: ToolName.make("read"),
            output: { ok: true },
          }
          yield* recordToolResultViaActor(command)
          yield* recordToolResultViaActor(command)
          const messages = yield* messageStorage.listMessages(target.branchId)
          const calls = yield* recorder.getCalls
          const toolMessages = messages.filter((message) => message.role === "tool")
          const state = yield* getActorState(target)
          expect(toolMessages).toHaveLength(1)
          expect(toolMessages[0]?.id).toBe(MessageId.make("record-tool-idempotent:tool-result"))
          expect(toolMessages[0]?.parts).toEqual([
            Prompt.toolResultPart({
              id: ToolCallId.make("tool-call-idempotent"),
              name: "read",
              isFailure: false,
              providerExecuted: false,
              result: { ok: true },
            }),
          ])
          expect(state).toEqual({
            _tag: "Idle",
            agent: AgentName.make("cowork"),
            queue: { followUp: [], steering: [] },
          })
          expect(eventTags(calls).filter((tag) => tag === "ToolCallSucceeded")).toHaveLength(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("4 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("recordToolResult rolls back the tool message when durable event append fails", () =>
    Effect.gen(function* () {
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
      const failingPublisherLayer = Layer.succeed(
        EventPublisher,
        EventPublisher.of({
          append: (event: AgentEvent) => {
            if (event._tag === "ToolCallSucceeded") {
              return Effect.fail(new EventStoreError({ message: "append failed" }))
            }
            return Effect.gen(function* () {
              return EventEnvelope.make({
                id: EventId.make(0),
                event,
                createdAt: yield* Clock.currentTimeMillis,
              })
            })
          },
          deliver: () => Effect.void,
          publish: () => Effect.void,
        }),
      )
      const layer = makeRuntimeLayerWithEventPublisher(providerLayer, failingPublisherLayer)
      yield* narrowR(
        Effect.gen(function* () {
          const messageStorage = yield* MessageStorage
          const { sessionId, branchId } = yield* createSessionBranch
          const commandId = ActorCommandId.make("record-tool-atomicity")
          const exit = yield* Effect.exit(
            recordToolResultViaActor({
              commandId,
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-atomicity"),
              toolName: ToolName.make("read"),
              output: { ok: true },
            }),
          )
          const message = yield* messageStorage.getMessage(
            MessageId.make(`${commandId}:tool-result`),
          )
          expect(exit._tag).toBe("Failure")
          expect(message).toBeUndefined()
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
                // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
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
          const { sessionId, branchId } = yield* createSessionBranch
          const first = {
            commandId: ActorCommandId.make("record-tool-serialize-a"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-a"),
            toolName: ToolName.make("read"),
            output: { value: "a" },
          }
          const second = {
            commandId: ActorCommandId.make("record-tool-serialize-b"),
            sessionId,
            branchId,
            toolCallId: ToolCallId.make("tool-call-serialize-b"),
            toolName: ToolName.make("read"),
            output: { value: "b" },
          }
          const firstFiber = yield* Effect.forkChild(recordToolResultViaActor(first))
          yield* Deferred.await(firstDeliveryStarted).pipe(Effect.timeout("5 seconds"))
          const secondFiber = yield* Effect.forkChild(recordToolResultViaActor(second))
          const earlySecond = yield* Fiber.join(secondFiber).pipe(Effect.timeoutOption("1 millis"))
          expect(earlySecond._tag).toBe("None")
          expect(deliveredToolResults).toBe(1)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
          yield* Deferred.succeed(releaseDelivery, undefined)
          yield* Fiber.join(firstFiber)
          yield* Fiber.join(secondFiber)
          expect(deliveredToolResults).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
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
            recordToolResultViaActor({
              commandId: ActorCommandId.make("record-tool-active-owner"),
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-active-owner"),
              toolName: ToolName.make("read"),
              output: { value: "blocked until turn completes" },
            }),
          )
          const earlyRecord = yield* Fiber.join(recordFiber).pipe(Effect.timeoutOption("1 millis"))
          const messagesBeforeRelease = yield* messageStorage.listMessages(branchId)
          expect(earlyRecord._tag).toBe("None")
          expect(messagesBeforeRelease.some((message) => message.role === "tool")).toBe(false)
          // oxlint-disable-next-line effect/noNullish -- Deferred<void> requires the void completion value.
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
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.timeout("6 seconds"), Effect.provide(layer)),
      )
    }),
  )

  it.live("TerminateBranch interrupts an active turn while tool result delivery is waiting", () =>
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
            recordToolResultViaActor({
              commandId: ActorCommandId.make("record-tool-terminate-owner"),
              sessionId,
              branchId,
              toolCallId: ToolCallId.make("tool-call-terminate-owner"),
              toolName: ToolName.make("read"),
              output: { value: "blocked until turn completes" },
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
