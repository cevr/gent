import { describe, expect, it } from "effect-bun-test"
import type { LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import {
  Cause,
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
import * as AiError from "effect/unstable/ai/AiError"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
  toolCallPart,
  type LanguageModelStreamPart,
} from "../../../src/test-utils/language-model"
import { assistantMessageIdForTurn, dateFromMillis, Message } from "../../../src/domain/message"
import { ExtensionContext, getToolId, tool, type ToolCapability } from "@gent/core/extensions/api"
import {
  AgentEvent,
  EventPublisherLive,
  EventStore,
  MessageReceived,
  ToolCallSucceeded,
} from "../../../src/domain/event"
import { InteractionPendingError } from "../../../src/domain/interaction"
import { ApprovalService } from "../../../src/runtime/extension-host"
import {
  EventStorage,
  MessageStorage,
  SqliteStorage,
  ToolCallBindingStorage,
} from "../../../src/storage/storage"
import { RecordingEventStore, SequenceRecorder } from "../../../src/test-utils"
import {
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../../src/domain/ids"
import { AgentLoopTestActor } from "../../../src/runtime/agent/agent-loop.actor"
import { AgentLoopError } from "../../../src/domain/agent-loop"
import { AgentLoopSessionGovernance } from "../../../src/runtime/agent/agent-loop.session-governance"
import { ModelRegistry } from "../../../src/runtime/model-registry"
import { GentPlatform } from "../../../src/runtime/gent-platform"
import { ConfigService, RuntimeEnvironment } from "../../../src/runtime/config"
import { noBranchTools, ToolRunner } from "../../../src/runtime/agent/tools"
import { toolResultMessageIdForTurn } from "../../../src/runtime/agent/agent-loop.utils"
import { ModelResolver } from "../../../src/providers/model-resolver"
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
      SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
      resolvedProviderLayer,
      ModelResolver.fromLanguageModel(resolvedProviderLayer),
      makeExtRegistry(tools),
      RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ConfigService.Test(),
      ApprovalService.Test(),
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
  it.live(
    "a turn interrupted after a tool call arrived leaves a transcript the next turn reads",
    () =>
      Effect.gen(function* () {
        const executed = yield* Ref.make(0)
        const toolCallArrived = yield* Deferred.make<void>()
        const echo = tool({
          id: "interrupted-echo",
          description: "Counts executions",
          params: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (params: { value: string }) =>
            Ref.update(executed, (n) => n + 1).pipe(Effect.as(params.value)),
        })
        let calls = 0
        const provider = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls > 1) {
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("after interrupt"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          }
          // The tool call arrives whole, then the stream stalls before its finish
          // part: the interrupt lands with a call the step never got to run.
          return Effect.succeed(
            Stream.make(toolCallPart("interrupted-echo", { value: "never runs" })).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(toolCallArrived, void 0)).pipe(Stream.drain),
              ),
              Stream.concat(Stream.never),
            ),
          )
        })
        const layer = makeLiveToolLayer(provider, [echo])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const first = makeIntMessage("interrupt me mid tool call")
            const running = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
            yield* Deferred.await(toolCallArrived)
            yield* steerAgentLoop({
              _tag: "Interrupt",
              sessionId: intSessionId,
              branchId: intBranchId,
              requestId: "req-interrupt-mid-tool-call",
            })
            yield* Fiber.join(running)
            expect(yield* Ref.get(executed)).toBe(0)

            const second = makeIntMessage("are you still there")
            yield* runAgentLoop(agentLoop, second)
            const reply = yield* (yield* MessageStorage).getMessage(
              assistantMessageIdForTurn(second.id, 1),
            )
            expect(reply?.parts).toEqual([Prompt.textPart({ text: "after interrupt" })])
            const unrun = yield* (yield* MessageStorage).getMessage(
              toolResultMessageIdForTurn(first.id, 1),
            )
            expect(
              unrun?.parts.map((part) => part.type === "tool-result" && part.isFailure),
            ).toEqual([true])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
        )
      }),
  )
  it.live("an interrupt stops a tool that is still running and gives its call a result", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const stuck = tool({
        id: "stuck-tool",
        description: "Never returns",
        params: Schema.Struct({}),
        output: Schema.String,
        execute: () =>
          Deferred.succeed(started, void 0).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, void 0)),
          ),
      })
      let calls = 0
      const provider = LanguageModelLayers.testStream(() => {
        calls += 1
        if (calls > 1) {
          return Effect.succeed(
            Stream.fromIterable([
              textDeltaPart("after stop"),
              finishPart({ finishReason: "stop" }),
            ]),
          )
        }
        return Effect.succeed(
          Stream.fromIterable([
            toolCallPart("stuck-tool", {}),
            finishPart({ finishReason: "tool-calls" }),
          ]),
        )
      })
      const layer = makeLiveToolLayer(provider, [stuck])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLoop = yield* makeAgentLoopService
          const first = makeIntMessage("run the stuck tool")
          const running = yield* Effect.forkChild(runAgentLoop(agentLoop, first))
          yield* Deferred.await(started)
          yield* steerAgentLoop({
            _tag: "Interrupt",
            sessionId: intSessionId,
            branchId: intBranchId,
            requestId: "req-interrupt-running-tool",
          })
          yield* Deferred.await(stopped)
          yield* Fiber.join(running)
          const result = yield* (yield* MessageStorage).getMessage(
            toolResultMessageIdForTurn(first.id, 1),
          )
          expect(result?.parts).toMatchObject([
            { type: "tool-result", isFailure: true, result: { reason: "Interrupted" } },
          ])
          expect(calls).toBe(1)
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live(
    "a stream that fails after a tool call arrived leaves a transcript the re-prompt reads",
    () =>
      Effect.gen(function* () {
        const executed = yield* Ref.make(0)
        const echo = tool({
          id: "cut-echo",
          description: "Counts executions",
          params: Schema.Struct({ value: Schema.String }),
          output: Schema.String,
          execute: (params: { value: string }) =>
            Ref.update(executed, (n) => n + 1).pipe(Effect.as(params.value)),
        })
        let calls = 0
        const provider = LanguageModelLayers.testStream(() => {
          calls += 1
          if (calls > 1) {
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("after failure"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          }
          return Effect.succeed(
            Stream.make(toolCallPart("cut-echo", { value: "never runs" })).pipe(
              Stream.concat(
                Stream.fail(
                  AiError.make({
                    module: "Test",
                    method: "streamText",
                    reason: new AiError.UnknownError({ description: "connection reset" }),
                  }),
                ),
              ),
            ),
          )
        })
        const layer = makeLiveToolLayer(provider, [echo])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const agentLoop = yield* makeAgentLoopService
            const first = makeIntMessage("the stream breaks mid tool call")
            // A stream that broke with output in hand is re-prompted inside the turn.
            yield* runAgentLoop(agentLoop, first)
            expect(yield* Ref.get(executed)).toBe(0)
            const reply = yield* (yield* MessageStorage).getMessage(
              assistantMessageIdForTurn(first.id, 2),
            )
            expect(reply?.parts).toEqual([Prompt.textPart({ text: "after failure" })])
            // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
          }).pipe(Effect.provide(layer), Effect.timeout("4 seconds")),
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
        SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
        providerLayer,
        ModelResolver.fromLanguageModel(providerLayer),
        makeExtRegistry(),
        RuntimeEnvironment.Live({ cwd: "/tmp", home: "/tmp", platform: "test" }),
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
