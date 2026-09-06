import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  Stream,
} from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "@gent/core-internal/test-utils/language-model"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { AgentName } from "@gent/core-internal/domain/agent"
import { ExtensionContext, getToolId, tool, type ToolCapability } from "@gent/core/extensions/api"
import { Permission } from "@gent/core-internal/domain/permission"
import {
  AgentEvent,
  EventStore,
  MessageReceived,
  ToolCallSucceeded,
} from "@gent/core-internal/domain/event"
import { InteractionPendingError } from "@gent/core-internal/domain/interaction-request"
import { ApprovalService } from "../../../src/runtime/approval-service"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import {
  RecordingEventStore,
  SequenceRecorder,
  ensureStorageParents,
  testExtensionHostContext,
} from "@gent/core-internal/test-utils"
import {
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopError } from "../../../src/runtime/agent/agent-loop.state"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { RuntimeEnvironment } from "../../../src/runtime/runtime-environment"
import { ConfigService } from "../../../src/runtime/config-service"
import { ToolRunner } from "../../../src/runtime/agent/tool-runner"
import { invokeTool } from "../../../src/runtime/agent/turn-tool-execution"
import {
  ProcessLocalToolReplay,
  processLocalReplayBindingKey,
} from "../../../src/runtime/agent/process-local-tool-replay"
import { ToolBindingReplayError } from "../../../src/runtime/agent/tool-binding-replay"
import { runAgentLoopTurnProfileOrLegacy } from "../../../src/runtime/agent/agent-loop.turn-profile"
import { ExtensionRegistry } from "../../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../../src/runtime/extensions/driver-registry"
import {
  assistantMessageIdForTurn,
  toolResultMessageIdForTurn,
} from "../../../src/runtime/agent/agent-loop.utils"
import { ModelResolver } from "@gent/core-internal/providers/model-resolver"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { EventStorage } from "@gent/core-internal/storage/event-storage"
import { ToolCallBindingStorage } from "@gent/core-internal/storage/tool-call-binding-storage"
import { ToolResultReplayError } from "../../../src/runtime/agent/turn-persistence"
import {
  makeAgentLoopService,
  makeExtRegistry,
  makeLiveToolLayer,
  respondAgentLoopInteraction,
  runAgentLoop,
  steerAgentLoop,
  waitForPhase,
} from "./helpers"

describe("interaction", () => {
  const intSessionId = SessionId.make("s-interaction")
  const intBranchId = BranchId.make("b-interaction")
  const makeIntMessage = (text: string) =>
    Message.cases.regular.make({
      id: MessageId.make(`msg-${text}`),
      sessionId: intSessionId,
      branchId: intBranchId,
      role: "user",
      parts: [Prompt.textPart({ text })],
      createdAt: dateFromMillis(1_767_225_600_000),
    })
  const makeInteractionTool = (callCount: Ref.Ref<number>, resolution: Deferred.Deferred<void>) =>
    tool({
      id: "interaction-tool",
      description: "Tool that triggers an interaction",
      params: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({
        resolved: Schema.Boolean,
        value: Schema.String,
      }),
      execute: (params: { value: string }) =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          const count = yield* Ref.getAndUpdate(callCount, (n) => n + 1)
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
  // Stateful provider: first model stream returns a tool call (triggers interaction),
  // subsequent model streams return text only (completes the turn).
  // Without this, the loop re-streams the same tool call 199 times until maxTurnSteps.
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
              {
                toolCallId: ToolCallId.make("tc-1"),
              },
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
  const makeInteractionRecordingLayer = (
    tools: ReadonlyArray<ToolCapability>,
    providerLayer?: Layer.Layer<LanguageModel.LanguageModel>,
  ) => {
    const resolvedProviderLayer = providerLayer ?? makeInteractionProviderLayer()
    const recorderLayer = SequenceRecorder.Live
    const eventStoreLayer = RecordingEventStore.pipe(Layer.provide(recorderLayer))
    const baseDeps = Layer.mergeAll(
      SqliteStorage.TestWithSql(),
      resolvedProviderLayer,
      ModelResolver.fromLanguageModel(resolvedProviderLayer),
      makeExtRegistry(tools),
      RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      ApprovalService.Test(),
      Permission.Live([], "allow"),
      BunServices.layer,
      ModelRegistry.Test(),
      GentPlatform.Test(),
      recorderLayer,
      eventStoreLayer,
    )
    const deps = Layer.mergeAll(baseDeps, Layer.provide(ToolRunner.Live, baseDeps))
    const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
    return AgentLoopTestActor({ baseSections: [] }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
      ),
    )
  }
  it.live("tool triggers InteractionPendingError and machine parks", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const recorder = yield* SequenceRecorder
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("trigger interaction")),
          )
          const state = yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          const calls = yield* recorder.getCalls
          const eventTags = calls
            .filter((c) => c.service === "EventStore" && c.method === "append")
            .map((c) => Schema.decodeUnknownSync(AgentEvent)(c.args)._tag)
          expect(eventTags).toContain("ToolCallStarted")
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("stale interaction response does not resume a different pending request", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeInteractionRecordingLayer([tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("stale interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-stale-1"),
          })

          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("WaitingForInteraction")
          expect(yield* Ref.get(callCount)).toBe(1)
          expect(yield* Deferred.isDone(resolution)).toBe(false)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(yield* Ref.get(callCount)).toBe(2)
          yield* Fiber.join(fiber)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("interrupt during WaitingForInteraction finalizes turn", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const layer = makeLiveToolLayer(makeInteractionProviderLayer(), [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("interrupt test")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-interrupt-waiting-interaction",
          })
          yield* Fiber.join(fiber)
          const stateAfter = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(stateAfter._tag).toBe("Idle")
          expect(yield* Ref.get(callCount)).toBe(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("respondInteraction is no-op when not in WaitingForInteraction", () =>
    Effect.gen(function* () {
      const providerLayer = LanguageModelLayers.testStream(() =>
        Effect.succeed(
          Stream.fromIterable([textDeltaPart("hello"), finishPart({ finishReason: "stop" })]),
        ),
      )
      const deps = Layer.mergeAll(
        SqliteStorage.TestWithSql(),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        makeExtRegistry(),
        RuntimeEnvironment.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
        ConfigService.Test(),
        EventStore.Memory,
        ToolRunner.Test(),
        ApprovalService.Test(),
        BunServices.layer,
        ModelRegistry.Test(),
        GentPlatform.Test(),
      )
      const eventPublisherLayer = Layer.provide(EventPublisherLive, deps)
      const loopLayer = AgentLoopTestActor({ baseSections: [] }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(deps, eventPublisherLayer, AgentLoopSessionGovernance.Live),
        ),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          yield* runAgentLoop(agentLoop, makeIntMessage("no interaction"))
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("nonexistent"),
          })
          const state = yield* agentLoop.getState({
            sessionId: intSessionId,
            branchId: intBranchId,
          })
          expect(state._tag).toBe("Idle")
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(loopLayer)),
      )
    }),
  )
  it.live("GUARD: interaction resume executes tool without new LLM call", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0)
      const resolution = yield* Deferred.make<void>()
      const tool = makeInteractionTool(callCount, resolution)
      const providerCallsRef = yield* Ref.make(0)
      let streamCallIndex = 0
      const separateCallProvider = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Ref.update(providerCallsRef, (n) => n + 1)
          const idx = streamCallIndex++
          if (idx === 0) {
            return Stream.fromIterable([
              toolCallPart(
                getToolId(tool),
                { value: "guard-test" },
                {
                  toolCallId: ToolCallId.make("tc-guard"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("interaction resolved"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeLiveToolLayer(separateCallProvider, [tool])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(
            runAgentLoop(agentLoop, makeIntMessage("guard interaction")),
          )
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          const messageStorage = yield* MessageStorage
          const bindingStorage = yield* ToolCallBindingStorage
          const assistant = yield* messageStorage.getMessage(
            assistantMessageIdForTurn(makeIntMessage("guard interaction").id),
          )
          expect(assistant).not.toBeUndefined()
          if (Predicate.isNotUndefined(assistant)) {
            const toolCall = assistant.parts.find((part) => part.type === "tool-call")
            expect(toolCall?.type).toBe("tool-call")
            if (toolCall?.type === "tool-call") {
              expect(
                yield* bindingStorage.get({
                  assistantMessageId: assistant.id,
                  toolCallId: ToolCallId.make(toolCall.id),
                  sessionId: intSessionId,
                  branchId: intBranchId,
                }),
              ).toBeUndefined()
            }
          }
          expect(Ref.getUnsafe(providerCallsRef)).toBe(1)
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-test-1"),
          })
          yield* Deferred.await(resolution).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(callCount)).toBe(2)
          expect(
            yield* bindingStorage.get({
              assistantMessageId: assistantMessageIdForTurn(makeIntMessage("guard interaction").id),
              toolCallId: ToolCallId.make("tc-guard"),
              sessionId: intSessionId,
              branchId: intBranchId,
            }),
          ).toBeUndefined()
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCallsRef)).toBe(2)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer)),
      )
    }),
  )
  it.live("resumes the latest incomplete tool step after an earlier step completed", () =>
    Effect.gen(function* () {
      const firstTool = tool({
        id: "first-tool",
        description: "Completes the first step",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            return params.value
          }),
      })
      const interactionCalls = yield* Ref.make(0)
      const interactionStarted = yield* Deferred.make<void>()
      const interactionResumed = yield* Deferred.make<void>()
      const releaseInteraction = yield* Deferred.make<void>()
      const secondTool = tool({
        id: "second-tool",
        description: "Parks on the second step",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(interactionCalls, (n) => n + 1)
            if (count === 0) {
              yield* Deferred.succeed(interactionStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-multi-step"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(interactionResumed, void 0)
            yield* Deferred.await(releaseInteraction)
            return params.value
          }),
      })
      const providerCalls = yield* Ref.make(0)
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() =>
        Effect.gen(function* () {
          yield* Ref.update(providerCalls, (n) => n + 1)
          const index = streamCallIndex++
          if (index === 0) {
            return Stream.fromIterable([
              toolCallPart(
                "first-tool",
                { value: "step-1" },
                {
                  toolCallId: ToolCallId.make("tc-step-1"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          if (index === 1) {
            return Stream.fromIterable([
              toolCallPart(
                "second-tool",
                { value: "step-2" },
                {
                  toolCallId: ToolCallId.make("tc-step-2"),
                },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[])
          }
          return Stream.fromIterable([
            textDeltaPart("multi-step complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[])
        }),
      )
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("multi-step interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(interactionStarted)
          expect(Ref.getUnsafe(providerCalls)).toBe(2)

          const messageStorage = yield* MessageStorage
          expect(
            yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 1)),
          ).not.toBeUndefined()
          expect(
            yield* messageStorage.getMessage(assistantMessageIdForTurn(message.id, 2)),
          ).not.toBeUndefined()
          expect(
            yield* messageStorage.getMessage(toolResultMessageIdForTurn(message.id, 2)),
          ).toBeUndefined()

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-multi-step"),
          })
          yield* Deferred.await(interactionResumed).pipe(Effect.timeout("5 seconds"))
          expect(Ref.getUnsafe(providerCalls)).toBe(2)
          yield* Deferred.succeed(releaseInteraction, void 0)
          yield* Fiber.join(fiber)
          expect(Ref.getUnsafe(providerCalls)).toBe(3)
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("reuses a completed sibling tool after another sibling parks", () =>
    Effect.gen(function* () {
      const firstCalls = yield* Ref.make(0)
      const secondCalls = yield* Ref.make(0)
      const secondStarted = yield* Deferred.make<void>()
      const secondResumed = yield* Deferred.make<void>()
      const firstTool = tool({
        id: "sibling-first-tool",
        description: "Completes before the sibling parks",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            yield* Ref.update(firstCalls, (count) => count + 1)
            return { value: params.value }
          }),
      })
      const secondTool = tool({
        id: "sibling-second-tool",
        description: "Parks once before completing",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(secondCalls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(secondStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-sibling-tools"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(secondResumed, void 0)
            return params.value
          }),
      })
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() => {
        const index = streamCallIndex++
        if (index === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              toolCallPart(
                getToolId(secondTool),
                { value: "second" },
                { toolCallId: ToolCallId.make("tc-sibling-second") },
              ),
              toolCallPart(
                getToolId(firstTool),
                { value: "first" },
                { toolCallId: ToolCallId.make("tc-sibling-first") },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("siblings complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("sibling interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(secondStarted)
          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(1)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-sibling-tools"),
          })
          yield* Deferred.await(secondResumed).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(fiber)

          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(2)
          const messageStorage = yield* MessageStorage
          const result = yield* messageStorage.getMessage(toolResultMessageIdForTurn(message.id, 1))
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            expect(result.parts).toHaveLength(2)
            expect(result.parts.map((part) => part.type === "tool-result" && part.id)).toEqual([
              "tc-sibling-second",
              "tc-sibling-first",
            ])
            const firstResult = result.parts.find(
              (part) => part.type === "tool-result" && part.id === "tc-sibling-first",
            )
            expect(Predicate.isUndefined(firstResult)).toBe(false)
            if (Predicate.isNotUndefined(firstResult)) {
              expect(firstResult.type).toBe("tool-result")
              if (firstResult.type === "tool-result") {
                expect(firstResult.result).toEqual({ value: "first" })
              }
            }
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("reuses a completed sibling declared before the pending sibling", () =>
    Effect.gen(function* () {
      const firstCalls = yield* Ref.make(0)
      const secondCalls = yield* Ref.make(0)
      const secondStarted = yield* Deferred.make<void>()
      const secondResumed = yield* Deferred.make<void>()
      const firstTool = tool({
        id: "sibling-reverse-first",
        description: "Completes before the pending sibling",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            yield* ExtensionContext
            yield* Ref.update(firstCalls, (count) => count + 1)
            return { value: params.value }
          }),
      })
      const secondTool = tool({
        id: "sibling-reverse-second",
        description: "Parks after the completed sibling",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: (params: { value: string }) =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(secondCalls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(secondStarted, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-sibling-reverse"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            yield* Deferred.succeed(secondResumed, void 0)
            return params.value
          }),
      })
      let streamCallIndex = 0
      const provider = LanguageModelLayers.testStream(() => {
        const index = streamCallIndex++
        if (index === 0) {
          return Effect.succeed(
            Stream.fromIterable([
              toolCallPart(
                getToolId(firstTool),
                { value: "first-reverse" },
                { toolCallId: ToolCallId.make("tc-sibling-reverse-first") },
              ),
              toolCallPart(
                getToolId(secondTool),
                { value: "second-reverse" },
                { toolCallId: ToolCallId.make("tc-sibling-reverse-second") },
              ),
              finishPart({ finishReason: "tool-calls" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            textDeltaPart("reverse siblings complete"),
            finishPart({ finishReason: "stop" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [firstTool, secondTool])
      const message = makeIntMessage("reverse sibling interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(secondStarted)
          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(1)

          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-sibling-reverse"),
          })
          yield* Deferred.await(secondResumed).pipe(Effect.timeout("1 second"))
          yield* Fiber.join(fiber)

          expect(Ref.getUnsafe(firstCalls)).toBe(1)
          expect(Ref.getUnsafe(secondCalls)).toBe(2)
          const result = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(toolResultMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            const firstResult = result.parts.find(
              (part) => part.type === "tool-result" && part.id === "tc-sibling-reverse-first",
            )
            expect(firstResult?.type).toBe("tool-result")
            if (firstResult?.type === "tool-result") {
              expect(firstResult.result).toEqual({ value: "first-reverse" })
            }
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  it.live("does not rerun a tool when its persisted structured result is corrupt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const corruptTool = tool({
        id: "corrupt-result-tool",
        description: "Parks before a corrupt persisted result is supplied",
        params: Schema.Struct({ value: Schema.String }),
        output: Schema.String,
        execute: () =>
          Effect.gen(function* () {
            const ctx = yield* ExtensionContext
            const count = yield* Ref.getAndUpdate(calls, (value) => value + 1)
            if (count === 0) {
              yield* Deferred.succeed(started, void 0)
              return yield* new InteractionPendingError({
                requestId: InteractionRequestId.make("req-corrupt-result"),
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
              })
            }
            return "must not run"
          }),
      })
      let providerCalls = 0
      const provider = LanguageModelLayers.testStream(() => {
        const call = providerCalls++
        if (call > 0) {
          return Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("next turn works"),
              finishPart({ finishReason: "stop" }),
            ] satisfies LanguageModelStreamPart[]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart(
              getToolId(corruptTool),
              { value: "corrupt" },
              { toolCallId: ToolCallId.make("tc-corrupt-result") },
            ),
            finishPart({ finishReason: "tool-calls" }),
          ] satisfies LanguageModelStreamPart[]),
        )
      })
      const layer = makeLiveToolLayer(provider, [corruptTool])
      const message = makeIntMessage("corrupt result interaction")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const fiber = yield* Effect.forkChild(runAgentLoop(agentLoop, message))
          yield* waitForPhase(
            agentLoop,
            { sessionId: intSessionId, branchId: intBranchId },
            "WaitingForInteraction",
          )
          yield* Deferred.await(started)
          const assistant = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(assistantMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(assistant).not.toBeUndefined()
          if (Predicate.isUndefined(assistant)) return
          const eventStorage = yield* EventStorage
          yield* eventStorage.appendEvent(MessageReceived.make({ message: assistant }))
          yield* eventStorage.appendEvent(
            ToolCallSucceeded.make({
              sessionId: intSessionId,
              branchId: intBranchId,
              toolCallId: ToolCallId.make("tc-corrupt-result"),
              toolName: getToolId(corruptTool),
              output: "display value is not authoritative",
              resultJson: "{invalid-json",
            }),
          )
          yield* respondAgentLoopInteraction({
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: InteractionRequestId.make("req-corrupt-result"),
          })
          const outcome = yield* Fiber.await(fiber)
          expect(outcome._tag).toBe("Failure")
          if (Exit.isFailure(outcome)) {
            const failure = Cause.findErrorOption(outcome.cause)
            expect(Option.isSome(failure)).toBe(true)
            if (Option.isSome(failure)) {
              expect(Schema.is(AgentLoopError)(failure.value)).toBe(true)
              if (Schema.is(AgentLoopError)(failure.value)) {
                expect(Schema.is(ToolResultReplayError)(failure.value.cause)).toBe(true)
              }
            }
          }
          expect(Ref.getUnsafe(calls)).toBe(1)
          const result = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(toolResultMessageIdForTurn(message.id, 1)),
            ),
          )
          expect(result).not.toBeUndefined()
          if (Predicate.isNotUndefined(result)) {
            expect(result.parts).toHaveLength(1)
            const part = result.parts[0]
            expect(part?.type).toBe("tool-result")
            if (part?.type === "tool-result") {
              expect(part.id).toBe("tc-corrupt-result")
              expect(part.isFailure).toBe(true)
            }
          }
          yield* runAgentLoop(agentLoop, makeIntMessage("after corrupt result"))
          const nextAssistant = yield* MessageStorage.pipe(
            Effect.flatMap((storage) =>
              storage.getMessage(
                assistantMessageIdForTurn(makeIntMessage("after corrupt result").id, 1),
              ),
            ),
          )
          expect(nextAssistant).not.toBeUndefined()
          if (Predicate.isNotUndefined(nextAssistant)) {
            expect(nextAssistant.parts).toContainEqual(Prompt.textPart({ text: "next turn works" }))
          }
        })
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          .pipe(Effect.provide(layer))
          .pipe(Effect.timeout("2 seconds")),
      )
    }),
  )
  for (const outcome of ["resume", "failure", "cancel"]) {
    it.live(`direct source invocation retains pending identity and clears it on ${outcome}`, () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const started = yield* Deferred.make<void>()
        const resuming = yield* Deferred.make<void>()
        const directTool = tool({
          id: "direct-source-replay-tool",
          description: "Parks once for a direct invocation",
          params: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (params: { value: string }) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              const count = yield* Ref.getAndUpdate(calls, (value) => value + 1)
              if (count === 0) {
                yield* Deferred.succeed(started, void 0)
                return yield* new InteractionPendingError({
                  requestId: InteractionRequestId.make("req-direct-source-replay"),
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                })
              }
              if (outcome === "cancel") {
                yield* Deferred.succeed(resuming, void 0)
                return yield* Effect.never
              }
              return params.value
            }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const layer = Layer.mergeAll(
          makeLiveToolLayer(providerLayer, [directTool]),
          ProcessLocalToolReplay.Live,
        )
        const messageId = MessageId.make("direct-source-replay-message")
        const toolResultMessageId = MessageId.make("direct-source-replay-result")
        const toolCallId = ToolCallId.make("direct-source-replay-call")
        const params = {
          assistantMessageId: messageId,
          toolResultMessageId,
          toolCallId,
          toolName: getToolId(directTool),
          input: { value: "direct" },
          sessionId: intSessionId,
          branchId: intBranchId,
          currentTurnAgent: AgentName.make("cowork"),
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* ensureStorageParents({ sessionId: intSessionId, branchId: intBranchId })
            const extensionRegistry = yield* ExtensionRegistry
            const driverRegistry = yield* DriverRegistry
            const permission = yield* Permission
            const turnProfile = {
              turnExtensionRegistry: extensionRegistry,
              turnDriverRegistry: driverRegistry,
              turnPermission: permission,
              turnBaseSections: [],
              turnHostCtx: testExtensionHostContext({
                sessionId: intSessionId,
                branchId: intBranchId,
                agentName: AgentName.make("cowork"),
              }),
            }
            const invoke = (profile = turnProfile) =>
              runAgentLoopTurnProfileOrLegacy(profile)(
                invokeTool({
                  ...params,
                  turnProfile: profile,
                }),
              )

            const first = yield* Effect.exit(invoke())
            expect(first._tag).toBe("Failure")
            yield* Deferred.await(started)
            const replay = yield* ProcessLocalToolReplay
            const key = processLocalReplayBindingKey(params)
            expect(Option.isSome(yield* replay.getBinding(key))).toBe(true)
            if (outcome === "failure") {
              const replacement = tool({
                id: getToolId(directTool),
                description: "A different source closure",
                params: Schema.Struct({ value: Schema.String }),
                output: Schema.String,
                execute: () => Effect.die("Replacement must not execute"),
              })
              const context = yield* Layer.build(makeExtRegistry([replacement]))
              const failed = yield* Effect.exit(
                invoke({
                  ...turnProfile,
                  turnExtensionRegistry: Context.get(context, ExtensionRegistry),
                }),
              )
              expect(failed._tag).toBe("Failure")
              if (Exit.isFailure(failed)) {
                expect(Schema.is(ToolBindingReplayError)(Cause.squash(failed.cause))).toBe(true)
              }
              expect(yield* Ref.get(calls)).toBe(1)
            } else if (outcome === "cancel") {
              const fiber = yield* Effect.forkChild(invoke())
              yield* Deferred.await(resuming)
              yield* Fiber.interrupt(fiber)
              expect(yield* Ref.get(calls)).toBe(2)
            } else {
              const second = yield* invoke()
              expect(second).toBeUndefined()
              expect(yield* Ref.get(calls)).toBe(2)
            }
            expect(Option.isNone(yield* replay.getBinding(key))).toBe(true)
            const messages = yield* MessageStorage
            const assistant = yield* messages.getMessage(messageId)
            const result = yield* messages.getMessage(toolResultMessageId)
            expect(assistant).not.toBeUndefined()
            expect(result).not.toBeUndefined()
            if (Predicate.isNotUndefined(result)) {
              if (outcome !== "resume") {
                expect(result.parts[0]).toMatchObject({
                  type: "tool-result",
                  id: toolCallId,
                  name: getToolId(directTool),
                  isFailure: true,
                })
                const count = yield* Ref.get(calls)
                yield* invoke()
                expect(yield* Ref.get(calls)).toBe(count)
                return
              }
              expect(result.parts[0]).toEqual(
                Prompt.toolResultPart({
                  id: toolCallId,
                  name: getToolId(directTool),
                  isFailure: false,
                  providerExecuted: false,
                  result: "direct",
                }),
              )
            }
          })
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
            .pipe(Effect.provide(layer))
            .pipe(Effect.timeout("2 seconds")),
        )
      }),
    )
  }
})
// ============================================================================
// Durable suspension + queue drain regression
// ============================================================================
//
// Verifies the queue-drain behavior justified by the phase-tagged runtime:
// while a turn is `Running`, multiple `submit` calls enqueue and drain in
// submission order after `TurnDone`.
//
// Cites: `make-impossible-states-unrepresentable` (phase-tag invariants),
//        `redesign-from-first-principles` (the current runtime carries the
//        same correctness load as the FSM did).
